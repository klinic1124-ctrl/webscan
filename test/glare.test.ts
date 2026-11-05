// Reflection removal from two shots of the same page. Ground truth is the
// main shot rendered again without the reflection (same pose and lighting).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv, type CV, type Mat } from '../src/lib/cv/loadCv';
import { alignShot, fuseShots } from '../src/lib/cv/glare';
import { detectQuad, processPage, warpQuad } from '../src/lib/cv/pipeline';
import { makeScene, type SampleKind } from '../src/lib/cv/synthetic';
import type { Quad } from '../src/lib/geometry';

let cv: CV;
beforeAll(async () => {
  ({ cv } = await loadCv());
});

const SIZE = { w: 840, h: 1188 };
const poseA = { rx: 18, ry: -5, rz: 3 };
const poseB = { rx: 26, ry: 8, rz: -4, tx: 0.05 };

function rgbWarp(rgba: Mat, quad: Quad): Mat {
  const w = warpQuad(cv, rgba, quad, SIZE.w, SIZE.h);
  const rgb = new cv.Mat();
  cv.cvtColor(w, rgb, cv.COLOR_RGBA2RGB);
  w.delete();
  return rgb;
}

/**
 * Mean absolute grey difference of a and b inside/outside a mask. Both are
 * blurred slightly so a sub-pixel shift of thin lines (unavoidable after two
 * different warps) does not count as a difference.
 */
function meanDiff(a: Mat, b: Mat, mask: Mat | null): number {
  const ga = new cv.Mat();
  const gb = new cv.Mat();
  cv.cvtColor(a, ga, cv.COLOR_RGB2GRAY);
  cv.cvtColor(b, gb, cv.COLOR_RGB2GRAY);
  cv.GaussianBlur(ga, ga, new cv.Size(0, 0), 1.5);
  cv.GaussianBlur(gb, gb, new cv.Size(0, 0), 1.5);
  const d = new cv.Mat();
  cv.absdiff(ga, gb, d);
  const m = mask ? cv.mean(d, mask)[0] : cv.mean(d)[0];
  [ga, gb, d].forEach((x) => x.delete());
  return m;
}

function scenes(kind: SampleKind, shadowB = false) {
  const base = { kind, width: 1600, height: 1200, seed: 21 } as const;
  const a = makeScene(cv, { ...base, pose: poseA, glare: true, glareAt: { x: 0.6, y: 0.35 } });
  const aClean = makeScene(cv, { ...base, pose: poseA, glare: false });
  const b = makeScene(cv, { ...base, pose: poseB, glare: true, glareAt: { x: 0.3, y: 0.7 }, shadow: shadowB });
  return { a, aClean, b };
}

describe('reflection removal (two shots)', () => {
  for (const kind of ['photo', 'music'] as const) {
    for (const shadowB of [false, true]) {
      it(`${kind}${shadowB ? ', second shot shadowed' : ''}: glare replaced, rest untouched`, () => {
        const { a, aClean, b } = scenes(kind, shadowB);
        const A = rgbWarp(a.rgba, a.quad);
        const T = rgbWarp(aClean.rgba, aClean.quad);
        const B0 = rgbWarp(b.rgba, b.quad);
        const al = alignShot(cv, A, B0);
        const { fused, replacedFrac } = fuseShots(cv, [A, al.aligned]);

        // Where the main shot has its reflection.
        const gA = new cv.Mat();
        const gT = new cv.Mat();
        cv.cvtColor(A, gA, cv.COLOR_RGB2GRAY);
        cv.cvtColor(T, gT, cv.COLOR_RGB2GRAY);
        cv.GaussianBlur(gA, gA, new cv.Size(0, 0), 1.5);
        cv.GaussianBlur(gT, gT, new cv.Size(0, 0), 1.5);
        const glare = new cv.Mat();
        cv.absdiff(gA, gT, glare);
        cv.threshold(glare, glare, 30, 255, cv.THRESH_BINARY);
        const clean = new cv.Mat();
        cv.bitwise_not(glare, clean);

        const before = meanDiff(A, T, glare);
        const after = meanDiff(fused, T, glare);
        const elsewhere = meanDiff(fused, T, clean);
        console.log(kind, { shadowB, before: before.toFixed(1), after: after.toFixed(1), elsewhere: elsewhere.toFixed(2), replacedFrac: replacedFrac.toFixed(3), aligned: al.ok, inliers: al.inliers });

        expect(before).toBeGreaterThan(40);
        expect(after).toBeLessThan(before * 0.25);
        expect(elsewhere).toBeLessThan(3);
        expect(replacedFrac).toBeGreaterThan(0.005);
        expect(replacedFrac).toBeLessThan(0.25);

        [a.rgba, a.doc, aClean.rgba, aClean.doc, b.rgba, b.doc, A, T, B0, al.aligned, fused, gA, gT, glare, clean].forEach((m) => m.delete());
      });
    }
  }

  it('end to end with detected corners: less blown-out area than a single shot', () => {
    const { a, aClean, b } = scenes('photo');
    const qa = detectQuad(cv, a.rgba).quad;
    const qb = detectQuad(cv, b.rgba).quad;
    const single = processPage(cv, a.rgba, qa, { mode: 'photo', aspect: 'auto' });
    const fused = processPage(cv, a.rgba, qa, { mode: 'photo', aspect: 'auto' }, [{ rgba: b.rgba, quad: qb }]);
    console.log('e2e', { single: single.saturatedFrac.toFixed(4), fused: fused.saturatedFrac.toFixed(4), fusion: fused.fusion, t: fused.timings });
    expect(fused.fusion?.shots).toBe(2);
    expect(single.saturatedFrac).toBeGreaterThan(0.01);
    expect(fused.saturatedFrac).toBeLessThan(single.saturatedFrac * 0.2);
    [a.rgba, a.doc, aClean.rgba, aClean.doc, b.rgba, b.doc, single.out, fused.out].forEach((m) => m.delete());
  });

  it('does not leak WASM memory', () => {
    const { a, aClean, b } = scenes('music');
    const run = () => processPage(cv, a.rgba, a.quad, { mode: 'gray', aspect: 'auto' }, [{ rgba: b.rgba, quad: b.quad }]).out.delete();
    run();
    run();
    const heap = cv.HEAPU8.length;
    for (let i = 0; i < 3; i++) run();
    expect(cv.HEAPU8.length).toBe(heap);
    [a.rgba, a.doc, aClean.rgba, aClean.doc, b.rgba, b.doc].forEach((m) => m.delete());
  });
});
