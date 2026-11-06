// S6 · Reflection (glare) removal from several photos of the same page.
//
// A reflection only ever adds light, and it moves when the camera moves.
// After every shot is flattened to the same page geometry, a pixel that is
// clearly brighter in one shot than in another is a reflection in that
// shot. The first (main) shot is kept everywhere except where it shows a
// reflection; there the other shots fill in, with soft, feathered weights.
import type { Quad } from '../geometry';
import { copyMat, scoped, type CV, type Mat } from './loadCv';

const odd = (n: number) => (Math.round(n) % 2 === 0 ? Math.round(n) + 1 : Math.round(n));

function resizeTo(cv: CV, src: Mat, w: number, h: number, interp: number): Mat {
  const dst = new cv.Mat();
  cv.resize(src, dst, new cv.Size(w, h), 0, 0, interp);
  return dst;
}

function smallSize(w: number, h: number, long: number) {
  const f = Math.min(1, long / Math.max(w, h));
  return { w: Math.max(8, Math.round(w * f)), h: Math.max(8, Math.round(h * f)), f };
}

type M3 = number[]; // row-major 3×3

const mul3 = (a: M3, b: M3): M3 => {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};

const inv3 = (m: M3): M3 => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
};

const scaleM = (f: number): M3 => [f, 0, 0, 0, f, 0, 0, 0, 1];

/**
 * ORB + RANSAC homography that maps points of `moving` onto `ref` (both
 * small grey images of the same page). Null when matches are too few or
 * the correction is implausibly large (corners moved > 4 % of the diagonal).
 */
function matchHomography(cv: CV, ref: Mat, moving: Mat): M3 | null {
  return scoped((s) => {
    const orb = new cv.ORB(1500);
    const kp0 = s.add(new cv.KeyPointVector());
    const kp1 = s.add(new cv.KeyPointVector());
    const d0 = s.add(new cv.Mat());
    const d1 = s.add(new cv.Mat());
    const none = s.add(new cv.Mat());
    orb.detectAndCompute(ref, none, kp0, d0);
    orb.detectAndCompute(moving, none, kp1, d1);
    orb.delete();
    if (d0.rows < 12 || d1.rows < 12) return null;
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
    const matches = s.add(new cv.DMatchVector());
    bf.match(d1, d0, matches);
    bf.delete();
    const n = matches.size();
    if (n < 12) return null;
    const src: number[] = [];
    const dst: number[] = [];
    for (let i = 0; i < n; i++) {
      const m = matches.get(i);
      const a = kp1.get(m.queryIdx).pt;
      const b = kp0.get(m.trainIdx).pt;
      src.push(a.x, a.y);
      dst.push(b.x, b.y);
    }
    const srcM = s.add(cv.matFromArray(n, 1, cv.CV_32FC2, src));
    const dstM = s.add(cv.matFromArray(n, 1, cv.CV_32FC2, dst));
    const mask = s.add(new cv.Mat());
    const H = s.add(cv.findHomography(srcM, dstM, cv.RANSAC, 2.5, mask));
    if (H.empty()) return null;
    const inliers = cv.countNonZero(mask);
    if (inliers < 12 || inliers < 0.25 * n) return null;
    const hd: number[] = Array.from(H.data64F as Float64Array);
    const w = ref.cols;
    const h = ref.rows;
    const diag = Math.hypot(w, h);
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ]) {
      const z = hd[6] * x + hd[7] * y + hd[8];
      const nx = (hd[0] * x + hd[1] * y + hd[2]) / z;
      const ny = (hd[3] * x + hd[4] * y + hd[5]) / z;
      if (!(Math.hypot(nx - x, ny - y) < 0.04 * diag)) return null;
    }
    return hd;
  });
}

export interface AlignExtraResult {
  /** The extra shot on the main shot's page grid (RGB 8UC3, main's size) — caller deletes. */
  aligned: Mat;
  /** Feature-based alignment succeeded (else only the corners were used). */
  ok: boolean;
  /** Last refinement applied. */
  method: 'corners' | 'homography' | 'flow';
  ms: number;
}

const ALIGN_LONG = 800;

/**
 * Puts an extra photo onto the main shot's page grid, as sharply as possible:
 * 1. page homography from its own corners,
 * 2. corrected by an ORB + RANSAC homography against the main shot,
 * 3. then a dense optical-flow correction for what a single homography
 *    cannot express (paper not quite flat, lens distortion, corners a few
 *    pixels off). Flow is ignored where either shot is blown out (the
 *    reflection itself) and filled in from the surroundings.
 * The source photo is resampled only once, straight into the page grid.
 */
export function alignExtra(cv: CV, mainRgb: Mat, extraRgba: Mat, quad: Quad, refine: 'homography' | 'flow' = 'flow'): AlignExtraResult {
  const t0 = performance.now();
  return scoped((s) => {
    const W = mainRgb.cols;
    const H = mainRgb.rows;
    const { w, h, f } = smallSize(W, H, ALIGN_LONG);

    // 1. Source photo → page (full resolution).
    const from = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y])));
    const to = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W - 1, 0, W - 1, H - 1, 0, H - 1]));
    let Hp: M3 = Array.from(s.add(cv.getPerspectiveTransform(from, to)).data64F as Float64Array);

    // Small working copies. The source is pre-shrunk so the small warp does not alias.
    const ds = Math.min(1, (1.5 * Math.max(w, h)) / Math.max(extraRgba.cols, extraRgba.rows));
    const srcSmall = s.add(resizeTo(cv, extraRgba, Math.max(1, Math.round(extraRgba.cols * ds)), Math.max(1, Math.round(extraRgba.rows * ds)), cv.INTER_AREA));
    const mainSmall = s.add(resizeTo(cv, mainRgb, w, h, cv.INTER_AREA));
    const g0 = s.add(new cv.Mat());
    cv.cvtColor(mainSmall, g0, cv.COLOR_RGB2GRAY);
    const smallOf = (Hfull: M3) => {
      // small page ← full page ← source ← small source
      const Hs = mul3(scaleM(f), mul3(Hfull, scaleM(1 / ds)));
      const m = s.add(cv.matFromArray(3, 3, cv.CV_64F, Hs));
      const out = s.add(new cv.Mat());
      cv.warpPerspective(srcSmall, out, m, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const g = s.add(new cv.Mat());
      cv.cvtColor(out, g, cv.COLOR_RGBA2GRAY);
      return g;
    };

    // 2. Feature homography (small page coords) → full page coords.
    let ok = false;
    let method: AlignExtraResult['method'] = 'corners';
    const Hs = matchHomography(cv, g0, smallOf(Hp));
    if (Hs) {
      Hp = mul3(mul3(scaleM(1 / f), mul3(Hs, scaleM(f))), Hp);
      ok = true;
      method = 'homography';
    }

    // 3. Dense flow: main(x) ≈ extra(x + d(x)), in small page pixels.
    let flow: Float32Array | null = null;
    if (refine === 'flow') {
      const g1 = smallOf(Hp);
      const fl = s.add(new cv.Mat());
      cv.calcOpticalFlowFarneback(g0, g1, fl, 0.5, 4, 21, 3, 5, 1.1, 0);
      // Unreliable where either shot is blown out (reflections) — mask, then
      // fill from neighbours by normalised convolution.
      const bad = s.add(new cv.Mat());
      const b1 = s.add(new cv.Mat());
      // Only near-saturated pixels: white paper itself is often 230–245.
      cv.threshold(g0, bad, 248, 255, cv.THRESH_BINARY);
      cv.threshold(g1, b1, 248, 255, cv.THRESH_BINARY);
      cv.bitwise_or(bad, b1, bad);
      const kd = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(odd(w / 60), odd(w / 60))));
      cv.dilate(bad, bad, kd);
      const valid = s.add(new cv.Mat());
      cv.bitwise_not(bad, valid);
      const vf = s.add(new cv.Mat());
      valid.convertTo(vf, cv.CV_32F, 1 / 255);
      const ch = s.add(new cv.MatVector());
      cv.split(fl, ch);
      const sigma = Math.max(w, h) * 0.02;
      const den = s.add(new cv.Mat());
      cv.GaussianBlur(vf, den, new cv.Size(0, 0), sigma);
      cv.max(den, s.add(new cv.Mat(h, w, cv.CV_32F, new cv.Scalar(1e-3))), den);
      const comps: Float32Array[] = [];
      for (let c = 0; c < 2; c++) {
        const comp = s.add(ch.get(c));
        cv.multiply(comp, vf, comp);
        cv.GaussianBlur(comp, comp, new cv.Size(0, 0), sigma);
        cv.divide(comp, den, comp);
        comps.push(comp.data32F as Float32Array);
      }
      // Plausibility: a correction larger than 3 % of the page means the
      // flow lost track; keep the homography result then.
      const limit = 0.03 * Math.max(w, h);
      let big = 0;
      for (let i = 0; i < comps[0].length; i++) if (Math.hypot(comps[0][i], comps[1][i]) > limit) big++;
      if (big < 0.02 * comps[0].length) {
        flow = new Float32Array(w * h * 2);
        for (let i = 0; i < w * h; i++) {
          flow[2 * i] = comps[0][i];
          flow[2 * i + 1] = comps[1][i];
        }
        method = 'flow';
      }
    }

    // 4. One resampling from the original photo: page pixel X → source
    //    Hp⁻¹ · (X + d(X)), built in strips to keep the maps small.
    const Hi = inv3(Hp);
    const aligned = new cv.Mat(H, W, cv.CV_8UC3);
    const STRIP = 128;
    const fs = f; // full → small page scale
    for (let y0 = 0; y0 < H; y0 += STRIP) {
      scoped((t) => {
        const rows = Math.min(STRIP, H - y0);
        const mx = t.add(new cv.Mat(rows, W, cv.CV_32FC1));
        const my = t.add(new cv.Mat(rows, W, cv.CV_32FC1));
        const ax: Float32Array = mx.data32F;
        const ay: Float32Array = my.data32F;
        for (let r = 0; r < rows; r++) {
          const Y = y0 + r;
          for (let X = 0; X < W; X++) {
            let px = X;
            let py = Y;
            if (flow) {
              // bilinear sample of the small flow field, scaled to full px
              const sx = Math.min(w - 1.001, Math.max(0, X * fs));
              const sy = Math.min(h - 1.001, Math.max(0, Y * fs));
              const x0 = sx | 0;
              const yy = sy | 0;
              const ux = sx - x0;
              const uy = sy - yy;
              const i00 = 2 * (yy * w + x0);
              const i10 = i00 + 2;
              const i01 = i00 + 2 * w;
              const i11 = i01 + 2;
              const dx = (flow[i00] * (1 - ux) + flow[i10] * ux) * (1 - uy) + (flow[i01] * (1 - ux) + flow[i11] * ux) * uy;
              const dy = (flow[i00 + 1] * (1 - ux) + flow[i10 + 1] * ux) * (1 - uy) + (flow[i01 + 1] * (1 - ux) + flow[i11 + 1] * ux) * uy;
              px += dx / fs;
              py += dy / fs;
            }
            const z = Hi[6] * px + Hi[7] * py + Hi[8];
            const o = r * W + X;
            ax[o] = (Hi[0] * px + Hi[1] * py + Hi[2]) / z;
            ay[o] = (Hi[3] * px + Hi[4] * py + Hi[5]) / z;
          }
        }
        const outRgba = t.add(new cv.Mat());
        cv.remap(extraRgba, outRgba, mx, my, cv.INTER_CUBIC, cv.BORDER_REPLICATE);
        const outRgb = t.add(new cv.Mat());
        cv.cvtColor(outRgba, outRgb, cv.COLOR_RGBA2RGB);
        const dst = t.add(aligned.roi(new cv.Rect(0, y0, W, rows)));
        outRgb.copyTo(dst);
      });
    }
    return { aligned, ok, method, ms: Math.round(performance.now() - t0) };
  });
}

export interface FuseResult {
  /** RGB 8UC3 — caller deletes. */
  fused: Mat;
  /** Share of the page taken from the extra shots (where the main shot had glare). */
  replacedFrac: number;
}

const WORK_LONG = 900; // resolution for the weight maps (lighting and reflections are smooth)
const TOL = 6; // brightness difference (0..255) treated as noise
const SOFT = 6; // how fast a shot loses weight as it gets brighter than the darkest one

/** Fuses page-aligned RGB shots (same size, shots[0] = main) into one without reflections. */
export function fuseShots(cv: CV, shots: Mat[]): FuseResult {
  if (shots.length === 1) return { fused: copyMat(cv, shots[0]), replacedFrac: 0 };
  return scoped((s) => {
    const W = shots[0].cols;
    const H = shots[0].rows;
    const { w, h } = smallSize(W, H, WORK_LONG);
    const area = w * h;

    // Luminance of each shot at working size (8U and 32F).
    const lum8 = shots.map((m) => {
      const small = s.add(resizeTo(cv, m, w, h, cv.INTER_AREA));
      const g = s.add(new cv.Mat());
      cv.cvtColor(small, g, cv.COLOR_RGB2GRAY);
      return g;
    });

    // Per-shot gain map R_i: matches each shot's low-frequency brightness
    // (exposure, shading, a phone shadow) to the main shot. The page content
    // is identical in every shot, so the brightness ratio is smooth except
    // where a reflection sits in one of them. A wide median of the (log)
    // ratio ignores those blobs as outliers while keeping real shading.
    const lw = Math.max(16, Math.round(w / 8));
    const lh = Math.max(16, Math.round(h / 8));
    const lowLum = lum8.map((g) => {
      const t = s.add(resizeTo(cv, g, lw, lh, cv.INTER_AREA));
      const f = s.add(new cv.Mat());
      t.convertTo(f, cv.CV_32F, 1, 1);
      return f;
    });
    const medK = odd(Math.max(lw, lh) * 0.35);
    const logRatio = (i: number) => {
      const r = s.add(new cv.Mat());
      cv.divide(lowLum[0], lowLum[i], r);
      cv.log(r, r);
      return r;
    };
    // Pass 1: wide median — robust to reflections, but blurs shadow edges.
    const coarse = shots.map((_, i) => {
      if (i === 0) return s.add(new cv.Mat(lh, lw, cv.CV_32F, new cv.Scalar(0)));
      const enc = s.add(new cv.Mat());
      logRatio(i).convertTo(enc, cv.CV_8U, 64, 128); // ln(ratio) ∈ [-2, 2] → 0..255
      cv.medianBlur(enc, enc, medK);
      const r = s.add(new cv.Mat());
      enc.convertTo(r, cv.CV_32F, 1 / 64, -2);
      return r;
    });
    // Reflection candidates from pass 1 (clearly brighter than the darkest shot).
    const normLow = lowLum.map((l, i) => {
      const e = s.add(new cv.Mat());
      cv.exp(coarse[i], e);
      const n = s.add(new cv.Mat());
      cv.multiply(l, e, n);
      return n;
    });
    let lowMin = normLow[0];
    for (const n of normLow.slice(1)) {
      const next = s.add(new cv.Mat());
      cv.min(lowMin, n, next);
      lowMin = next;
    }
    const k3 = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const glareLow = normLow.map((n) => {
      const d = s.add(new cv.Mat());
      cv.subtract(n, lowMin, d);
      const m = s.add(new cv.Mat());
      cv.threshold(d, m, 20, 255, cv.THRESH_BINARY);
      const bright = s.add(new cv.Mat());
      cv.threshold(n, bright, 150, 255, cv.THRESH_BINARY);
      cv.bitwise_and(m, bright, m);
      const m8 = s.add(new cv.Mat());
      m.convertTo(m8, cv.CV_8U);
      cv.dilate(m8, m8, k3, new cv.Point(-1, -1), 2);
      return m8;
    });
    // Pass 2: the ratio smoothed only over pixels that are reflection-free
    // in both shots (normalised convolution) — keeps shadow edges sharp.
    const sigma = Math.max(1, Math.max(lw, lh) * 0.04);
    const gains: Mat[] = shots.map((_, i) => {
      if (i === 0) return s.add(new cv.Mat(h, w, cv.CV_32F, new cv.Scalar(1)));
      const bad = s.add(new cv.Mat());
      cv.bitwise_or(glareLow[0], glareLow[i], bad);
      const valid = s.add(new cv.Mat());
      cv.bitwise_not(bad, valid);
      const vf = s.add(new cv.Mat());
      valid.convertTo(vf, cv.CV_32F, 1 / 255);
      const num = s.add(new cv.Mat());
      cv.multiply(logRatio(i), vf, num);
      cv.GaussianBlur(num, num, new cv.Size(0, 0), sigma);
      cv.GaussianBlur(vf, vf, new cv.Size(0, 0), sigma);
      const den = s.add(new cv.Mat());
      cv.max(vf, s.add(new cv.Mat(lh, lw, cv.CV_32F, new cv.Scalar(1e-3))), den);
      const fine = s.add(new cv.Mat());
      cv.divide(num, den, fine);
      // Where almost nothing nearby was usable, fall back to pass 1.
      const sparse = s.add(new cv.Mat());
      cv.threshold(vf, sparse, 0.15, 255, cv.THRESH_BINARY_INV);
      const sparse8 = s.add(new cv.Mat());
      sparse.convertTo(sparse8, cv.CV_8U);
      coarse[i].copyTo(fine, sparse8);
      cv.exp(fine, fine);
      cv.threshold(fine, fine, 2, 0, cv.THRESH_TRUNC);
      cv.max(fine, s.add(new cv.Mat(lh, lw, cv.CV_32F, new cv.Scalar(0.5))), fine);
      return s.add(resizeTo(cv, fine, w, h, cv.INTER_LINEAR));
    });

    // Normalised luminance and the per-pixel darkest shot.
    const lum = lum8.map((g, i) => {
      const f = s.add(new cv.Mat());
      g.convertTo(f, cv.CV_32F);
      cv.multiply(f, gains[i], f);
      // Blur enough that a 1–2 px misalignment of thin lines (text, staff
      // lines) between shots does not look like a brightness difference.
      cv.GaussianBlur(f, f, new cv.Size(0, 0), 3);
      return f;
    });
    let lmin = lum[0];
    for (const l of lum.slice(1)) {
      const next = s.add(new cv.Mat());
      cv.min(lmin, l, next);
      lmin = next;
    }

    // Weight per shot: 1 where it is as dark as the darkest shot, falling off
    // where it is brighter (a reflection). Only bright areas can be glare.
    const k = odd(Math.max(5, WORK_LONG / 60));
    const kernel = s.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
    const one = s.add(new cv.Mat(h, w, cv.CV_32F, new cv.Scalar(1)));
    // A reflection is also a bright patch within its own photo: brighter than
    // that photo's wide-area median at the same spot. This keeps an evenly
    // lit, clean area from being swapped for a shadowed area of another shot
    // when the brightness matching is imperfect.
    const selfGate = lum8.map((g) => {
      const t = s.add(resizeTo(cv, g, lw, lh, cv.INTER_AREA));
      cv.medianBlur(t, t, medK);
      const bg = s.add(new cv.Mat());
      s.add(resizeTo(cv, t, w, h, cv.INTER_LINEAR)).convertTo(bg, cv.CV_32F);
      const own = s.add(new cv.Mat());
      g.convertTo(own, cv.CV_32F);
      cv.GaussianBlur(own, own, new cv.Size(0, 0), 3);
      const d = s.add(new cv.Mat());
      cv.subtract(own, bg, d);
      d.convertTo(d, cv.CV_32F, 1 / 8, -3 / 8); // 0 at +3, 1 at +11 levels
      cv.threshold(d, d, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(d, d, 1, 0, cv.THRESH_TRUNC);
      return d;
    });
    const weights = lum.map((l, i) => {
      const ex = s.add(new cv.Mat());
      cv.subtract(l, lmin, ex);
      cv.threshold(ex, ex, TOL, 0, cv.THRESH_TOZERO);
      const gate = s.add(new cv.Mat());
      l.convertTo(gate, cv.CV_32F, 1 / 50, -150 / 50);
      cv.threshold(gate, gate, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(gate, gate, 1, 0, cv.THRESH_TRUNC);
      cv.multiply(ex, gate, ex);
      cv.multiply(ex, selfGate[i], ex);
      cv.dilate(ex, ex, kernel); // cover the soft rim of the reflection too
      // Narrow feather: a wide blend would average two slightly misaligned
      // photos over a broad band and look soft.
      cv.GaussianBlur(ex, ex, new cv.Size(0, 0), k / 4);
      ex.convertTo(ex, cv.CV_32F, 1 / SOFT);
      cv.multiply(ex, ex, ex);
      cv.add(ex, one, ex);
      const wgt = s.add(new cv.Mat());
      cv.divide(one, ex, wgt);
      return wgt;
    });

    // Main shot wherever it is clean; the others share the rest.
    const notMain = s.add(new cv.Mat());
    cv.subtract(one, weights[0], notMain);
    const W_ = weights.map((wgt, i) => {
      if (i === 0) return wgt;
      const m = s.add(new cv.Mat());
      cv.multiply(wgt, notMain, m);
      return m;
    });
    const sum = s.add(copyMat(cv, W_[0]));
    for (const m of W_.slice(1)) cv.add(sum, m, sum);

    const half = s.add(new cv.Mat(h, w, cv.CV_32F, new cv.Scalar(0.5)));
    const replaced = s.add(new cv.Mat());
    cv.compare(weights[0], half, replaced, cv.CMP_LT);
    const replacedFrac = cv.countNonZero(replaced) / area;

    // Combined per-shot factor C_i = (W_i / ΣW) · R_i, stored as 8U (×127)
    // and upsampled: weights and gains are smooth, so this is lossless in
    // practice and keeps memory low on phones.
    const factors = W_.map((m, i) => {
      const c = s.add(new cv.Mat());
      cv.divide(m, sum, c);
      cv.multiply(c, gains[i], c);
      const c8 = s.add(new cv.Mat());
      c.convertTo(c8, cv.CV_8U, 127);
      return s.add(resizeTo(cv, c8, W, H, cv.INTER_LINEAR));
    });

    // Blend at full resolution in horizontal strips (bounded memory).
    const fused = new cv.Mat(H, W, cv.CV_8UC3);
    const STRIP = 256;
    for (let y = 0; y < H; y += STRIP) {
      scoped((t) => {
        const rect = new cv.Rect(0, y, W, Math.min(STRIP, H - y));
        const acc = t.add(new cv.Mat(rect.height, W, cv.CV_32FC3, new cv.Scalar(0, 0, 0)));
        shots.forEach((shot, i) => {
          const roi = t.add(shot.roi(rect));
          const img = t.add(new cv.Mat());
          roi.convertTo(img, cv.CV_32FC3);
          const croi = t.add(factors[i].roi(rect));
          const c = t.add(new cv.Mat());
          croi.convertTo(c, cv.CV_32F, 1 / 127);
          const c3 = t.add(new cv.Mat());
          cv.cvtColor(c, c3, cv.COLOR_GRAY2RGB);
          cv.multiply(img, c3, img);
          cv.add(acc, img, acc);
        });
        const out = t.add(new cv.Mat());
        acc.convertTo(out, cv.CV_8UC3);
        const dst = t.add(fused.roi(rect));
        out.copyTo(dst);
      });
    }
    return { fused, replacedFrac };
  });
}
