// Browser OCR client: Tesseract.js in its own worker, everything served by
// this app under ocr/ (see the ocrFiles plugin in vite.config.ts) — no CDN.
// Model files are downloaded on first use only and then kept by the
// browser (Tesseract's IndexedDB cache and the service worker).
import { createWorker, type Worker } from 'tesseract.js';
import { OCR_LANGS, OCR_VERSION, ocrScale, toOcrPage } from './lib/ocr';
import type { OcrPage } from './lib/textLayer';

export type OcrProgress = (stage: 'loading' | 'reading', fraction: number) => void;

let worker: Promise<Worker> | null = null;
let progress: OcrProgress | null = null;

function base(): string {
  return new URL('ocr/', document.baseURI).href;
}

function engine(): Promise<Worker> {
  if (!worker) {
    worker = createWorker(OCR_LANGS, 1, {
      workerPath: `${base()}worker.min.js`,
      corePath: `${base()}tesseract-core-simd-lstm.js`,
      langPath: `${base()}lang`,
      workerBlobURL: false,
      gzip: true,
      logger: (m: { status: string; progress: number }) => {
        if (!progress) return;
        if (m.status === 'recognizing text') progress('reading', m.progress);
        else if (/loading|initializ/.test(m.status)) progress('loading', m.progress);
      },
    }).catch((e) => {
      worker = null;
      throw e;
    });
  }
  return worker;
}

/** Reads the text of one page image (w×h px). */
export async function recognizePage(image: Blob, w: number, h: number, onProgress?: OcrProgress): Promise<OcrPage & { v: number }> {
  progress = onProgress ?? null;
  try {
    const wk = await engine();
    const scale = ocrScale(w, h);
    const input = scale > 1 ? await enlarge(image, Math.round(w * scale), Math.round(h * scale)) : image;
    const { data } = await wk.recognize(input, {}, { blocks: true, text: false });
    return { ...toOcrPage(data as never, w, h, scale), v: OCR_VERSION };
  } finally {
    progress = null;
  }
}

async function enlarge(image: Blob, w: number, h: number): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(image);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return c;
}

/** Frees the OCR engine's memory (it is re-created on next use). */
export async function closeOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate();
}
