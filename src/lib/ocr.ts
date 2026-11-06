// Turning Tesseract's result into the compact per-page form stored with a
// page and drawn into PDFs (see textLayer.ts). Engine set-up lives with
// the caller (browser: src/ocr.ts; tests: Node).
import type { OcrPage, OcrWord } from './textLayer';

export const OCR_LANGS = 'kor+eng';
/** Bump when recognition settings change, so stored results are redone. */
export const OCR_VERSION = 1;

/**
 * Pages are enlarged to at least this long side before reading: on small
 * page images Tesseract's Korean model misreads whole words (a 1240 px
 * page: "음악학원" → "SE"); at 1.5× it reads them right.
 */
const OCR_LONG_SIDE = 3000;
const OCR_MAX_UPSCALE = 2;

/** Factor to enlarge a w×h page image by before OCR (1 = as is). */
export function ocrScale(w: number, h: number): number {
  return Math.min(OCR_MAX_UPSCALE, Math.max(1, OCR_LONG_SIDE / Math.max(w, h)));
}

/** Words below this confidence (0..100) are dropped as noise. */
const MIN_CONFIDENCE = 20;

interface TBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TWord {
  text: string;
  confidence: number;
  bbox: TBox;
}
interface TLine {
  words: TWord[];
}
interface TParagraph {
  lines: TLine[];
}
interface TBlock {
  paragraphs: TParagraph[];
}
/** The part of Tesseract.js's RecognizeResult['data'] used here. */
export interface TesseractData {
  blocks: TBlock[] | null;
}

// Tesseract's Korean model often splits Hangul words into syllables
// ("음 악 학 원") and numbers from their unit ("2026 년"). Pieces closer
// together than a real word space are joined back up. Measured on rendered
// text: letter gaps 0.1-0.25 of the glyph height, word spaces 0.37-0.6.
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const DIGIT = /[0-9]/;
const JOIN_GAP = 0.32;

function joinable(a: string, b: string): boolean {
  const x = a.slice(-1);
  const y = b[0];
  return (HANGUL.test(x) && (HANGUL.test(y) || DIGIT.test(y))) || (DIGIT.test(x) && HANGUL.test(y));
}

function joinTouching(words: OcrWord[]): OcrWord[] {
  // Line height from the median word: single boxes can be odd (a lone
  // "년" may come back taller than its neighbours).
  const hs = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const h = hs[hs.length >> 1];
  const out: OcrWord[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && joinable(prev.t, w.t) && w.x0 - prev.x1 < h * JOIN_GAP) {
      prev.t += w.t;
      prev.x1 = Math.max(prev.x1, w.x1);
      prev.y0 = Math.min(prev.y0, w.y0);
      prev.y1 = Math.max(prev.y1, w.y1);
      continue;
    }
    out.push({ ...w });
  }
  return out;
}

/**
 * \`w\`×\`h\` is the page image size; \`scale\` is how much it was enlarged
 * for reading (boxes are mapped back to the page image).
 */
export function toOcrPage(data: TesseractData, w: number, h: number, scale = 1): OcrPage {
  const lines: OcrWord[][] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        const words = l.words
          .filter((wd) => wd.text.trim() && wd.confidence >= MIN_CONFIDENCE)
          .map((wd) => ({
            t: wd.text.trim(),
            x0: wd.bbox.x0 / scale,
            y0: wd.bbox.y0 / scale,
            x1: wd.bbox.x1 / scale,
            y1: wd.bbox.y1 / scale,
          }));
        if (words.length) lines.push(joinTouching(words));
      }
  return { w, h, lines };
}

/** Plain text of a page, one line per OCR line. */
export function ocrText(page: OcrPage): string {
  return page.lines.map((l) => l.map((w) => w.t).join(' ')).join('\n');
}
