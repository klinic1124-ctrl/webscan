// End-to-end checks of the scanning pipeline on synthetic phone photos with a
// known ground truth (corner positions, page content, lighting).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCv, type CV, type Mat } from '../src/lib/cv/loadCv';
import { detectQuad, processPage, warpQuad } from '../src/lib/cv/pipeline';
import { makeScene, type SceneOptions } from '../src/lib/cv/synthetic';
import { dist } from '../src/lib/geometry';

let cv: CV;
beforeAll(async () => {
  ({ cv } = await loadCv());
});

const A4 = 210 / 297;

const poses: SceneOptions['pose'][] = [
  { rx: 22, ry: -6, rz: 4 }, // typical: phone tilted forward
  { rx: 35, ry: 12, rz: -10 }, // strong perspective
  { rx: 5, ry: 3, rz: 25, tx: 0.15 }, // nearly flat but rotated, off-centre
  { rx: 28, ry: 0, rz: 0 }, // one vanishing point only
];

/** Fraction of pixels where two 8-bit single-channel binary images agree. */
function agreement(a: Mat, b: Mat): number {
  const da: Uint8Array = a.data;
  const db: Uint8Array = b.data;
  let same = 0;
  for (let i = 0; i < da.length; i++) if (da[i] > 127 === db[i] > 127) same++;
  return same / da.length;
}

/** Ground-truth page (RGB) → 8-bit binary at the output size (255 = paper). */
function truthMask(doc: Mat, w: number, h: number): Mat {
  const g = new cv.Mat();
  cv.cvtColor(doc, g, cv.COLOR_RGB2GRAY);
  cv.resize(g, g, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
  cv.threshold(g, g, 160, 255, cv.THRESH_BINARY);
  return g;
}

/**
 * Mean and std of blank-paper pixels (ground truth, eroded). The image is
 * blurred first so the std measures uneven lighting rather than sensor noise.
 */
function paperStats(out: Mat, truth: Mat): { mean: number; std: number } {
  const paper = new cv.Mat();
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
  cv.erode(truth, paper, k);
  const gray = new cv.Mat();
  cv.cvtColor(out, gray, out.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(0, 0), 3);
  const mean = new cv.Mat();
  const std = new cv.Mat();
  cv.meanStdDev(gray, mean, std, paper);
  const r = { mean: mean.data64F[0], std: std.data64F[0] };
  [paper, k, gray, mean, std].forEach((m) => m.delete());
  return r;
}

describe('S2 boundary detection', () => {
  for (const kind of ['text', 'music', 'photo'] as const) {
    poses.forEach((pose, i) => {
      it(`${kind} · pose ${i}: corners within 0.5 % of the diagonal`, () => {
        const sc = makeScene(cv, { kind, pose, shadow: i % 2 === 1, seed: 10 + i });
        const d = detectQuad(cv, sc.rgba);
        const diag = Math.hypot(sc.rgba.cols, sc.rgba.rows);
        const err = Math.max(...d.quad.map((p, k) => dist(p, sc.quad[k])));
        sc.rgba.delete();
        sc.doc.delete();
        expect(d.found).toBe(true);
        expect(err / diag).toBeLessThan(0.005);
      });
    });
  }

  it('reports "not found" on a photo without a document', () => {
    const sc = makeScene(cv, { kind: 'text', pose: { distance: 1000 } });
    const d = detectQuad(cv, sc.rgba);
    expect(d.found).toBe(false);
    expect(d.quad[2]).toEqual({ x: sc.rgba.cols - 1, y: sc.rgba.rows - 1 });
    sc.rgba.delete();
    sc.doc.delete();
  });
});

describe('S4 perspective + aspect', () => {
  poses.forEach((pose, i) => {
    it(`pose ${i}: recovered page ratio within 2 % of A4`, () => {
      const sc = makeScene(cv, { kind: 'text', pose });
      const r = processPage(cv, sc.rgba, sc.quad, { mode: 'gray', aspect: 'auto' });
      expect(Math.abs(r.width / r.height - A4) / A4).toBeLessThan(0.02);
      [sc.rgba, sc.doc, r.out].forEach((m) => m.delete());
    });
  });
});

describe('S5 illumination flattening', () => {
  for (const kind of ['text', 'music'] as const) {
    it(`${kind}: shadowed paper becomes even and white`, () => {
      const sc = makeScene(cv, { kind, shadow: true });
      const r = processPage(cv, sc.rgba, sc.quad, { mode: 'gray', aspect: 'a4' });
      const truth = truthMask(sc.doc, r.width, r.height);
      const after = paperStats(r.out, truth);

      const raw = warpQuad(cv, sc.rgba, sc.quad, r.width, r.height);
      const before = paperStats(raw, truth);

      expect(before.std).toBeGreaterThan(15); // the scene really is unevenly lit
      expect(after.std).toBeLessThan(4);
      expect(after.mean).toBeGreaterThan(245);
      [sc.rgba, sc.doc, r.out, truth, raw].forEach((m) => m.delete());
    });
  }
});

describe('S7 finishing modes', () => {
  it('auto picks grey for text and sheet music, photo for photos', () => {
    const expected = { text: 'gray', music: 'gray', photo: 'photo' } as const;
    for (const kind of ['text', 'music', 'photo'] as const) {
      for (const shadow of [false, true]) {
        const sc = makeScene(cv, { kind, shadow });
        const r = processPage(cv, sc.rgba, sc.quad, { mode: 'auto', aspect: 'auto' });
        expect(r.mode, `${kind} shadow=${shadow}`).toBe(expected[kind]);
        [sc.rgba, sc.doc, r.out].forEach((m) => m.delete());
      }
    }
  });

  for (const kind of ['text', 'music'] as const) {
    it(`${kind}: black & white matches the original page (≥ 97 % of pixels)`, () => {
      const sc = makeScene(cv, { kind, shadow: true });
      const r = processPage(cv, sc.rgba, sc.quad, { mode: 'bw', aspect: 'a4' });
      const g = new cv.Mat();
      cv.cvtColor(r.out, g, cv.COLOR_RGBA2GRAY);
      const truth = truthMask(sc.doc, r.width, r.height);
      expect(agreement(g, truth)).toBeGreaterThan(0.97);
      [sc.rgba, sc.doc, r.out, g, truth].forEach((m) => m.delete());
    });
  }

  it('flags blown-out reflections', () => {
    const clean = makeScene(cv, { kind: 'photo' });
    const glare = makeScene(cv, { kind: 'photo', glare: true });
    const a = processPage(cv, clean.rgba, clean.quad, { mode: 'auto', aspect: 'auto' });
    const b = processPage(cv, glare.rgba, glare.quad, { mode: 'auto', aspect: 'auto' });
    expect(a.saturatedFrac).toBeLessThan(0.002);
    expect(b.saturatedFrac).toBeGreaterThan(0.01);
    [clean.rgba, clean.doc, glare.rgba, glare.doc, a.out, b.out].forEach((m) => m.delete());
  });
});

describe('memory', () => {
  it('does not grow the WASM heap over repeated runs', () => {
    const sc = makeScene(cv, { kind: 'music', shadow: true });
    const run = () => {
      const d = detectQuad(cv, sc.rgba);
      for (const mode of ['color', 'gray', 'bw', 'photo'] as const) {
        processPage(cv, sc.rgba, d.quad, { mode, aspect: 'auto' }).out.delete();
      }
    };
    run();
    run();
    const heap = cv.HEAPU8.length;
    for (let i = 0; i < 4; i++) run();
    expect(cv.HEAPU8.length).toBe(heap);
    sc.rgba.delete();
    sc.doc.delete();
  });
});
