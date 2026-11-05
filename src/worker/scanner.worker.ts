/// <reference lib="webworker" />
// All image processing runs here so the UI never blocks. The current photos
// of a page stay in the worker (WASM heap) between calls: shots[0] is the
// main photo, shots[1..] are extra photos used to remove reflections.
import * as Comlink from 'comlink';
import { loadCv, type CV, type Mat } from '../lib/cv/loadCv';
import { detectQuad, processPage, resizeLong, rotateCW, type DetectResult, type ProcessOptions, type ProcessResult } from '../lib/cv/pipeline';
import { makeScene, type SampleKind } from '../lib/cv/synthetic';
import type { Quad } from '../lib/geometry';

// 4096 keeps 12 MP phone photos (4032 px) at full size instead of spending
// ~0.25 s on iPhone shrinking them by 1 %.
export const MAX_SOURCE_LONG_SIDE = 4096;
/** Extra shots only fill in reflection areas; a smaller cap saves memory on phones. */
export const MAX_EXTRA_LONG_SIDE = 3072;
export const MAX_EXTRA_SHOTS = 2;
const PREVIEW_LONG_SIDE = 1600;

let cv: CV | null = null;
const shots: Mat[] = [];

const now = () => performance.now();
const round = (ms: number) => Math.round(ms * 10) / 10;

async function ensureCv(): Promise<CV> {
  if (!cv) cv = (await loadCv()).cv;
  return cv;
}

async function encode(mat: Mat, type: string, quality?: number): Promise<Blob> {
  const c = await ensureCv();
  let rgba = mat;
  if (mat.channels() !== 4) {
    rgba = new c.Mat();
    c.cvtColor(mat, rgba, mat.channels() === 1 ? c.COLOR_GRAY2RGBA : c.COLOR_RGB2RGBA);
  }
  const canvas = new OffscreenCanvas(rgba.cols, rgba.rows);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows), 0, 0);
  if (rgba !== mat) rgba.delete();
  return canvas.convertToBlob({ type, quality });
}

export interface SourceInfo {
  width: number;
  height: number;
  /** Downscaled JPEG for the crop editor (same aspect as the source). */
  preview: Blob;
  timings: Record<string, number>;
}

/**
 * Puts a photo into slot `index` (0 = main). Loading a new main photo drops
 * the extra shots of the previous page.
 */
async function setShot(index: number, mat: Mat, timings: Record<string, number>): Promise<SourceInfo> {
  const c = await ensureCv();
  let t = now();
  const cap = index === 0 ? MAX_SOURCE_LONG_SIDE : MAX_EXTRA_LONG_SIDE;
  if (Math.max(mat.cols, mat.rows) > cap) {
    const r = resizeLong(c, mat, cap);
    mat.delete();
    mat = r;
    timings.downscale = round(now() - t);
  }
  if (index === 0) {
    for (const m of shots.splice(0)) m.delete();
  } else {
    shots[index]?.delete();
  }
  shots[index] = mat;
  t = now();
  const small = resizeLong(c, mat, PREVIEW_LONG_SIDE);
  const preview = await encode(small, 'image/jpeg', 0.85);
  small.delete();
  timings.preview = round(now() - t);
  return { width: mat.cols, height: mat.rows, preview, timings };
}

function shot(index = 0): Mat {
  const m = shots[index];
  if (!m) throw new Error(index === 0 ? 'No image loaded' : `No extra photo ${index}`);
  return m;
}

async function bitmapToMat(bitmap: ImageBitmap): Promise<Mat> {
  const c = await ensureCv();
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return c.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
}

/** Sample scenes: the same page from a second angle, reflection elsewhere. */
const SAMPLE_SHOTS = [
  { pose: undefined, glareAt: { x: 0.6, y: 0.35 } },
  { pose: { rx: 30, ry: 10, rz: -2 }, glareAt: { x: 0.35, y: 0.7 } },
  { pose: { rx: 14, ry: -14, rz: 8 }, glareAt: { x: 0.7, y: 0.75 } },
];

export interface ScanResult {
  blob: Blob;
  /** Small JPEG for page lists. */
  thumb: Blob;
  width: number;
  height: number;
  mode: Awaited<ReturnType<typeof processPage>>['mode'];
  aspect: Awaited<ReturnType<typeof processPage>>['aspect'];
  saturatedFrac: number;
  classify: Awaited<ReturnType<typeof processPage>>['classify'];
  fusion?: ProcessResult['fusion'];
  timings: Record<string, number>;
}

const THUMB_LONG_SIDE = 360;

const api = {
  async init() {
    const t = now();
    const c = await ensureCv();
    const info: string = c.getBuildInformation?.() ?? '';
    const version = /Version control:\s*(\S+)/.exec(info)?.[1] ?? 'unknown';
    const simd = /SIMD/.test(info) && !/SIMD.*NO/i.test(info);
    const threads = !/USE_PTHREADS=0/.test(info);
    return { ms: round(now() - t), version, simd, threads };
  },

  /** New main photo (drops extra shots). */
  async loadBitmap(bitmap: ImageBitmap): Promise<SourceInfo> {
    const t = now();
    const mat = await bitmapToMat(bitmap);
    return setShot(0, mat, { toMat: round(now() - t) });
  },

  /** Adds another photo of the same page; returns its slot index. */
  async addShot(bitmap: ImageBitmap): Promise<SourceInfo & { index: number }> {
    if (!shots[0]) throw new Error('No image loaded');
    if (shots.length > MAX_EXTRA_SHOTS) {
      bitmap.close();
      throw new Error(`추가 사진은 ${MAX_EXTRA_SHOTS}장까지입니다`);
    }
    const t = now();
    const mat = await bitmapToMat(bitmap);
    const index = shots.length;
    return { ...(await setShot(index, mat, { toMat: round(now() - t) })), index };
  },

  async removeShot(index: number): Promise<void> {
    if (index < 1 || index >= shots.length) return;
    shots.splice(index, 1)[0].delete();
  },

  shotCount(): number {
    return shots.length;
  },

  /** Sample photo; `shot` > 0 adds the same page from another angle. */
  async loadSample(kind: SampleKind, shotIndex = 0): Promise<SourceInfo & { index: number }> {
    const c = await ensureCv();
    const t = now();
    const v = SAMPLE_SHOTS[Math.min(shotIndex, SAMPLE_SHOTS.length - 1)];
    const sc = makeScene(c, { kind, shadow: shotIndex === 0, glare: kind === 'photo', glareAt: v.glareAt, pose: v.pose, width: 2400, height: 1800, seed: 3 });
    sc.doc.delete();
    const index = shotIndex === 0 ? 0 : shots.length;
    if (index > MAX_EXTRA_SHOTS) {
      sc.rgba.delete();
      throw new Error(`추가 사진은 ${MAX_EXTRA_SHOTS}장까지입니다`);
    }
    return { ...(await setShot(index, sc.rgba, { generate: round(now() - t) })), index };
  },

  async rotate(index = 0): Promise<SourceInfo> {
    const c = await ensureCv();
    const t = now();
    const r = rotateCW(c, shot(index));
    return setShot(index, r, { rotate: round(now() - t) });
  },

  async detect(index = 0): Promise<DetectResult> {
    const c = await ensureCv();
    return detectQuad(c, shot(index));
  },

  /**
   * Processes the page. `extraQuads[i]` is the page outline in extra shot
   * i + 1; extra shots without a quad are ignored.
   */
  async scan(quad: Quad, opts: ProcessOptions, extraQuads: Quad[] = [], format: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<ScanResult> {
    const c = await ensureCv();
    const t0 = now();
    const extras = extraQuads.slice(0, shots.length - 1).map((q, i) => ({ rgba: shot(i + 1), quad: q }));
    const r = processPage(c, shot(0), quad, opts, extras);
    const t = now();
    // Black & white compresses far better (and stays crisp) as PNG.
    const type = r.mode === 'bw' ? 'image/png' : format;
    const blob = await encode(r.out, type, 0.92);
    const small = resizeLong(c, r.out, THUMB_LONG_SIDE);
    const thumb = await encode(small, 'image/jpeg', 0.8);
    small.delete();
    r.out.delete();
    const timings = { ...r.timings, encode: round(now() - t), total: round(now() - t0) };
    return {
      blob,
      thumb,
      width: r.width,
      height: r.height,
      mode: r.mode,
      aspect: r.aspect,
      saturatedFrac: r.saturatedFrac,
      classify: r.classify,
      fusion: r.fusion,
      timings,
    };
  },

  /** A photo as JPEG (used to store generated sample photos). */
  async exportSource(index = 0): Promise<Blob> {
    await ensureCv();
    return encode(shot(index), 'image/jpeg', 0.92);
  },

  async heapBytes(): Promise<number> {
    const c = await ensureCv();
    return c.HEAPU8?.length ?? 0;
  },
};

export type ScannerApi = typeof api;
Comlink.expose(api);
