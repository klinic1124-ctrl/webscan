// Real Tesseract (kor+eng, the same model files the app serves) on a
// rendered Korean/English page. Slow-ish (~10 s), fully offline.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createWorker } from 'tesseract.js';
import { loadCv } from '../src/lib/cv/loadCv';
import { OCR_LANGS, ocrScale, ocrText, toOcrPage } from '../src/lib/ocr';
import { encodePng } from './util/png';

const require = createRequire(import.meta.url);
const langDir = (l: string) => join(dirname(require.resolve(`@tesseract.js-data/${l}/package.json`)), '4.0.0_best_int');

describe('OCR', () => {
  it('reads Korean and English with word boxes', async () => {
    // Tesseract takes a single langPath: put both models in one folder,
    // as the app serves them.
    const dir = mkdtempSync(join(tmpdir(), 'tess-'));
    for (const l of ['kor', 'eng']) {
      const { copyFileSync } = await import('node:fs');
      copyFileSync(join(langDir(l), `${l}.traineddata.gz`), join(dir, `${l}.traineddata.gz`));
    }
    const worker = await createWorker(OCR_LANGS, 1, { langPath: dir, cachePath: dir, gzip: true });
    try {
      const png = readFileSync(new URL('./fixtures/ocr-ko.png', import.meta.url));
      const t0 = performance.now();
      const { data } = await worker.recognize(png, {}, { blocks: true });
      const page = toOcrPage(data as never, 1240, 900);
      const text = ocrText(page);
      console.log(`OCR ${Math.round(performance.now() - t0)} ms\n${text}`);
      for (const s of ['견적서', '한빛', '음악학원', '2026년', '피아노', '악보', 'Total', '120,000', 'Document', 'scanner']) expect(text).toContain(s);
      // Boxes: "견적서" title at about (100..255, 95..150) in the image.
      const title = page.lines.flat().find((w) => w.t === '견적서')!;
      expect(title.x0).toBeGreaterThan(90);
      expect(title.x0).toBeLessThan(115);
      expect(title.x1).toBeGreaterThan(240);
      expect(title.x1).toBeLessThan(270);
    } finally {
      await worker.terminate();
    }
  });

  it('reads a small scanned page right once enlarged as the app does', async () => {
    // The app's processed JPEG of the page above (1239×899), decoded to
    // RGBA: read as is, "음악학원" comes back as "SE".
    const dir = mkdtempSync(join(tmpdir(), 'tess-'));
    const { copyFileSync } = await import('node:fs');
    for (const l of ['kor', 'eng']) copyFileSync(join(langDir(l), `${l}.traineddata.gz`), join(dir, `${l}.traineddata.gz`));
    const { cv } = await loadCv();
    const worker = await createWorker(OCR_LANGS, 1, { langPath: dir, cachePath: dir, gzip: true });
    try {
      const rgba = { width: 1239, height: 899, data: new Uint8ClampedArray(gunzipSync(readFileSync(new URL('./fixtures/ocr-ko-scan.1239x899.rgba.gz', import.meta.url)))) };
      const asIs = await worker.recognize(Buffer.from(encodePng(new Uint8Array(rgba.data.buffer), rgba.width, rgba.height)), {}, { blocks: true });
      expect(ocrText(toOcrPage(asIs.data as never, rgba.width, rgba.height))).not.toContain('음악학원'); // the problem
      // Enlarge with OpenCV (the browser uses a canvas).
      const s = ocrScale(rgba.width, rgba.height);
      expect(s).toBeGreaterThan(1.5);
      const src = cv.matFromImageData(rgba);
      const big = new cv.Mat();
      cv.resize(src, big, new cv.Size(Math.round(rgba.width * s), Math.round(rgba.height * s)), 0, 0, cv.INTER_CUBIC);
      const png = encodePng(new Uint8Array(big.data), big.cols, big.rows);
      src.delete();
      big.delete();
      const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true });
      const page = toOcrPage(data as never, rgba.width, rgba.height, s);
      const text = ocrText(page);
      for (const w of ['음악학원', '2026년', '피아노', '120,000']) expect(text).toContain(w);
      // Boxes are in page-image pixels again.
      const title = page.lines.flat().find((w) => w.t === '견적서')!;
      expect(title.x0).toBeGreaterThan(90);
      expect(title.x1).toBeLessThan(270);
    } finally {
      await worker.terminate();
    }
  });
});
