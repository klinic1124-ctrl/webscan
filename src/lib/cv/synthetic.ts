// Synthetic "phone photos" of documents with a known ground truth: used by the
// automated tests and as the built-in sample in the app.
import { orderCorners, projectRectangle, type CameraPose, type Quad } from '../geometry';
import { scoped, type CV, type Mat } from './loadCv';

export type SampleKind = 'text' | 'music' | 'photo';

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAPER = [247, 245, 238, 255];
const INK = [35, 35, 40, 255];

/** Flat RGB page (8UC3) as it would come out of a perfect scanner. */
export function makeDocument(cv: CV, kind: SampleKind, w: number, h: number, seed = 1): Mat {
  const r = rng(seed);
  const doc = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(...PAPER));
  const P = (x: number, y: number) => new cv.Point(Math.round(x), Math.round(y));
  const u = w / 840; // layout unit relative to an 840px-wide page

  if (kind === 'text') {
    cv.rectangle(doc, P(80 * u, 70 * u), P(520 * u, 96 * u), INK, -1);
    let y = 150 * u;
    while (y < h - 90 * u) {
      let x = 80 * u;
      const lineEnd = r() < 0.15 ? w * 0.55 : w - 80 * u;
      while (x < lineEnd) {
        const ww = (18 + r() * 70) * u;
        if (x + ww > lineEnd) break;
        cv.rectangle(doc, P(x, y), P(x + ww, y + 9 * u), INK, -1);
        x += ww + 9 * u;
      }
      y += r() < 0.12 ? 44 * u : 24 * u;
    }
  } else if (kind === 'music') {
    cv.rectangle(doc, P(260 * u, 60 * u), P(580 * u, 84 * u), INK, -1);
    const gap = 9 * u;
    for (let sy = 140 * u; sy < h - 120 * u; sy += 105 * u) {
      const left = 70 * u;
      const right = w - 70 * u;
      for (let l = 0; l < 5; l++) cv.line(doc, P(left, sy + l * gap), P(right, sy + l * gap), INK, Math.max(1, Math.round(u)));
      for (const bx of [left, w * 0.36, w * 0.62, right]) {
        cv.line(doc, P(bx, sy), P(bx, sy + 4 * gap), INK, Math.max(1, Math.round(1.5 * u)));
      }
      for (let x = left + 50 * u; x < right - 20 * u; x += (26 + r() * 14) * u) {
        const step = Math.floor(r() * 9) - 1; // -1..7 half-steps
        const ny = sy + 4 * gap - (step * gap) / 2;
        cv.ellipse(doc, P(x, ny), new cv.Size(5.5 * u, 4 * u), -20, 0, 360, INK, -1);
        const up = step < 4;
        cv.line(doc, P(x + (up ? 5 : -5) * u, ny), P(x + (up ? 5 : -5) * u, ny + (up ? -30 : 30) * u), INK, Math.max(1, Math.round(1.3 * u)));
      }
    }
  } else {
    // Printed photo with a white border: sky gradient, hills, sun.
    const m = 26 * u;
    for (let y = m; y < h - m; y++) {
      const t = (y - m) / (h - 2 * m);
      cv.line(doc, P(m, y), P(w - m, y), [70 + 90 * t, 130 + 70 * t, 210 - 40 * t, 255], 1);
    }
    cv.circle(doc, P(w * 0.72, h * 0.25), 60 * u, [250, 210, 90, 255], -1);
    for (let i = 0; i < 4; i++) {
      const cx = w * (0.1 + 0.3 * i + r() * 0.1);
      cv.ellipse(doc, P(cx, h * 0.78), new cv.Size(w * 0.35, h * (0.18 + r() * 0.1)), 0, 180, 360, [40 + i * 20, 110 + i * 15, 50, 255], -1);
    }
    cv.rectangle(doc, P(m, h * 0.78), P(w - m, h - m), [60, 120, 55, 255], -1);
    const blurred = new cv.Mat();
    cv.GaussianBlur(doc, blurred, new cv.Size(0, 0), 2.5 * u);
    blurred.copyTo(doc);
    blurred.delete();
    // restore the white border after blurring
    cv.rectangle(doc, P(0, 0), P(w - 1, h - 1), PAPER, Math.round(2 * m));
  }
  return doc;
}

export interface SceneOptions {
  kind: SampleKind;
  width?: number;
  height?: number;
  pose?: Partial<CameraPose>;
  /** Darken one side and add a soft hand/phone shadow. */
  shadow?: boolean;
  /** Add a blown-out reflection blob. */
  glare?: boolean;
  /**
   * Where the reflection sits, as a fraction of the page (0..1, 0..1).
   * Default: a little right of and above the page centre.
   */
  glareAt?: { x: number; y: number };
  /** Table colour (RGB). Default: mid-brown wood. */
  table?: [number, number, number];
  seed?: number;
}

export interface Scene {
  /** RGBA 8UC4 photo — caller deletes. */
  rgba: Mat;
  /** Flat RGB ground-truth page — caller deletes. */
  doc: Mat;
  quad: Quad;
}

export function makeScene(cv: CV, o: SceneOptions): Scene {
  const W = o.width ?? 1600;
  const H = o.height ?? 1200;
  const r = rng(o.seed ?? 7);
  const docW = 840;
  const docH = Math.round(docW * (297 / 210));
  const doc = makeDocument(cv, o.kind, docW, docH, o.seed ?? 1);
  const f = 0.75 * Math.max(W, H);
  const quad = orderCorners(
    projectRectangle({
      aspect: docW / docH,
      f,
      cx: W / 2,
      cy: H / 2,
      distance: f / (0.78 * H),
      rx: 22,
      ry: -6,
      rz: 4,
      ...o.pose,
    }),
  );

  const rgba = scoped((s) => {
    // Table: warm wood colour, grain streaks and sensor noise.
    const [tr, tg, tb] = o.table ?? [118, 88, 62];
    const scene = s.add(new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(tr, tg, tb, 255)));
    for (let i = 0; i < 40; i++) {
      const y = r() * H;
      const v = 0.85 + r() * 0.3;
      cv.line(scene, new cv.Point(0, Math.round(y)), new cv.Point(W, Math.round(y + (r() - 0.5) * 60)), [Math.min(255, tr * v), Math.min(255, tg * v), Math.min(255, tb * v), 255], 1 + Math.round(r() * 3));
    }

    const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, docW - 1, 0, docW - 1, docH - 1, 0, docH - 1]));
    const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y])));
    const M = s.add(cv.getPerspectiveTransform(from, to));
    const warped = s.add(new cv.Mat());
    cv.warpPerspective(doc, warped, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    const ones = s.add(new cv.Mat(docH, docW, cv.CV_8UC1, new cv.Scalar(255)));
    const mask = s.add(new cv.Mat());
    cv.warpPerspective(ones, mask, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    cv.threshold(mask, mask, 127, 255, cv.THRESH_BINARY);
    warped.copyTo(scene, mask);

    // Lighting: falloff across the frame plus an optional soft shadow.
    const field = s.add(new cv.Mat(H, W, cv.CV_32FC1));
    const fd: Float32Array = field.data32F;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        fd[y * W + x] = o.shadow ? 1.0 - 0.38 * (x / W) - 0.12 * (y / H) : 1.0 - 0.08 * (x / W);
      }
    }
    if (o.shadow) {
      const sh = s.add(new cv.Mat(H, W, cv.CV_32FC1, new cv.Scalar(1)));
      cv.ellipse(sh, new cv.Point(Math.round(W * 0.3), Math.round(H * 0.98)), new cv.Size(Math.round(W * 0.2), Math.round(H * 0.35)), 15, 0, 360, new cv.Scalar(0.5), -1);
      cv.GaussianBlur(sh, sh, new cv.Size(0, 0), 28);
      cv.multiply(field, sh, field);
    }
    const f3 = s.add(new cv.Mat());
    const fv = s.add(new cv.MatVector());
    fv.push_back(field);
    fv.push_back(field);
    fv.push_back(field);
    cv.merge(fv, f3);
    const sf = s.add(new cv.Mat());
    scene.convertTo(sf, cv.CV_32FC3);
    cv.multiply(sf, f3, sf);

    if (o.glare) {
      const g = s.add(new cv.Mat(H, W, cv.CV_32FC3, new cv.Scalar(0, 0, 0)));
      // Page point → image point through the page homography.
      const at = o.glareAt ?? { x: 0.6, y: 0.4 };
      const m: Float64Array = M.data64F;
      const px = at.x * (docW - 1);
      const py = at.y * (docH - 1);
      const z = m[6] * px + m[7] * py + m[8];
      const c = { x: (m[0] * px + m[1] * py + m[2]) / z, y: (m[3] * px + m[4] * py + m[5]) / z };
      cv.ellipse(g, new cv.Point(Math.round(c.x), Math.round(c.y)), new cv.Size(Math.round(W * 0.06), Math.round(H * 0.04)), 30, 0, 360, new cv.Scalar(400, 400, 400), -1);
      cv.GaussianBlur(g, g, new cv.Size(0, 0), 12);
      cv.add(sf, g, sf);
    }

    // Sensor noise (σ≈3, sum of uniforms approximates a Gaussian).
    const nd: Float32Array = sf.data32F;
    for (let i = 0; i < nd.length; i++) nd[i] += (r() + r() + r() - 1.5) * 6;
    const out8 = s.add(new cv.Mat());
    sf.convertTo(out8, cv.CV_8UC3);
    const rgbaOut = new cv.Mat();
    cv.cvtColor(out8, rgbaOut, cv.COLOR_RGB2RGBA);
    return rgbaOut;
  });

  return { rgba, doc, quad };
}
