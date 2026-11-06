// Realistic printed sheet music with a known ground truth, a phone-camera
// simulation of it, and measurements of how well a black & white scan keeps
// the notation: staff lines, stems, filled and hollow noteheads.
//
// The page is drawn at 2× and reduced, so thin lines come out anti-aliased
// and partly grey, as engraved music does once printed and photographed.
import { orderCorners, projectRectangle, type CameraPose, type Quad } from '../../src/lib/geometry';
import { rng } from '../../src/lib/cv/synthetic';
import { scoped, type CV, type Mat } from '../../src/lib/cv/loadCv';

export interface HLine {
  y: number;
  x0: number;
  x1: number;
}
export interface VLine {
  x: number;
  y0: number;
  y1: number;
}
export interface Ellipse {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface Score {
  /** RGB 8UC3 page — caller deletes. */
  doc: Mat;
  staffLines: HLine[];
  stems: VLine[];
  hollow: Ellipse[];
  filled: Ellipse[];
  /** Staff space in page pixels. */
  space: number;
}

const PAPER = [250, 249, 244, 255];

/**
 * A4 page `w` px wide. Proportions follow engraving practice: staff space
 * 1.75 mm, staff lines 0.13 mm, stems 0.12 mm (thinner than staff lines),
 * beams half a space.
 */
export function makeScore(cv: CV, w: number, seed = 3, inkLevel = 28): Score {
  const INK = [inkLevel, inkLevel, inkLevel + 4, 255];
  const r = rng(seed);
  const h = Math.round((w * 297) / 210);
  const S = 2; // supersampling
  const mm = (w / 210) * S;
  const big = new cv.Mat(h * S, w * S, cv.CV_8UC3, new cv.Scalar(...PAPER));
  const P = (x: number, y: number) => new cv.Point(Math.round(x), Math.round(y));
  const sp = 1.75 * mm;
  const staffT = Math.max(1, Math.round(0.13 * mm));
  const stemT = Math.max(1, Math.round(0.12 * mm));
  const staffLines: HLine[] = [];
  const stems: VLine[] = [];
  const hollow: Ellipse[] = [];
  const filled: Ellipse[] = [];

  // Title and composer as solid "word" blocks (OpenCV.js has no text).
  cv.rectangle(big, P(70 * mm, 18 * mm), P(140 * mm, 25 * mm), INK, -1);
  cv.rectangle(big, P(150 * mm, 30 * mm), P(190 * mm, 33 * mm), INK, -1);

  const left = 18 * mm;
  const right = 192 * mm;
  for (let top = 45 * mm; top + 4 * sp < 280 * mm; top += 23 * mm) {
    for (let l = 0; l < 5; l++) {
      const y = top + l * sp;
      cv.line(big, P(left, y), P(right, y), INK, staffT);
      staffLines.push({ y: y / S, x0: left / S, x1: right / S });
    }
    // Clef stand-in and time signature: bold shapes at the start.
    cv.ellipse(big, P(left + 4 * mm, top + 2.5 * sp), new cv.Size(Math.round(1.6 * mm), Math.round(3.2 * sp)), 0, 0, 360, INK, Math.round(0.6 * mm));
    cv.rectangle(big, P(left + 9 * mm, top + 0.3 * sp), P(left + 11 * mm, top + 1.7 * sp), INK, -1);
    cv.rectangle(big, P(left + 9 * mm, top + 2.3 * sp), P(left + 11 * mm, top + 3.7 * sp), INK, -1);
    // Bar lines.
    for (const bx of [left, left + 0.27 * (right - left), left + 0.54 * (right - left), left + 0.78 * (right - left), right])
      cv.line(big, P(bx, top), P(bx, top + 4 * sp), INK, Math.max(1, Math.round(0.2 * mm)));

    let x = left + 16 * mm;
    let beamFrom: { x: number; y: number }[] = [];
    while (x < right - 6 * mm) {
      const step = Math.floor(r() * 13) - 3; // -3..9 half-spaces from the bottom line
      const ny = top + 4 * sp - (step * sp) / 2;
      const rx = 0.66 * sp;
      const ry = 0.48 * sp;
      const isHollow = r() < 0.25;
      if (isHollow) {
        cv.ellipse(big, P(x, ny), new cv.Size(Math.round(rx), Math.round(ry)), -20, 0, 360, INK, Math.max(2, Math.round(0.28 * mm)));
        hollow.push({ x: x / S, y: ny / S, rx: rx / S, ry: ry / S });
      } else {
        cv.ellipse(big, P(x, ny), new cv.Size(Math.round(rx), Math.round(ry)), -20, 0, 360, INK, -1);
        filled.push({ x: x / S, y: ny / S, rx: rx / S, ry: ry / S });
      }
      // Ledger lines below / above the staff.
      for (let k = -2; k >= step; k -= 2) {
        const ly = top + 4 * sp - (k * sp) / 2;
        cv.line(big, P(x - 1.5 * rx, ly), P(x + 1.5 * rx, ly), INK, staffT);
      }
      for (let k = 10; k <= step; k += 2) {
        const ly = top + 4 * sp - (k * sp) / 2;
        cv.line(big, P(x - 1.5 * rx, ly), P(x + 1.5 * rx, ly), INK, staffT);
      }
      const up = step < 4;
      const sx = x + (up ? rx - stemT / 2 : -rx + stemT / 2);
      const sy1 = ny + (up ? -3.5 : 3.5) * sp;
      cv.line(big, P(sx, ny), P(sx, sy1), INK, stemT);
      stems.push({ x: sx / S, y0: Math.min(ny, sy1) / S + 1, y1: Math.max(ny, sy1) / S - 1 });
      // Beam pairs of eighth notes (stems up only, to keep it simple).
      if (!isHollow && up) {
        beamFrom.push({ x: sx, y: sy1 });
        if (beamFrom.length === 2) {
          const [a, b] = beamFrom;
          const th = Math.round(0.5 * sp);
          cv.line(big, P(a.x, a.y + th / 2), P(b.x, b.y + th / 2), INK, th);
          beamFrom = [];
        }
      } else beamFrom = [];
      x += (5 + r() * 4) * mm;
    }
    // A slur over the first bar: thin curve, thicker in the middle.
    const sx0 = left + 18 * mm;
    const sx1 = left + 42 * mm;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const px = sx0 + (sx1 - sx0) * t;
      const py = top - 1.5 * sp - Math.sin(Math.PI * t) * 1.2 * sp;
      cv.circle(big, P(px, py), Math.max(1, Math.round((0.08 + 0.18 * Math.sin(Math.PI * t)) * mm)), INK, -1);
    }
    // Lyrics: small word blocks under the staff.
    for (let lx = left + 16 * mm; lx < right - 12 * mm; lx += (9 + r() * 6) * mm)
      cv.rectangle(big, P(lx, top + 4 * sp + 6 * mm), P(lx + (4 + r() * 4) * mm, top + 4 * sp + 8 * mm), INK, -1);
  }
  const doc = new cv.Mat();
  cv.resize(big, doc, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  big.delete();
  return { doc, staffLines, stems, hollow, filled, space: sp / S };
}

export interface PhotoOptions {
  /** Photo size (portrait phone photo by default). */
  width?: number;
  height?: number;
  pose?: Partial<CameraPose>;
  /** Lens/focus blur, σ in photo pixels. */
  blur?: number;
  /** Sensor noise, σ in grey levels. */
  noise?: number;
  /** Uneven light: brightness drop across the page (0 = even). */
  shade?: number;
  /** Overall exposure of white paper (0..255). */
  white?: number;
  /** Music printed on the back showing through thin paper (0..1 strength). */
  showThrough?: number;
  seed?: number;
}

/** The page photographed on a table: perspective, blur, light falloff, noise. */
export function photograph(cv: CV, doc: Mat, o: PhotoOptions = {}): { rgba: Mat; quad: Quad } {
  const W = o.width ?? 3024;
  const H = o.height ?? 4032;
  const r = rng(o.seed ?? 11);
  const docW = doc.cols;
  const docH = doc.rows;
  const f = 0.75 * Math.max(W, H);
  const quad = orderCorners(
    projectRectangle({ aspect: docW / docH, f, cx: W / 2, cy: H / 2, distance: f / (0.88 * H), rx: 12, ry: -5, rz: 2, ...o.pose }),
  );
  const rgba = scoped((s) => {
    const scene = s.add(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(96, 74, 58, 255)));
    // Pre-blur the page by its reduction factor so the warp does not alias.
    const reduce = Math.max(1, docW / Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y));
    const src = s.add(new cv.Mat());
    cv.GaussianBlur(doc, src, new cv.Size(0, 0), Math.max(0.01, 0.45 * reduce));
    if (o.showThrough) {
      // The back page: other music, mirrored, a little out of register with
      // the front, blurred by the paper.
      const other = makeScore(cv, docW, 17);
      const back = s.add(other.doc);
      cv.rotate(back, back, cv.ROTATE_180);
      const moved = s.add(new cv.Mat(docH, docW, cv.CV_8UC3, new cv.Scalar(255, 255, 255)));
      const dx = Math.round(docW * 0.02);
      const dy = Math.round(docH * 0.013);
      back.roi(new cv.Rect(0, 0, docW - dx, docH - dy)).copyTo(moved.roi(new cv.Rect(dx, dy, docW - dx, docH - dy)));
      cv.GaussianBlur(moved, moved, new cv.Size(0, 0), 2.5 * reduce);
      cv.subtract(new cv.Mat(docH, docW, cv.CV_8UC3, new cv.Scalar(255, 255, 255)), moved, moved); // ink as light
      const sub = s.add(new cv.Mat());
      moved.convertTo(sub, cv.CV_8UC3, o.showThrough);
      cv.subtract(src, sub, src);
    }
    const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, docW - 1, 0, docW - 1, docH - 1, 0, docH - 1]));
    const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y])));
    const M = s.add(cv.getPerspectiveTransform(from, to));
    const warped = s.add(new cv.Mat());
    cv.warpPerspective(src, warped, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    const ones = s.add(new cv.Mat(docH, docW, cv.CV_8UC1, new cv.Scalar(255)));
    const mask = s.add(new cv.Mat());
    cv.warpPerspective(ones, mask, M, new cv.Size(W, H), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar());
    warped.copyTo(scene, mask);
    if ((o.blur ?? 1.1) > 0) cv.GaussianBlur(scene, scene, new cv.Size(0, 0), o.blur ?? 1.1);

    const sf = s.add(new cv.Mat());
    scene.convertTo(sf, cv.CV_32FC3, (o.white ?? 225) / 250);
    const d: Float32Array = sf.data32F;
    const shade = o.shade ?? 0.3;
    const noise = o.noise ?? 3;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i += 3) {
        // Light falling off towards one corner, as from a lamp or window.
        const l = 1 - shade * (0.6 * (x / W) + 0.4 * (y / H)) ** 1.5;
        const n = (r() + r() + r() - 1.5) * 2 * noise;
        d[i] = d[i] * l + n;
        d[i + 1] = d[i + 1] * l + n;
        d[i + 2] = d[i + 2] * l * 0.97 + n;
      }
    }
    const out8 = s.add(new cv.Mat());
    sf.convertTo(out8, cv.CV_8UC3);
    const out = new cv.Mat();
    cv.cvtColor(out8, out, cv.COLOR_RGB2RGBA);
    return out;
  });
  return { rgba, quad };
}

export interface ScoreQuality {
  /** Share of staff-line length present (0..1). */
  staff: number;
  /** Share of staff lines without any gap longer than one staff space. */
  staffWhole: number;
  /** Share of stem length present. */
  stems: number;
  /** Share of filled-notehead area that is ink. */
  filledHeads: number;
  /** Share of hollow-notehead holes kept open (white centre). */
  hollowOpen: number;
  /** Ink pixels far from any notation, per million page pixels. */
  noise: number;
  /** Ink area relative to the printed ink (1 = same weight; >1 bolder). */
  weight: number;
}

/**
 * Measures a black & white result (8UC1 or RGBA, ink = dark) against the
 * score it was made from. The result is assumed to be the page, scaled.
 */
export function measureScore(cv: CV, result: Mat, score: Score): ScoreQuality {
  return scoped((s) => {
    let bin: Mat = result;
    if (result.channels() !== 1) {
      bin = s.add(new cv.Mat());
      cv.cvtColor(result, bin, cv.COLOR_RGBA2GRAY);
    }
    const W = bin.cols;
    const H = bin.rows;
    const k = W / score.doc.cols;
    const d: Uint8Array = bin.data;
    const ink = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < W && yi < H && d[yi * W + xi] < 128;
    };
    // Slack for the dewarp's geometric error: about a fifth of a staff space.
    const tol = Math.max(2, Math.round(0.2 * score.space * k));
    const near = (x: number, y: number, rx: number, ry: number) => {
      for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) if (ink(x + dx, y + dy)) return true;
      return false;
    };

    let got = 0;
    let all = 0;
    let whole = 0;
    const gapMax = score.space * k;
    for (const l of score.staffLines) {
      let run = 0;
      let worst = 0;
      for (let x = l.x0 * k + 2; x <= l.x1 * k - 2; x++) {
        all++;
        if (near(x, l.y * k, 0, tol)) {
          got++;
          run = 0;
        } else worst = Math.max(worst, ++run);
      }
      if (worst <= gapMax) whole++;
      if (process.env.SCORE_GAPS && worst > gapMax) console.log('gap', Math.round(l.y * k), 'worst', worst);
    }
    let sGot = 0;
    let sAll = 0;
    for (const st of score.stems)
      for (let y = st.y0 * k; y <= st.y1 * k; y++) {
        sAll++;
        if (near(st.x * k, y, tol, 0)) sGot++;
      }
    let fIn = 0;
    let fAll = 0;
    for (const e of score.filled)
      for (let dy = -e.ry * 0.5; dy <= e.ry * 0.5; dy++)
        for (let dx = -e.rx * 0.5; dx <= e.rx * 0.5; dx++) {
          fAll++;
          if (ink((e.x + dx) * k, (e.y + dy) * k)) fIn++;
        }
    let open = 0;
    for (const e of score.hollow) {
      // The hole is small: look for any white pixel near the centre.
      const r0 = Math.max(1, Math.round(0.25 * e.ry * k));
      let white = false;
      for (let dy = -r0; dy <= r0 && !white; dy++) for (let dx = -r0; dx <= r0 && !white; dx++) if (!ink(e.x * k + dx, e.y * k + dy)) white = true;
      if (white) open++;
    }

    // Noise: ink not within reach of the true notation.
    const truth = s.add(new cv.Mat());
    cv.cvtColor(score.doc, truth, cv.COLOR_RGB2GRAY);
    const t2 = s.add(new cv.Mat());
    cv.resize(truth, t2, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    cv.threshold(t2, t2, 200, 255, cv.THRESH_BINARY_INV);
    const reach = s.add(new cv.Mat());
    cv.dilate(t2, reach, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2 * tol + 3, 2 * tol + 3)));
    const rd: Uint8Array = reach.data;
    let inkOut = 0;
    let inkTrue = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] < 128) inkOut++;
    }
    // True ink: darker than halfway between paper and the darkest print.
    const mid = s.add(new cv.Mat());
    cv.resize(truth, mid, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const md: Uint8Array = mid.data;
    let darkest = 255;
    for (let i = 0; i < md.length; i += 7) darkest = Math.min(darkest, md[i]);
    const cut = 0.5 * (250 + darkest);
    for (let i = 0; i < md.length; i++) if (md[i] < cut) inkTrue++;
    let stray = 0;
    const margin = Math.round(0.03 * W);
    const where = new Map<string, number>();
    for (let y = margin; y < H - margin; y++)
      for (let x = margin; x < W - margin; x++)
        if (d[y * W + x] < 128 && !rd[y * W + x]) {
          stray++;
          if (process.env.SCORE_GAPS) {
            const key = `${Math.floor((x / W) * 10)},${Math.floor((y / H) * 20)}`;
            where.set(key, (where.get(key) ?? 0) + 1);
          }
        }
    if (process.env.SCORE_GAPS) console.log('stray (x/10,y/20):', [...where].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(' '));

    return {
      staff: got / all,
      staffWhole: whole / score.staffLines.length,
      stems: sGot / sAll,
      filledHeads: fIn / fAll,
      hollowOpen: open / Math.max(1, score.hollow.length),
      noise: (stray / (W * H)) * 1e6,
      weight: inkOut / Math.max(1, inkTrue),
    };
  });
}
