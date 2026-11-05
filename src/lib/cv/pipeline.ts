import {
  clampQuad,
  fullFrameQuad,
  interiorAngles,
  isConvex,
  orderCorners,
  outputSize,
  polygonArea,
  refineQuadWithEdges,
  resolveRatio,
  scaleQuad,
  type AspectChoice,
  type AspectEstimate,
  type Point,
  type Quad,
} from '../geometry';
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
  /** false => no convincing document edge; quad is the full frame. */
  found: boolean;
  /** 0..1, share of the quad outline backed by image edges. */
  edgeSupport: number;
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

    type Best = { quad: Quad; method: string; score: number; support: number };
    let best = null as Best | null;
    for (const c of candidates) {
      const a = polygonArea(c.quad) / (w * h);
      if (a < 0.08 || a > 0.995) continue;
      if (!isConvex(c.quad)) continue;
      if (interiorAngles(c.quad).some((x) => x < 40 || x > 140)) continue;
      const sup = edgeSupport(support, c.quad);
      const score = 0.65 * sup + 0.35 * Math.sqrt(a);
      if (!best || score > best.score) best = { ...c, score, support: sup };
    }

    const ms = () => now() - t0;
    if (!best || best.support < 0.45) {
      return {
        quad: fullFrameQuad(W, H),
        found: false,
        edgeSupport: best?.support ?? 0,
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
      found: true,
      edgeSupport: best.support,
      method: best.method,
      candidates: candidates.length,
      ms: ms(),
    };
  });
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
      if (x >= 0 && y >= 0 && x < w && y < h && data[y * w + x]) hit++;
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
  timings: Record<string, number>;
}

export interface Classification {
  /** How much the estimated paper background varies beyond smooth lighting. */
  bgRoughness: number;
  /** Hasler–Süsstrunk colourfulness of the flattened page. */
  colorfulness: number;
  suggested: ResolvedMode;
}

export function processPage(cv: CV, rgba: Mat, quad: Quad, opts: ProcessOptions): ProcessResult {
  const timings: Record<string, number> = {};
  const lap = (name: string, t: number) => (timings[name] = Math.round((now() - t) * 10) / 10);

  return scoped((s) => {
    let t = now();
    const aspect = resolveRatio(opts.aspect, quad, rgba.cols, rgba.rows);
    const size = outputSize(quad, aspect.ratio, opts.maxLong ?? 4000);
    const warpedRgba = s.add(warpQuad(cv, rgba, quad, size.width, size.height));
    const rgb = s.add(new cv.Mat());
    cv.cvtColor(warpedRgba, rgb, cv.COLOR_RGBA2RGB);
    warpedRgba.delete();
    lap('warp', t);

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
