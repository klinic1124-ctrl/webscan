// Sharpness of reflection removal when the extra photo was taken from a very
// different angle and its corners were set a few pixels off (as by hand).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv, type CV, type Mat } from '../src/lib/cv/loadCv';
import { alignExtra, fuseShots } from '../src/lib/cv/glare';
import { warpQuad } from '../src/lib/cv/pipeline';
import { makeScene, type SampleKind } from '../src/lib/cv/synthetic';
import type { Quad } from '../src/lib/geometry';

let cv: CV;
beforeAll(async () => {
  ({ cv } = await loadCv());
});

const SIZE = { w: 1260, h: 1782 }; // ~ what a 12 MP photo of an A4 page gives, scaled
const poseA = { rx: 15, ry: -4, rz: 2 };
const steepB = { rx: 40, ry: 24, rz: -7, tx: 0.08 };

function grayOf(m: Mat): Mat {
  const g = new cv.Mat();
  cv.cvtColor(m, g, m.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  return g;
}

/** Mean |Laplacian| inside mask: fine detail. */
function detail(m: Mat, mask: Mat): number {
  const g = grayOf(m);
  const lap = new cv.Mat();
  cv.Laplacian(g, lap, cv.CV_32F, 3);
  const abs = new cv.Mat();
  cv.convertScaleAbs(lap, abs);
  const v = cv.mean(abs, mask)[0];
  [g, lap, abs].forEach((x) => x.delete());
  return v;
}

function mae(a: Mat, b: Mat, mask: Mat): number {
  const ga = grayOf(a);
  const gb = grayOf(b);
  const d = new cv.Mat();
  cv.absdiff(ga, gb, d);
  const v = cv.mean(d, mask)[0];
  [ga, gb, d].forEach((x) => x.delete());
  return v;
}

/** Corner error like a careful manual adjustment: up to ~5 px on a 1600 px photo. */
const nudge = (q: Quad): Quad => q.map((p, i) => ({ x: p.x + [4, -3, 5, -4][i], y: p.y + [-3, 4, 2, -5][i] })) as Quad;

const cases: { kind: SampleKind; bend: number; maxErr: number }[] = [
  { kind: 'music', bend: 0, maxErr: 12 },
  { kind: 'photo', bend: 0, maxErr: 6 },
  // Paper not lying flat in the second photo: only the dense flow step can
  // follow that (a single homography left ~10 px of misalignment).
  { kind: 'music', bend: 8, maxErr: 16 },
  { kind: 'text', bend: 8, maxErr: 18 },
];

for (const { kind, bend, maxErr } of cases) {
  describe(`steep second shot · ${kind}${bend ? ` · paper bent ${bend}px` : ''}`, () => {
    it('fills the reflection sharply and without ghosting', () => {
      const base = { kind, width: 1600, height: 1200, seed: 31 } as const;
      const a = makeScene(cv, { ...base, pose: poseA, glare: true, glareAt: { x: 0.6, y: 0.35 } });
      const t = makeScene(cv, { ...base, pose: poseA, glare: false });
      const b = makeScene(cv, { ...base, pose: steepB, glare: true, glareAt: { x: 0.3, y: 0.75 }, bend });

      const warp = (m: Mat, q: Quad) => {
        const w = warpQuad(cv, m, q, SIZE.w, SIZE.h);
        const r = new cv.Mat();
        cv.cvtColor(w, r, cv.COLOR_RGBA2RGB);
        w.delete();
        return r;
      };
      const A = warp(a.rgba, a.quad);
      const T = warp(t.rgba, t.quad);
      const al = alignExtra(cv, A, b.rgba, nudge(b.quad));
      const { fused } = fuseShots(cv, [A, al.aligned]);

      // Region: where the main shot's reflection was (from truth), slightly grown.
      const gA = grayOf(A);
      const gT = grayOf(T);
      const m = new cv.Mat();
      cv.absdiff(gA, gT, m);
      cv.GaussianBlur(m, m, new cv.Size(0, 0), 3);
      cv.threshold(m, m, 20, 255, cv.THRESH_BINARY);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
      cv.dilate(m, m, k);

      const sharp = detail(fused, m) / detail(T, m);
      const err = mae(fused, T, m);
      console.log(kind, { sharp: sharp.toFixed(2), err: err.toFixed(1), aligned: al.ok, method: al.method, ms: al.ms });

      expect(sharp).toBeGreaterThan(0.7);
      expect(err).toBeLessThan(maxErr);
      [a.rgba, a.doc, t.rgba, t.doc, b.rgba, b.doc, A, T, al.aligned, fused, gA, gT, m, k].forEach((x) => x.delete());
    });
  });
}
