import {
  clampQuad,
  fullFrameQuad,
  interiorAngles,
  isConvex,
  orderCorners,
  outputSize,
  polygonArea,
  refineQuadWithEdges,
  fitLine,
  intersectLines,
  type Line,
  resolveRatio,
  scaleQuad,
  type AspectChoice,
  type AspectEstimate,
  type Point,
  type Quad,
} from '../geometry';
import { alignExtra, fuseShots } from './glare';
import { scoped, type CV, type Mat, type MatScope } from './loadCv';

export type Mode = 'auto' | 'color' | 'gray' | 'bw' | 'photo';
export type ResolvedMode = Exclude<Mode, 'auto'>;

const now = () => performance.now();
const odd = (n: number) => (Math.round(n) % 2 === 0 ? Math.round(n) + 1 : Math.round(n));

// ---------------------------------------------------------------------------
// S2 · Document boundary detection

export interface DetectResult {
  /** Corners in source-image pixels, TL, TR, BR, BL. */
  quad: Quad;
  /** false => no convincing document edge. */
  found: boolean;
  /**
   * When not found: true if `quad` is a low-confidence best guess (shown for
   * the user to confirm), false if it is just the full frame.
   */
  guess: boolean;
  /** 0..1, share of the quad outline backed by image edges. */
  edgeSupport: number;
  /** Weakest inside-vs-outside colour difference along a side (0..~255). */
  contrast: number;
  method: string;
  candidates: number;
  ms: number;
}

const DETECT_LONG_SIDE = 1000;

export function detectQuad(cv: CV, rgba: Mat): DetectResult {
  return scoped((s) => {
    const t0 = now();
    const W = rgba.cols;
    const H = rgba.rows;
    const scale = Math.min(1, DETECT_LONG_SIDE / Math.max(W, H));
    const small = s.add(new cv.Mat());
    cv.resize(rgba, small, new cv.Size(Math.round(W * scale), Math.round(H * scale)), 0, 0, cv.INTER_AREA);
    const w = small.cols;
    const h = small.rows;

    const gray = s.add(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const blur = s.add(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    // Edge map used both for candidates and to score how well a quad sits on real edges.
    const edgesLo = s.add(new cv.Mat());
    cv.Canny(blur, edgesLo, 20, 60);
    const k3 = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const support = s.add(new cv.Mat());
    cv.dilate(edgesLo, support, k3);

    const candidates: { quad: Quad; method: string }[] = [];
    const collect = (bin: Mat, retr: number, method: string) => {
      const contours = s.add(new cv.MatVector());
      const hier = s.add(new cv.Mat());
      cv.findContours(bin, contours, hier, retr, cv.CHAIN_APPROX_SIMPLE);
      const hulls: { hull: Mat; area: number }[] = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = s.add(contours.get(i));
        const hull = s.add(new cv.Mat());
        cv.convexHull(c, hull, false, true);
        const area = cv.contourArea(hull);
        if (area >= 0.08 * w * h) hulls.push({ hull, area });
      }
      hulls.sort((a, b) => b.area - a.area);
      for (const { hull } of hulls.slice(0, 8)) {
        const q = approxQuad(cv, s, hull);
        if (q) candidates.push({ quad: q, method });
      }
    };

    // A: low-threshold edges, closed so broken borders connect.
    const closedLo = s.add(new cv.Mat());
    const k5 = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    cv.morphologyEx(edgesLo, closedLo, cv.MORPH_CLOSE, k5);
    collect(closedLo, cv.RETR_LIST, 'edges-low');

    // B: stronger edges only (busy backgrounds).
    const edgesHi = s.add(new cv.Mat());
    cv.Canny(blur, edgesHi, 50, 150);
    cv.dilate(edgesHi, edgesHi, k3);
    collect(edgesHi, cv.RETR_LIST, 'edges-high');

    // C: brightness segmentation (paper brighter than the table).
    const bin = s.add(new cv.Mat());
    cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const k9 = s.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k9);
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k9);
    collect(bin, cv.RETR_EXTERNAL, 'otsu');

    // Text-free edges: a closing wipes out dark strokes (text, staff lines,
    // title bars) while the paper/table boundary survives.
    const clean = s.add(new cv.Mat());
    const k15 = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15)));
    cv.morphologyEx(blur, clean, cv.MORPH_CLOSE, k15);
    const edgesClean = s.add(new cv.Mat());
    cv.Canny(clean, edgesClean, 15, 45);

    // D: long straight lines (robust when table texture touches the page edge).
    for (const q of lineQuads(cv, s, edgesClean, w, h)) candidates.push({ quad: q, method: 'lines' });

    // E: contours of the text-free edges.
    const cleanDil = s.add(new cv.Mat());
    cv.dilate(edgesClean, cleanDil, k3);
    collect(cleanDil, cv.RETR_LIST, 'edges-clean');

    const colorBlur = s.add(new cv.Mat());
    cv.GaussianBlur(small, colorBlur, new cv.Size(5, 5), 0);

    type Best = { quad: Quad; method: string; score: number; support: number; contrast: number; borderSides: number };
    let best = null as Best | null;
    let strong = null as Best | null;
    for (const c of candidates) {
      const a = polygonArea(c.quad) / (w * h);
      if (a < 0.08 || a > 0.995) continue;
      if (!isConvex(c.quad)) continue;
      if (interiorAngles(c.quad).some((x) => x < 40 || x > 140)) continue;
      // A page may run off the photo on up to two sides; beyond that the
      // "quad" is mostly the frame itself and says nothing about the page.
      const borderSides = [0, 1, 2, 3].filter((i) => onBorder(c.quad[i], c.quad[(i + 1) % 4], w, h)).length;
      if (borderSides > 2) continue;
      const sup = edgeSupport(support, c.quad);
      const { contrast: con } = sideContrast(colorBlur, c.quad);
      const score =
        0.5 * sup +
        0.2 * Math.sqrt(a) +
        0.3 * Math.min(1, con / 12) -
        0.12 * borderSides;
      // Strong candidates (clear edge + clear colour change on every side)
      // compete on size: the page is the outermost such shape; text lines
      // and table patterns form smaller or weaker ones.
      // Frame-border sides get edge support for free, so such shapes must
      // show far stronger evidence before they may win on size.
      const isStrong = borderSides === 0 ? sup >= 0.8 && con >= 8 : sup >= 0.95 && con >= 12;
      if (isStrong) {
        const sScore = Math.sqrt(a) - 0.25 * borderSides + 0.1 * sup;
        if (!strong || sScore > strong.score) strong = { ...c, score: sScore, support: sup, contrast: con, borderSides };
      }
      if (!best || score > best.score) best = { ...c, score, support: sup, contrast: con, borderSides };
    }

    if (strong) best = strong;
    const ms = () => now() - t0;
    // Using the photo frame as a side is a weaker claim: ask for more evidence.
    const confident =
      !!best &&
      (best.borderSides === 0
        ? best.support >= 0.45 && best.contrast >= 5
        : best.support >= 0.9 && best.contrast >= 12);
    const guess = !confident && !!best && best.support >= 0.25 && best.contrast >= 4;
    if (!best || (!confident && !guess)) {
      return {
        quad: fullFrameQuad(W, H),
        found: false,
        guess: false,
        edgeSupport: best?.support ?? 0,
        contrast: Math.round(best?.contrast ?? 0),
        method: 'none',
        candidates: candidates.length,
        ms: ms(),
      };
    }

    // Sub-pixel-ish refinement: fit lines to edge pixels along each side.
    const pts = edgePoints(edgesLo);
    const diag = Math.hypot(w, h);
    const refined = refineQuadWithEdges(best.quad, pts, 4, 0.012 * diag);
    // Pull corners ~1.5 px (detection scale) inward so no sliver of table
    // survives along the page edge.
    const inset = insetQuad(refined, 1.5);
    const quad = clampQuad(scaleQuad(inset, 1 / scale), W, H);
    return {
      quad,
      found: confident,
      guess,
      edgeSupport: best.support,
      contrast: Math.round(best.contrast),
      method: best.method,
      candidates: candidates.length,
      ms: ms(),
    };
  });
}

/** True when a segment lies along the image border (page cut off by the frame). */
function onBorder(a: Point, b: Point, w: number, h: number, tol = 3): boolean {
  return (
    (a.x <= tol && b.x <= tol) ||
    (a.y <= tol && b.y <= tol) ||
    (a.x >= w - 1 - tol && b.x >= w - 1 - tol) ||
    (a.y >= h - 1 - tol && b.y >= h - 1 - tol)
  );
}

/**
 * Smallest colour difference between just-inside and just-outside the quad,
 * over its sides (sides on the frame border are skipped). Lines in the
 * table texture have the same colour on both sides; a paper edge does not.
 * Contrast is 0 unless at least two real sides could be measured.
 */
function sideContrast(rgbaBlur: Mat, q: Quad): { contrast: number; sides: number } {
  const w = rgbaBlur.cols;
  const h = rgbaBlur.rows;
  const d: Uint8Array = rgbaBlur.data;
  const off = Math.max(3, 0.006 * Math.hypot(w, h));
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  let min = Infinity;
  let sides = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    if (onBorder(a, b, w, h)) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let nx = -(b.y - a.y) / len;
    let ny = (b.x - a.x) / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (nx * (cx - mx) + ny * (cy - my) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const inS = [0, 0, 0];
    const outS = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < 32; k++) {
      const t = 0.1 + (0.8 * k) / 31;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const ix = Math.round(px + nx * off);
      const iy = Math.round(py + ny * off);
      const ox = Math.round(px - nx * off);
      const oy = Math.round(py - ny * off);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
      const ii = (iy * w + ix) * 4;
      const oi = (oy * w + ox) * 4;
      for (let c = 0; c < 3; c++) {
        inS[c] += d[ii + c];
        outS[c] += d[oi + c];
      }
      n++;
    }
    if (n < 8) continue;
    const diff = Math.hypot((inS[0] - outS[0]) / n, (inS[1] - outS[1]) / n, (inS[2] - outS[2]) / n);
    min = Math.min(min, diff);
    sides++;
  }
  return { contrast: sides >= 2 && Number.isFinite(min) ? min : 0, sides };
}

/**
 * Quads assembled from long straight edges (probabilistic Hough). Collinear
 * segments are merged; the frame borders are added as optional sides for
 * pages that run off the photo. Pairs of roughly parallel lines are combined
 * with a second, crossing pair.
 */
function lineQuads(cv: CV, s: MatScope, edges: Mat, w: number, h: number): Quad[] {
  const minDim = Math.min(w, h);
  const raw = s.add(new cv.Mat());
  cv.HoughLinesP(edges, raw, 1, Math.PI / 180, 50, minDim * 0.12, 8);
  const seg: Int32Array = raw.data32S;

  interface Cluster {
    theta: number; // normal angle [0, π)
    rho: number;
    len: number;
    pts: Point[];
  }
  const segs: { a: Point; b: Point; len: number }[] = [];
  for (let i = 0; i + 3 < seg.length; i += 4) {
    const a = { x: seg[i], y: seg[i + 1] };
    const b = { x: seg[i + 2], y: seg[i + 3] };
    segs.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  segs.sort((p, q) => q.len - p.len);
  const clusters: Cluster[] = [];
  for (const sg of segs.slice(0, 200)) {
    let theta = Math.atan2(sg.b.x - sg.a.x, -(sg.b.y - sg.a.y)); // normal direction
    if (theta < 0) theta += Math.PI;
    if (theta >= Math.PI) theta -= Math.PI;
    const rho = sg.a.x * Math.cos(theta) + sg.a.y * Math.sin(theta);
    const hit = clusters.find((c) => {
      let dt = Math.abs(c.theta - theta);
      let dr = Math.abs(c.rho - rho);
      if (dt > Math.PI / 2) {
        dt = Math.PI - dt;
        dr = Math.abs(c.rho + rho);
      }
      return dt < (2.5 * Math.PI) / 180 && dr < 6;
    });
    if (hit) {
      hit.len += sg.len;
      hit.pts.push(sg.a, sg.b);
    } else {
      clusters.push({ theta, rho, len: sg.len, pts: [sg.a, sg.b] });
    }
  }
  clusters.sort((p, q) => q.len - p.len);

  const lines: Line[] = [];
  for (const c of clusters.slice(0, 22)) {
    const l = fitLine(c.pts);
    if (l) lines.push(l);
  }
  lines.push(
    { px: 0, py: 0, dx: 1, dy: 0 },
    { px: 0, py: h - 1, dx: 1, dy: 0 },
    { px: 0, py: 0, dx: 0, dy: 1 },
    { px: w - 1, py: 0, dx: 0, dy: 1 },
  );

  const angle = (l: Line) => {
    let a = Math.atan2(l.dy, l.dx);
    if (a < 0) a += Math.PI;
    if (a >= Math.PI) a -= Math.PI;
    return a;
  };
  const angDiff = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, Math.PI - d);
  };
  const lineDist = (l: Line, p: Point) => Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx);

  const pairs: { i: number; j: number; ang: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const ai = angle(lines[i]);
      const aj = angle(lines[j]);
      if (angDiff(ai, aj) > (35 * Math.PI) / 180) continue;
      if (lineDist(lines[i], { x: lines[j].px, y: lines[j].py }) < 0.15 * minDim) continue;
      pairs.push({ i, j, ang: ai });
    }
  }

  const out: Quad[] = [];
  const margin = 0.02 * Math.max(w, h);
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const A = pairs[p];
      const B = pairs[q];
      if (angDiff(A.ang, B.ang) < (50 * Math.PI) / 180) continue;
      if (A.i === B.i || A.i === B.j || A.j === B.i || A.j === B.j) continue;
      const pts = [
        intersectLines(lines[A.i], lines[B.i]),
        intersectLines(lines[A.i], lines[B.j]),
        intersectLines(lines[A.j], lines[B.i]),
        intersectLines(lines[A.j], lines[B.j]),
      ];
      if (pts.some((pt) => !pt || pt.x < -margin || pt.y < -margin || pt.x > w - 1 + margin || pt.y > h - 1 + margin)) continue;
      out.push(clampQuad(orderCorners(pts as Point[]), w, h));
    }
  }
  return out;
}

function insetQuad(q: Quad, px: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    const k = (Math.SQRT2 * px) / d;
    return { x: p.x + (cx - p.x) * k, y: p.y + (cy - p.y) * k };
  }) as Quad;
}

function approxQuad(cv: CV, s: MatScope, hull: Mat): Quad | null {
  const peri = cv.arcLength(hull, true);
  for (const eps of [0.01, 0.02, 0.03, 0.045, 0.06, 0.08]) {
    const approx = s.add(new cv.Mat());
    cv.approxPolyDP(hull, approx, eps * peri, true);
    if (approx.rows === 4) {
      const d = approx.data32S;
      return orderCorners([
        { x: d[0], y: d[1] },
        { x: d[2], y: d[3] },
        { x: d[4], y: d[5] },
        { x: d[6], y: d[7] },
      ]);
    }
    if (approx.rows < 4) return null;
  }
  return null;
}

function edgeSupport(map: Mat, q: Quad, samplesPerSide = 60): number {
  const w = map.cols;
  const h = map.rows;
  const data: Uint8Array = map.data;
  let hit = 0;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    for (let k = 0; k < samplesPerSide; k++) {
      const t = 0.05 + (0.9 * k) / (samplesPerSide - 1);
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      total++;
      // A side lying on the frame border (page continues outside the photo)
      // has no visible edge; count it as supported.
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) hit++;
      else if (data[y * w + x]) hit++;
    }
  }
  return hit / total;
}

function edgePoints(edges: Mat): Point[] {
  const w = edges.cols;
  const data: Uint8Array = edges.data;
  const pts: Point[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i]) pts.push({ x: i % w, y: (i / w) | 0 });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// S4–S7 · Warp, illumination, finishing

export interface ProcessOptions {
  mode: Mode;
  aspect: AspectChoice;
  /** Cap for the long side of the output page (px). */
  maxLong?: number;
  /** Reflection detection sensitivity 0..100 (default 50); see glareParams. */
  glareSensitivity?: number;
  /** Return a map of where extra shots were used (fusion.mask). */
  withGlareMask?: boolean;
}

export interface ProcessResult {
  /** RGBA 8UC4 — caller must delete(). */
  out: Mat;
  mode: ResolvedMode;
  aspect: AspectEstimate;
  width: number;
  height: number;
  /** Share of the page that is clipped white (glare / over-exposure). */
  saturatedFrac: number;
  classify: Classification;
  /** Present when extra shots were fused to remove reflections. */
  fusion?: {
    shots: number;
    /** Per extra shot: fine alignment succeeded (else corner alignment only). */
    aligned: boolean[];
    /** Share of the page taken from the extra shots. */
    replacedFrac: number;
    /** 8UC1 share taken from extra shots, page aspect, low-res — caller deletes. */
    mask?: Mat;
  };
  timings: Record<string, number>;
}

/** Another photo of the same page (for reflection removal). */
export interface ExtraShot {
  rgba: Mat;
  quad: Quad;
  /** Identifies this photo version for `AlignCache` (omit to never cache). */
  id?: string;
}

/**
 * Aligned extra shots from earlier calls, keyed by photo, corners and page
 * size. Aligning is the slow part of fusion; when only the mode or the
 * reflection sensitivity changes, it can be reused. The cache owns its Mats.
 */
export type AlignCache = Map<string, { aligned: Mat; ok: boolean }>;

export interface Classification {
  /** How much the estimated paper background varies beyond smooth lighting. */
  bgRoughness: number;
  /** Hasler–Süsstrunk colourfulness of the flattened page. */
  colorfulness: number;
  suggested: ResolvedMode;
}

export function processPage(cv: CV, rgba: Mat, quad: Quad, opts: ProcessOptions, extras: ExtraShot[] = [], alignCache?: AlignCache): ProcessResult {
  const timings: Record<string, number> = {};
  const lap = (name: string, t: number) => (timings[name] = Math.round((now() - t) * 10) / 10);

  return scoped((s) => {
    let t = now();
    const aspect = resolveRatio(opts.aspect, quad, rgba.cols, rgba.rows);
    const size = outputSize(quad, aspect.ratio, opts.maxLong ?? 4000);
    const warpedRgba = s.add(warpQuad(cv, rgba, quad, size.width, size.height));
    let rgb = s.add(new cv.Mat());
    cv.cvtColor(warpedRgba, rgb, cv.COLOR_RGBA2RGB);
    warpedRgba.delete();
    lap('warp', t);

    // S6 · Fuse extra shots (each flattened to the same page size, then
    // finely aligned to the main shot) to remove reflections.
    let fusion: ProcessResult['fusion'];
    if (extras.length) {
      t = now();
      const shots: Mat[] = [rgb];
      const aligned: boolean[] = [];
      const owned: Mat[] = [];
      for (const ex of extras) {
        const key = ex.id && alignCache ? `${ex.id}|${ex.quad.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(';')}|${size.width}x${size.height}` : null;
        const hit = key ? alignCache!.get(key) : undefined;
        if (hit) {
          shots.push(hit.aligned);
          aligned.push(hit.ok);
          continue;
        }
        const a = alignExtra(cv, rgb, ex.rgba, ex.quad);
        const ok = a.ok || a.method === 'flow';
        shots.push(a.aligned);
        aligned.push(ok);
        if (key) alignCache!.set(key, { aligned: a.aligned, ok });
        else owned.push(a.aligned);
      }
      const f = fuseShots(cv, shots, { sensitivity: opts.glareSensitivity, withMask: opts.withGlareMask });
      owned.forEach((m) => m.delete());
      rgb.delete();
      rgb = s.add(f.fused);
      fusion = { shots: shots.length, aligned, replacedFrac: f.replacedFrac, mask: f.mask };
      lap('fuse', t);
    }

    t = now();
    const small = s.add(resizeLong(cv, rgb, 600));
    const saturatedFrac = saturated(cv, s, small);
    const classify = classifyPage(cv, s, small);
    const mode: ResolvedMode = opts.mode === 'auto' ? classify.suggested : opts.mode;
    lap('analyze', t);

    let result: Mat;
    if (mode === 'photo') {
      t = now();
      result = s.add(enhancePhoto(cv, s, rgb));
      lap('finish', t);
    } else {
      t = now();
      const flat = s.add(flattenIllumination(cv, s, rgb));
      lap('flatten', t);
      t = now();
      result = s.add(finishDocument(cv, s, flat, mode));
      lap('finish', t);
    }

    t = now();
    const out = new cv.Mat();
    cv.cvtColor(result, out, result.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    lap('toRGBA', t);

    return {
      out,
      mode,
      aspect,
      width: size.width,
      height: size.height,
      saturatedFrac,
      classify,
      fusion,
      timings,
    };
  });
}

/** S4 · Perspective warp of quad → width×height (returns new Mat, same type as src). */
export function warpQuad(cv: CV, src: Mat, q: Quad, width: number, height: number): Mat {
  return scoped((s) => {
    const from = s.add(
      cv.matFromArray(4, 1, cv.CV_32FC2, [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]),
    );
    const to = s.add(
      cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]),
    );
    const M = s.add(cv.getPerspectiveTransform(from, to));
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return dst;
  });
}

export function resizeLong(cv: CV, src: Mat, maxLong: number): Mat {
  const f = Math.min(1, maxLong / Math.max(src.cols, src.rows));
  const dst = new cv.Mat();
  cv.resize(
    src,
    dst,
    new cv.Size(Math.max(1, Math.round(src.cols * f)), Math.max(1, Math.round(src.rows * f))),
    0,
    0,
    cv.INTER_AREA,
  );
  return dst;
}

/**
 * Paper background (lighting field) estimate: dark strokes thinner than the
 * kernel are removed by a closing, then the field is smoothed at very low
 * resolution (it only holds lighting) and scaled back to `outW×outH`
 * (defaults to the source size). Cost is independent of the page size.
 * A rectangular kernel is used because it is ~15× faster than an ellipse in
 * OpenCV.js (separable) and the result is smoothed anyway.
 */
export function estimateBackground(cv: CV, src: Mat, outW = src.cols, outH = src.rows): Mat {
  return scoped((s) => {
    const small = s.add(resizeLong(cv, src, 512));
    const k = Math.max(9, odd(Math.max(small.cols, small.rows) / 24));
    const kernel = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
    const closed = s.add(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    cv.medianBlur(closed, closed, 5);
    const tiny = s.add(resizeLong(cv, closed, 128));
    const f = tiny.cols / closed.cols;
    cv.GaussianBlur(tiny, tiny, new cv.Size(0, 0), Math.max(1, (k / 3) * f));
    const bg = new cv.Mat();
    cv.resize(tiny, bg, new cv.Size(outW, outH), 0, 0, cv.INTER_LINEAR);
    return bg;
  });
}

/** S5 · Divides each channel by its background → even, white paper. */
export function flattenIllumination(cv: CV, s: MatScope, rgb: Mat): Mat {
  const bg = s.add(estimateBackground(cv, rgb));
  const flat = new cv.Mat();
  cv.divide(rgb, bg, flat, 255);
  return flat;
}

function percentiles(data: Uint8Array, step: number, ps: number[]): number[] {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    hist[data[i]]++;
    n++;
  }
  return ps.map((p) => {
    const target = p * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v;
    }
    return 255;
  });
}

function makeLut(cv: CV, fn: (v: number) => number): Mat {
  const arr = new Uint8Array(256);
  for (let v = 0; v < 256; v++) arr[v] = Math.max(0, Math.min(255, Math.round(fn(v))));
  return cv.matFromArray(1, 256, cv.CV_8UC1, Array.from(arr));
}

function unsharp(cv: CV, src: Mat, sigma: number, amount: number): Mat {
  const blurred = new cv.Mat();
  cv.GaussianBlur(src, blurred, new cv.Size(0, 0), sigma);
  const dst = new cv.Mat();
  cv.addWeighted(src, 1 + amount, blurred, -amount, 0, dst);
  blurred.delete();
  return dst;
}

/** S7 · color / gray / bw finishing of an illumination-flattened page. */
export function finishDocument(cv: CV, s: MatScope, flat: Mat, mode: 'color' | 'gray' | 'bw'): Mat {
  const gray = s.add(new cv.Mat());
  cv.cvtColor(flat, gray, cv.COLOR_RGB2GRAY);
  if (mode === 'bw') return binarize(cv, s, gray);

  // Ink level from the darkest 1 % (bounded so a blank page stays white).
  const [p1] = percentiles(gray.data, 7, [0.01]);
  const black = Math.min(90, p1);
  const white = 0.93 * 255;
  const lut = s.add(
    makeLut(cv, (v) => {
      const x = Math.max(0, Math.min(1, (v - black) / (white - black)));
      return 255 * Math.pow(x, 1.25);
    }),
  );
  const src = mode === 'gray' ? gray : flat;
  const leveled = s.add(new cv.Mat());
  cv.LUT(src, lut, leveled);
  return unsharp(cv, leveled, 1.0, 0.6);
}

/**
 * Sauvola adaptive threshold (OpenCV.js lacks ximgproc), followed by removal
 * of isolated specks. The window is small enough to keep staff lines and
 * stems in sheet music intact.
 */
export function binarize(cv: CV, s: MatScope, gray: Mat, k = 0.2, R = 128): Mat {
  const long = Math.max(gray.cols, gray.rows);
  const win = new cv.Size(odd(Math.max(15, long / 80)), odd(Math.max(15, long / 80)));
  const anchor = new cv.Point(-1, -1);
  const f = s.add(new cv.Mat());
  gray.convertTo(f, cv.CV_32F);
  const m = s.add(new cv.Mat());
  cv.boxFilter(f, m, cv.CV_32F, win, anchor, true, cv.BORDER_REPLICATE);
  const a = s.add(new cv.Mat());
  const b = s.add(new cv.Mat());
  cv.multiply(f, f, a);
  cv.boxFilter(a, b, cv.CV_32F, win, anchor, true, cv.BORDER_REPLICATE); // E[x²]
  cv.multiply(m, m, a); // E[x]²
  cv.subtract(b, a, b); // variance
  cv.threshold(b, b, 0, 0, cv.THRESH_TOZERO);
  cv.sqrt(b, a); // std
  cv.multiply(m, a, b, k / R);
  cv.addWeighted(m, 1 - k, b, 1, 0, a); // T = m(1-k) + k·m·sd/R
  b.delete();
  const out = new cv.Mat();
  cv.compare(f, a, out, cv.CMP_GT);
  // Sauvola sees no contrast inside large solid areas and would hollow them
  // out; on a flattened page anything below mid-grey is ink regardless.
  const bright = s.add(new cv.Mat());
  cv.threshold(gray, bright, 127, 255, cv.THRESH_BINARY);
  cv.bitwise_and(out, bright, out);
  f.delete();
  m.delete();
  a.delete();
  despeckle(cv, out, Math.max(2, Math.round(3 * (long / 2000) ** 2)));
  return out;
}

/** Turns ink components smaller than minArea white (in place). */
function despeckle(cv: CV, bin: Mat, minArea: number) {
  scoped((s) => {
    const inv = s.add(new cv.Mat());
    cv.bitwise_not(bin, inv);
    const labels = s.add(new cv.Mat());
    const stats = s.add(new cv.Mat());
    const cents = s.add(new cv.Mat());
    const n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
    const drop = new Uint8Array(n);
    let any = false;
    const st: Int32Array = stats.data32S;
    for (let i = 1; i < n; i++) {
      if (st[i * 5 + cv.CC_STAT_AREA] < minArea) {
        drop[i] = 1;
        any = true;
      }
    }
    if (!any) return;
    const lab: Int32Array = labels.data32S;
    const d: Uint8Array = bin.data;
    for (let i = 0; i < lab.length; i++) if (drop[lab[i]]) d[i] = 255;
  });
}

/** S7 · photo / artwork: keep colours, only even out lighting and levels gently. */
export function enhancePhoto(cv: CV, s: MatScope, rgb: Mat): Mat {
  const lab = s.add(new cv.Mat());
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const ch = s.add(new cv.MatVector());
  cv.split(lab, ch);
  const L = s.add(ch.get(0));

  // Very low-frequency lighting field from L (no closing: photos have large dark areas).
  const sm = s.add(resizeLong(cv, L, 96));
  const smf = s.add(new cv.Mat());
  sm.convertTo(smf, cv.CV_32F);
  cv.GaussianBlur(smf, smf, new cv.Size(0, 0), Math.max(sm.cols, sm.rows) / 5);
  const mean = cv.mean(smf)[0] || 1;
  smf.convertTo(smf, cv.CV_32F, 1 / mean);
  cv.max(smf, s.add(new cv.Mat(smf.rows, smf.cols, cv.CV_32F, new cv.Scalar(0.2))), smf);
  // Correct only half of the measured falloff.
  cv.pow(smf, 0.5, smf);
  const field = s.add(new cv.Mat());
  cv.resize(smf, field, new cv.Size(L.cols, L.rows), 0, 0, cv.INTER_LINEAR);
  const Lf = s.add(new cv.Mat());
  L.convertTo(Lf, cv.CV_32F);
  cv.divide(Lf, field, Lf);
  Lf.convertTo(L, cv.CV_8U);

  // Gentle auto-levels on L: only lift a faded black point / dull white point
  // a little, so a photo's own tonal range (e.g. a light, misty picture) stays.
  const [p0, p1] = percentiles(L.data, 5, [0.005, 0.995]);
  const lo = Math.min(p0, 24);
  const hi = Math.max(p1, 232);
  const alpha = 255 / (hi - lo);
  L.convertTo(L, cv.CV_8U, alpha, -lo * alpha);
  ch.set(0, L);
  const merged = s.add(new cv.Mat());
  cv.merge(ch, merged);
  const out = s.add(new cv.Mat());
  cv.cvtColor(merged, out, cv.COLOR_Lab2RGB);
  return s.keep(unsharp(cv, out, 1.2, 0.3));
}

function saturated(cv: CV, s: MatScope, smallRgb: Mat): number {
  const lo = s.add(new cv.Mat(smallRgb.rows, smallRgb.cols, smallRgb.type(), new cv.Scalar(250, 250, 250, 0)));
  const hi = s.add(new cv.Mat(smallRgb.rows, smallRgb.cols, smallRgb.type(), new cv.Scalar(255, 255, 255, 255)));
  const mask = s.add(new cv.Mat());
  cv.inRange(smallRgb, lo, hi, mask);
  return cv.countNonZero(mask) / (smallRgb.rows * smallRgb.cols);
}

/**
 * Auto mode: documents have a smooth paper background (only lighting varies),
 * photos/artwork do not. Colourfulness then separates colour from grey pages.
 */
export function classifyPage(cv: CV, s: MatScope, smallRgb: Mat): Classification {
  const gray = s.add(new cv.Mat());
  cv.cvtColor(smallRgb, gray, cv.COLOR_RGB2GRAY);
  // Background at 160px: enough to see structure that lighting cannot explain.
  const bw = Math.max(1, Math.round((gray.cols * 160) / Math.max(gray.cols, gray.rows)));
  const bh = Math.max(1, Math.round((gray.rows * 160) / Math.max(gray.cols, gray.rows)));
  const bg = s.add(estimateBackground(cv, gray, bw, bh));
  const smooth = s.add(new cv.Mat());
  cv.GaussianBlur(bg, smooth, new cv.Size(0, 0), 20);
  const diff = s.add(new cv.Mat());
  cv.absdiff(bg, smooth, diff);
  const bgRoughness = cv.mean(diff)[0] / Math.max(1, cv.mean(bg)[0]);

  const flat = s.add(flattenIllumination(cv, s, smallRgb));
  const d: Uint8Array = flat.data;
  let n = 0;
  let sRg = 0;
  let sYb = 0;
  let sRg2 = 0;
  let sYb2 = 0;
  for (let i = 0; i < d.length; i += 3) {
    const rg = d[i] - d[i + 1];
    const yb = 0.5 * (d[i] + d[i + 1]) - d[i + 2];
    sRg += rg;
    sYb += yb;
    sRg2 += rg * rg;
    sYb2 += yb * yb;
    n++;
  }
  const mRg = sRg / n;
  const mYb = sYb / n;
  const sdRg = Math.sqrt(Math.max(0, sRg2 / n - mRg * mRg));
  const sdYb = Math.sqrt(Math.max(0, sYb2 / n - mYb * mYb));
  const colorfulness = Math.hypot(sdRg, sdYb) + 0.3 * Math.hypot(mRg, mYb);

  const suggested: ResolvedMode =
    bgRoughness > ROUGHNESS_PHOTO ? 'photo' : colorfulness > COLORFUL_DOC ? 'color' : 'gray';
  return {
    bgRoughness: Math.round(bgRoughness * 1000) / 1000,
    colorfulness: Math.round(colorfulness * 10) / 10,
    suggested,
  };
}

export const ROUGHNESS_PHOTO = 0.06;
export const COLORFUL_DOC = 14;

/** Rotates an image 90° clockwise (new Mat). */
export function rotateCW(cv: CV, src: Mat): Mat {
  const dst = new cv.Mat();
  cv.rotate(src, dst, cv.ROTATE_90_CLOCKWISE);
  return dst;
}
