/// <reference lib="webworker" />
// All image processing runs here so the UI never blocks. The current source
// image stays in the worker (WASM heap) between calls.
import * as Comlink from 'comlink';
import { loadCv, type CV, type Mat } from '../lib/cv/loadCv';
import { detectQuad, processPage, resizeLong, rotateCW, type DetectResult, type ProcessOptions } from '../lib/cv/pipeline';
import { makeScene, type SampleKind } from '../lib/cv/synthetic';
import type { Quad } from '../lib/geometry';

export const MAX_SOURCE_LONG_SIDE = 4000;
const PREVIEW_LONG_SIDE = 1600;

let cv: CV | null = null;
let src: Mat | null = null;

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

async function setSource(mat: Mat, timings: Record<string, number>): Promise<SourceInfo> {
  const c = await ensureCv();
  let t = now();
  if (Math.max(mat.cols, mat.rows) > MAX_SOURCE_LONG_SIDE) {
    const r = resizeLong(c, mat, MAX_SOURCE_LONG_SIDE);
    mat.delete();
    mat = r;
    timings.downscale = round(now() - t);
  }
  src?.delete();
  src = mat;
  t = now();
  const small = resizeLong(c, src, PREVIEW_LONG_SIDE);
  const preview = await encode(small, 'image/jpeg', 0.85);
  small.delete();
  timings.preview = round(now() - t);
  return { width: src.cols, height: src.rows, preview, timings };
}

function requireSource(): Mat {
  if (!src) throw new Error('No image loaded');
  return src;
}

export interface ScanResult {
  blob: Blob;
  width: number;
  height: number;
  mode: Awaited<ReturnType<typeof processPage>>['mode'];
  aspect: Awaited<ReturnType<typeof processPage>>['aspect'];
  saturatedFrac: number;
  classify: Awaited<ReturnType<typeof processPage>>['classify'];
  timings: Record<string, number>;
}

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

  async loadBitmap(bitmap: ImageBitmap): Promise<SourceInfo> {
    const c = await ensureCv();
    const t = now();
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const mat = c.matFromImageData(data);
    return setSource(mat, { toMat: round(now() - t) });
  },

  async loadSample(kind: SampleKind): Promise<SourceInfo> {
    const c = await ensureCv();
    const t = now();
    const sc = makeScene(c, { kind, shadow: true, glare: kind === 'photo', width: 2400, height: 1800, seed: 3 });
    sc.doc.delete();
    return setSource(sc.rgba, { generate: round(now() - t) });
  },

  async rotate(): Promise<SourceInfo> {
    const c = await ensureCv();
    const t = now();
    const r = rotateCW(c, requireSource());
    return setSource(r, { rotate: round(now() - t) });
  },

  async detect(): Promise<DetectResult> {
    const c = await ensureCv();
    return detectQuad(c, requireSource());
  },

  async scan(quad: Quad, opts: ProcessOptions, format: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<ScanResult> {
    const c = await ensureCv();
    const t0 = now();
    const r = processPage(c, requireSource(), quad, opts);
    const t = now();
    // Black & white compresses far better (and stays crisp) as PNG.
    const type = r.mode === 'bw' ? 'image/png' : format;
    const blob = await encode(r.out, type, 0.92);
    r.out.delete();
    const timings = { ...r.timings, encode: round(now() - t), total: round(now() - t0) };
    return {
      blob,
      width: r.width,
      height: r.height,
      mode: r.mode,
      aspect: r.aspect,
      saturatedFrac: r.saturatedFrac,
      classify: r.classify,
      timings,
    };
  },

  async heapBytes(): Promise<number> {
    const c = await ensureCv();
    return c.HEAPU8?.length ?? 0;
  },
};

export type ScannerApi = typeof api;
Comlink.expose(api);
