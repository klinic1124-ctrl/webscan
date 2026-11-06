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
      // Flow is only measurable where there is texture; in flat areas (sky,
      // blank paper) it drifts. Weight by edge strength so flat areas take
      // their correction from the nearest edges instead.
      const blurred = s.add(new cv.Mat());
      cv.GaussianBlur(g0, blurred, new cv.Size(0, 0), 1.2);
      const gx = s.add(new cv.Mat());
      const gy = s.add(new cv.Mat());
      cv.Sobel(blurred, gx, cv.CV_32F, 1, 0, 3);
      cv.Sobel(blurred, gy, cv.CV_32F, 0, 1, 3);
      const mag = s.add(new cv.Mat());
      cv.magnitude(gx, gy, mag);
      mag.convertTo(mag, cv.CV_32F, 1 / 40); // full weight from a clear edge
      cv.threshold(mag, mag, 1, 0, cv.THRESH_TRUNC);
      cv.multiply(vf, mag, vf);
      // Per-pixel sanity: drop vectors longer than 3 % of the page (lost track).
      const limit = 0.03 * Math.max(w, h);
      const raw: Float32Array = fl.data32F;
      const vw: Float32Array = vf.data32F;
      let usable = 0;
      for (let i = 0; i < vw.length; i++) {
        if (Math.hypot(raw[2 * i], raw[2 * i + 1]) > limit) vw[i] = 0;
        else if (vw[i] > 0.2) usable++;
      }
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
      // Far from any edge the smoothed field fades to 0 (= homography only).
      const dd: Float32Array = den.data32F;
      const fade = (v: number) => Math.min(1, v / 0.02);
      if (usable > 0.005 * vw.length) {
        flow = new Float32Array(w * h * 2);
        for (let i = 0; i < w * h; i++) {
          const k = fade(dd[i]);
          flow[2 * i] = comps[0][i] * k;
          flow[2 * i + 1] = comps[1][i] * k;
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
  /**
   * How much of each pixel came from the extra shots (8UC1, 0..255) at
   * working resolution, same aspect as the page — caller deletes. Only when
   * requested.
   */
  mask?: Mat;
}

const WORK_LONG = 900; // resolution for the weight maps (lighting and reflections are smooth)

/** The numbers that decide what counts as a reflection. */
export interface GlareParams {
  /** Brightness difference (0..255) to the darkest shot treated as noise. */
  tol: number;
  /** How fast a shot loses weight as it gets brighter than the darkest one. */
  soft: number;
  /** Self-brightness gate: 0 at `selfLo`, 1 at `selfHi` levels above the shot's own baseline. */
  selfLo: number;
  selfHi: number;
  /** Brightness floor: no glare below `floorLo`, fully possible from `floorHi`. */
  floorLo: number;
  floorHi: number;
  /**
   * Smallest extent (fraction of the page) of a brightness difference that is
   * still treated as lighting rather than a reflection. Broad sheen and broad
   * lighting differences look alike; small values play safe.
   */
  lightScale: number;
}

const lerp3 = (t: number, a: number, b: number, c: number) => (t <= 0.5 ? a + (b - a) * (t / 0.5) : b + (c - b) * ((t - 0.5) / 0.5));

/**
 * Detection parameters for a user-facing sensitivity 0..100. 50 is the
 * tuned default; lower only takes clear reflections, higher also takes
 * faint sheen (and risks replacing areas that were merely a bit brighter).
 */
export function glareParams(sensitivity = 50): GlareParams {
  const t = Math.min(1, Math.max(0, sensitivity / 100));
  return {
    tol: lerp3(t, 12, 6, 2),
    soft: lerp3(t, 10, 6, 3),
    selfLo: lerp3(t, 8, 3, -6),
    selfHi: lerp3(t, 18, 11, 2),
    floorLo: lerp3(t, 100, 60, 30),
    floorHi: lerp3(t, 150, 100, 60),
    lightScale: lerp3(t, 0.04, 0.1, 0.3),
  };
}

/** Fuses page-aligned RGB shots (same size, shots[0] = main) into one without reflections. */
export function fuseShots(cv: CV, shots: Mat[], opts: { sensitivity?: number; withMask?: boolean } = {}): FuseResult {
  if (shots.length === 1) return { fused: copyMat(cv, shots[0]), replacedFrac: 0 };
  const P = glareParams(opts.sensitivity);
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

    // Per-shot gain map R_i: matches each shot's brightness (exposure,
    // overall lighting gradient) to the main shot. It is deliberately a
    // smooth page-wide surface — log ratio fitted by a robust quadratic — so
    // a reflection, even a broad soft sheen, cannot be absorbed as "lighting":
    // it is an outlier to the fit. Local shading such as a phone shadow is
    // not modelled here; the self-brightness gate below keeps a clean area
    // of the main shot from being replaced by a shadowed one.
    const lw = Math.max(16, Math.round(w / 8));
    const lh = Math.max(16, Math.round(h / 8));
    const lowLum = lum8.map((g) => s.add(resizeTo(cv, g, lw, lh, cv.INTER_AREA)));
    // Page-wide exposure ratio per shot (one number, robust median of the
    // log ratio): used for a second, conservative brightness comparison.
    const globalGain = shots.map((_, i) => {
      if (i === 0) return 1;
      const a: Uint8Array = lowLum[0].data;
      const b: Uint8Array = lowLum[i].data;
      const r: number[] = [];
      for (let k = 0; k < a.length; k++) if (a[k] > 12 && b[k] > 12 && a[k] < 248 && b[k] < 248) r.push(Math.log(a[k] / b[k]));
      r.sort((p, q) => p - q);
      return r.length ? Math.exp(r[Math.floor(r.length / 2)]) : 1;
    });
    // Stage 1: smooth page-wide model (robust quadratic of the log ratio).
    // It cannot absorb a reflection, so it is used to find candidates.
    const quadLog: Float32Array[] = shots.map((_, i) => {
      const out = new Float32Array(lw * lh);
      if (i === 0) return out;
      const { coef } = robustQuadratic(lowLum[0].data as Uint8Array, lowLum[i].data as Uint8Array, lw, lh);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) out[y * lw + x] = quadAt(coef, x, y, lw, lh);
      return out;
    });
    const L: Uint8Array[] = lowLum.map((m) => m.data as Uint8Array);
    const n = lw * lh;
    const cand: Uint8Array[] = shots.map(() => new Uint8Array(n));
    for (let k = 0; k < n; k++) {
      let mn = Infinity;
      const v = shots.map((_, i) => L[i][k] * Math.exp(quadLog[i][k]));
      for (const x of v) mn = Math.min(mn, x);
      v.forEach((x, i) => {
        if (x - mn > Math.max(8, P.tol)) cand[i][k] = 1;
      });
    }
    // Stage 2: local brightness ratio from pixels that are candidates in
    // neither shot (normalised convolution). Follows real lighting — a
    // gradient, a phone shadow — closely, so swapped-in pixels get the right
    // brightness and lighting differences stop looking like reflections.
    const sigmaL = Math.max(1.2, Math.max(lw, lh) * P.lightScale);
    const gains: Mat[] = shots.map((_, i) => {
      if (i === 0) return s.add(new cv.Mat(h, w, cv.CV_32F, new cv.Scalar(1)));
      const r = s.add(new cv.Mat(lh, lw, cv.CV_32F));
      const vw = s.add(new cv.Mat(lh, lw, cv.CV_32F));
      const rd: Float32Array = r.data32F;
      const wd: Float32Array = vw.data32F;
      for (let k = 0; k < n; k++) {
        const a = L[0][k];
        const b = L[i][k];
        const ok = !cand[0][k] && !cand[i][k] && a > 12 && b > 12 && a < 248 && b < 248;
        wd[k] = ok ? 1 : 0;
        rd[k] = ok ? Math.log(a / b) : 0;
      }
      cv.GaussianBlur(r, r, new cv.Size(0, 0), sigmaL);
      cv.GaussianBlur(vw, vw, new cv.Size(0, 0), sigmaL);
      const q = quadLog[i];
      for (let k = 0; k < n; k++) {
        // blend towards the smooth model where little was usable nearby
        const t = Math.min(1, wd[k] / 0.3);
        const local = wd[k] > 1e-4 ? rd[k] / wd[k] : q[k];
        rd[k] = Math.min(2, Math.max(0.5, Math.exp(t * local + (1 - t) * q[k])));
      }
      return s.add(resizeTo(cv, r, w, h, cv.INTER_LINEAR));
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
    // The same with only the page-wide exposure corrected. A reflection
    // only adds light, so a reflecting shot must be brighter here too; this
    // stops a smooth-model mismatch (a shot lit very differently) from
    // passing as a reflection.
    const lumG = lum8.map((g, i) => {
      const f = s.add(new cv.Mat());
      g.convertTo(f, cv.CV_32F, globalGain[i]);
      cv.GaussianBlur(f, f, new cv.Size(0, 0), 3);
      return f;
    });
    let lminG = lumG[0];
    for (const l of lumG.slice(1)) {
      const next = s.add(new cv.Mat());
      cv.min(lminG, l, next);
      lminG = next;
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
      cv.medianBlur(t, t, odd(Math.max(lw, lh) * 0.7)); // wide: a broad sheen must not lift its own baseline
      const bg = s.add(new cv.Mat());
      s.add(resizeTo(cv, t, w, h, cv.INTER_LINEAR)).convertTo(bg, cv.CV_32F);
      const own = s.add(new cv.Mat());
      g.convertTo(own, cv.CV_32F);
      cv.GaussianBlur(own, own, new cv.Size(0, 0), 3);
      const d = s.add(new cv.Mat());
      cv.subtract(own, bg, d);
      d.convertTo(d, cv.CV_32F, 1 / (P.selfHi - P.selfLo), -P.selfLo / (P.selfHi - P.selfLo));
      cv.threshold(d, d, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(d, d, 1, 0, cv.THRESH_TRUNC);
      return d;
    });
    const weights = lum.map((l, i) => {
      const ex = s.add(new cv.Mat());
      cv.subtract(l, lmin, ex);
      cv.threshold(ex, ex, P.tol, 0, cv.THRESH_TOZERO);
      // Conservative check (exposure-only matching): 0 at ≤ 0, 1 from +tol.
      const exG = s.add(new cv.Mat());
      cv.subtract(lumG[i], lminG, exG);
      exG.convertTo(exG, cv.CV_32F, 1 / P.tol);
      cv.threshold(exG, exG, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(exG, exG, 1, 0, cv.THRESH_TRUNC);
      cv.multiply(ex, exG, ex);
      // Very dark areas are left alone (noise); see GlareParams.floorLo/Hi.
      const gate = s.add(new cv.Mat());
      l.convertTo(gate, cv.CV_32F, 1 / (P.floorHi - P.floorLo), -P.floorLo / (P.floorHi - P.floorLo));
      cv.threshold(gate, gate, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(gate, gate, 1, 0, cv.THRESH_TRUNC);
      cv.multiply(ex, gate, ex);
      cv.multiply(ex, selfGate[i], ex);
      // Blank white in every shot (margins, white borders): nothing to
      // recover there, and tiny brightness-matching errors would otherwise
      // swap white for white. No replacement where even the darkest shot is
      // ≥ 244, full from 232 down.
      const blank = s.add(new cv.Mat());
      lmin.convertTo(blank, cv.CV_32F, -1 / 12, 244 / 12);
      cv.threshold(blank, blank, 0, 0, cv.THRESH_TOZERO);
      cv.threshold(blank, blank, 1, 0, cv.THRESH_TRUNC);
      cv.multiply(ex, blank, ex);
      // Page edges: shots rarely line up exactly there and a sliver of table
      // can creep in, which reads as a brightness difference. Reflections
      // that matter are not confined to a 1.5 % rim, so leave it alone.
      const rim = Math.max(2, Math.round(0.015 * Math.max(w, h)));
      cv.rectangle(ex, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(0), 2 * rim);
      cv.dilate(ex, ex, kernel); // cover the soft rim of the reflection too
      // Narrow feather: a wide blend would average two slightly misaligned
      // photos over a broad band and look soft.
      cv.GaussianBlur(ex, ex, new cv.Size(0, 0), k / 4);
      ex.convertTo(ex, cv.CV_32F, 1 / P.soft);
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
    let mask: Mat | undefined;
    if (opts.withMask) {
      mask = new cv.Mat();
      notMain.convertTo(mask, cv.CV_8U, 255);
    }

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
    return { fused, replacedFrac, mask };
  });
}

// ---------------------------------------------------------------------------
// Robust smooth brightness model between two shots

/** Value of the quadratic surface c·[1,u,v,u²,uv,v²] at pixel (x, y), u,v ∈ [-1, 1]. */
function quadAt(c: number[], x: number, y: number, w: number, h: number): number {
  const u = (2 * x) / (w - 1) - 1;
  const v = (2 * y) / (h - 1) - 1;
  return c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
}

/** Solves the 6×6 system A·x = b (Gaussian elimination, partial pivoting). */
function solve6(A: number[][], b: number[]): number[] | null {
  const n = 6;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/**
 * Fits log(main / other) with a quadratic surface over the page using
 * iteratively reweighted least squares (Tukey biweight). Blown-out and
 * near-black pixels are left out. Reflections are local, so they end up as
 * outliers with zero weight.
 */
export function robustQuadratic(main: Uint8Array, other: Uint8Array, w: number, h: number): { coef: number[]; scale: number } {
  const ys: number[] = [];
  const feats: number[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = main[y * w + x];
      const b = other[y * w + x];
      if (a > 248 || b > 248 || a < 12 || b < 12) continue;
      const u = (2 * x) / (w - 1) - 1;
      const v = (2 * y) / (h - 1) - 1;
      feats.push([1, u, v, u * u, u * v, v * v]);
      ys.push(Math.log(a / b));
    }
  }
  if (ys.length < 30) return { coef: [0, 0, 0, 0, 0, 0], scale: 0 };
  let wts = new Array(ys.length).fill(1);
  let coef = [0, 0, 0, 0, 0, 0];
  let scale = 0;
  for (let it = 0; it < 8; it++) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const bv = new Array(6).fill(0);
    for (let i = 0; i < ys.length; i++) {
      const f = feats[i];
      const wi = wts[i];
      if (!wi) continue;
      for (let r = 0; r < 6; r++) {
        bv[r] += wi * f[r] * ys[i];
        for (let c = 0; c < 6; c++) A[r][c] += wi * f[r] * f[c];
      }
    }
    for (let d = 0; d < 6; d++) A[d][d] += 1e-6;
    const next = solve6(A, bv);
    if (!next) break;
    coef = next;
    const res = ys.map((y, i) => y - feats[i].reduce((acc, f, k) => acc + f * coef[k], 0));
    const abs = res.map(Math.abs).sort((p, q) => p - q);
    scale = Math.max(0.01, 1.4826 * abs[Math.floor(abs.length / 2)]);
    const cut = 4.685 * scale;
    wts = res.map((r) => (Math.abs(r) < cut ? (1 - (r / cut) ** 2) ** 2 : 0));
  }
  return { coef, scale };
}
