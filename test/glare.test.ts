// Reflection removal from two shots of the same page. Ground truth is the
// main shot rendered again without the reflection (same pose and lighting).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv, type CV, type Mat } from '../src/lib/cv/loadCv';
import { alignExtra, fuseShots } from '../src/lib/cv/glare';
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
        const al = alignExtra(cv, A, b.rgba, b.quad);
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
        console.log(kind, { shadowB, before: before.toFixed(1), after: after.toFixed(1), elsewhere: elsewhere.toFixed(2), replacedFrac: replacedFrac.toFixed(3), aligned: al.ok, method: al.method, ms: al.ms });

        expect(before).toBeGreaterThan(40);
        expect(after).toBeLessThan(before * 0.25);
        expect(elsewhere).toBeLessThan(3);
        expect(replacedFrac).toBeGreaterThan(0.005);
        expect(replacedFrac).toBeLessThan(0.25);

        [a.rgba, a.doc, aClean.rgba, aClean.doc, b.rgba, b.doc, A, T, al.aligned, fused, gA, gT, glare, clean].forEach((m) => m.delete());
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

// Weak or broad reflections (a soft sheen rather than a blown-out spot) used
// to be taken for lighting and left in place.
describe('mild and broad reflections', () => {
  const cases = [
    { kind: 'text', size: 1, strength: 40, min: 0.8 },
    { kind: 'photo', size: 1, strength: 40, min: 0.85 },
    { kind: 'music', size: 2, strength: 70, min: 0.6 },
    { kind: 'text', size: 2, strength: 70, min: 0.6 },
    { kind: 'photo', size: 2, strength: 70, min: 0.6 },
  ] as const;
  for (const c of cases) {
    it(`${c.kind}, strength ${c.strength}, size ${c.size}: most of it removed`, () => {
      const base = { kind: c.kind, width: 1600, height: 1200, seed: 41 } as const;
      const pa = { rx: 15, ry: -4, rz: 2 };
      const a = makeScene(cv, { ...base, pose: pa, glare: true, glareAt: { x: 0.6, y: 0.35 }, glareStrength: c.strength, glareSize: c.size });
      const t = makeScene(cv, { ...base, pose: pa, glare: false });
      const b = makeScene(cv, { ...base, pose: { rx: 26, ry: 8, rz: -4 }, glare: true, glareAt: { x: 0.3, y: 0.75 }, glareStrength: c.strength, glareSize: c.size });
      const A = rgbWarp(a.rgba, a.quad);
      const T = rgbWarp(t.rgba, t.quad);
      const al = alignExtra(cv, A, b.rgba, b.quad);
      const { fused } = fuseShots(cv, [A, al.aligned]);
      const gA = new cv.Mat();
      const gT = new cv.Mat();
      cv.cvtColor(A, gA, cv.COLOR_RGB2GRAY);
      cv.cvtColor(T, gT, cv.COLOR_RGB2GRAY);
      cv.GaussianBlur(gA, gA, new cv.Size(0, 0), 1.5);
      cv.GaussianBlur(gT, gT, new cv.Size(0, 0), 1.5);
      const m = new cv.Mat();
      cv.absdiff(gA, gT, m);
      cv.threshold(m, m, 8, 255, cv.THRESH_BINARY);
      const before = meanDiff(A, T, m);
      const after = meanDiff(fused, T, m);
      expect(1 - after / before).toBeGreaterThan(c.min);
      [a.rgba, a.doc, t.rgba, t.doc, b.rgba, b.doc, A, T, al.aligned, fused, gA, gT, m].forEach((x) => x.delete());
    });
  }
});

describe('user-adjustable sensitivity', () => {
  it('default (50) keeps the tuned behaviour; more sensitive replaces more', () => {
    const base = { kind: 'text', width: 1600, height: 1200, seed: 41 } as const;
    const pa = { rx: 15, ry: -4, rz: 2 };
    const a = makeScene(cv, { ...base, pose: pa, glare: true, glareAt: { x: 0.6, y: 0.35 }, glareStrength: 70, glareSize: 2 });
    const b = makeScene(cv, { ...base, pose: { rx: 26, ry: 8, rz: -4 }, glare: true, glareAt: { x: 0.3, y: 0.75 }, glareStrength: 70, glareSize: 2 });
    const A = rgbWarp(a.rgba, a.quad);
    const al = alignExtra(cv, A, b.rgba, b.quad);
    const fracs = [0, 25, 50, 75, 100].map((sens) => {
      const f = fuseShots(cv, [A, al.aligned], { sensitivity: sens, withMask: sens === 50 });
      if (f.mask) {
        // mask = share taken from the other shot, same aspect as the page
        expect(f.mask.type()).toBe(cv.CV_8UC1);
        expect(Math.abs(f.mask.cols / f.mask.rows - A.cols / A.rows)).toBeLessThan(0.01);
        f.mask.delete();
      }
      f.fused.delete();
      return f.replacedFrac;
    });
    const dflt = fuseShots(cv, [A, al.aligned]);
    expect(dflt.replacedFrac).toBe(fracs[2]);
    for (let i = 1; i < fracs.length; i++) expect(fracs[i]).toBeGreaterThanOrEqual(fracs[i - 1]);
    expect(fracs[4]).toBeGreaterThan(fracs[0] * 1.5);
    [a.rgba, a.doc, b.rgba, b.doc, A, al.aligned, dflt.fused].forEach((x) => x.delete());
  });
});

// Main photo lit unevenly (gradient + phone shadow), extra photo evenly lit:
// a smooth brightness model cannot follow that, and once swapped clean
// areas for darker ones (a grey band along the page edge).
describe('very different lighting between the photos', () => {
  // 25..75 is the old full range; the ends beyond are deliberately extreme
  // (0: blown-out only, 100: darkest-pixel composite).
  for (const sens of [25, 50, 75]) {
    it(`sensitivity ${sens}: reflection removed, clean areas untouched`, () => {
      const a = makeScene(cv, { kind: 'photo', shadow: true, glare: true, glareAt: { x: 0.6, y: 0.35 }, width: 2400, height: 1800, seed: 3 });
      const t = makeScene(cv, { kind: 'photo', shadow: true, glare: false, width: 2400, height: 1800, seed: 3 });
      const b = makeScene(cv, { kind: 'photo', shadow: false, glare: true, glareAt: { x: 0.35, y: 0.7 }, pose: { rx: 30, ry: 10, rz: -2 }, width: 2400, height: 1800, seed: 3 });
      const qa = detectQuad(cv, a.rgba).quad;
      const qb = detectQuad(cv, b.rgba).quad;
      const warp = (m: Mat) => {
        const w = warpQuad(cv, m, qa, 1054, 1491);
        const r = new cv.Mat();
        cv.cvtColor(w, r, cv.COLOR_RGBA2RGB);
        w.delete();
        return r;
      };
      const A = warp(a.rgba);
      const T = warp(t.rgba);
      const al = alignExtra(cv, A, b.rgba, qb);
      const { fused } = fuseShots(cv, [A, al.aligned], { sensitivity: sens });
      const gA = new cv.Mat();
      const gT = new cv.Mat();
      cv.cvtColor(A, gA, cv.COLOR_RGB2GRAY);
      cv.cvtColor(T, gT, cv.COLOR_RGB2GRAY);
      cv.GaussianBlur(gA, gA, new cv.Size(0, 0), 1.5);
      cv.GaussianBlur(gT, gT, new cv.Size(0, 0), 1.5);
      const glare = new cv.Mat();
      cv.absdiff(gA, gT, glare);
      cv.threshold(glare, glare, 8, 255, cv.THRESH_BINARY);
      const clean = new cv.Mat();
      cv.bitwise_not(glare, clean);
      expect(meanDiff(fused, T, glare)).toBeLessThan(5);
      expect(meanDiff(fused, T, clean)).toBeLessThan(1.5);
      [a.rgba, a.doc, t.rgba, t.doc, b.rgba, b.doc, A, T, al.aligned, fused, gA, gT, glare, clean].forEach((x) => x.delete());
    });
  }
});

// Deep phone shadow in the second photo: its darker area must not be taken
// for "the main photo is brighter = reflection" at the default sensitivity.
it('default sensitivity: a deep shadow in the second photo is not swapped in', () => {
  const base = { kind: 'music', width: 1600, height: 1200, seed: 41 } as const;
  const a = makeScene(cv, { ...base, pose: { rx: 15, ry: -4, rz: 2 }, glare: true, glareAt: { x: 0.6, y: 0.35 } });
  const t = makeScene(cv, { ...base, pose: { rx: 15, ry: -4, rz: 2 }, glare: false });
  const b = makeScene(cv, { ...base, pose: { rx: 26, ry: 8, rz: -4 }, glare: true, glareAt: { x: 0.3, y: 0.75 }, shadow: true });
  const A = rgbWarp(a.rgba, a.quad);
  const T = rgbWarp(t.rgba, t.quad);
  const al = alignExtra(cv, A, b.rgba, b.quad);
  const { fused } = fuseShots(cv, [A, al.aligned]);
  const gA = new cv.Mat();
  const gT = new cv.Mat();
  cv.cvtColor(A, gA, cv.COLOR_RGB2GRAY);
  cv.cvtColor(T, gT, cv.COLOR_RGB2GRAY);
  cv.GaussianBlur(gA, gA, new cv.Size(0, 0), 1.5);
  cv.GaussianBlur(gT, gT, new cv.Size(0, 0), 1.5);
  const glare = new cv.Mat();
  cv.absdiff(gA, gT, glare);
  cv.threshold(glare, glare, 8, 255, cv.THRESH_BINARY);
  const clean = new cv.Mat();
  cv.bitwise_not(glare, clean);
  expect(meanDiff(fused, T, clean)).toBeLessThan(1);
  expect(1 - meanDiff(fused, T, glare) / meanDiff(A, T, glare)).toBeGreaterThan(0.85);
  [a.rgba, a.doc, t.rgba, t.doc, b.rgba, b.doc, A, T, al.aligned, fused, gA, gT, glare, clean].forEach((x) => x.delete());
});
