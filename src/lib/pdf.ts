// Multi-page PDF from scanned pages. JPEG pages are embedded as-is (no
// re-compression); black & white PNG pages are embedded losslessly.
import { PDFDocument } from 'pdf-lib';
import { nearestPaper, PAPER } from './geometry';
import { drawTextLayer, embedGlyphlessFont, type OcrPage } from './textLayer';

export type PdfPageSize = 'auto' | 'a4' | 'letter';

export interface PdfPageInput {
  bytes: Uint8Array;
  type: string; // image/jpeg | image/png
  width: number;
  height: number;
  /** Recognised text, drawn as an invisible searchable layer. */
  ocr?: OcrPage;
}

const MM = 72 / 25.4;
/** Physical paper sizes in mm, portrait. */
const PAPER_MM: Record<keyof typeof PAPER, [number, number]> = {
  a4: [210, 297],
  b5: [182, 257],
  letter: [215.9, 279.4],
  square: [210, 210],
};

/**
 * Page size in PDF points for an image of w×h px.
 * - a4 / letter: that paper, turned to match the image orientation.
 * - auto: the paper the page's ratio matches (A4, Letter, square), otherwise
 *   the image ratio with the long side of A4.
 */
export function pageSizeFor(choice: PdfPageSize, w: number, h: number): [number, number] {
  const landscape = w > h;
  const orient = ([a, b]: [number, number]): [number, number] => (landscape ? [b * MM, a * MM] : [a * MM, b * MM]);
  if (choice === 'a4') return orient(PAPER_MM.a4);
  if (choice === 'letter') return orient(PAPER_MM.letter);
  const paper = nearestPaper(w / h);
  // A4 and B5 share the √2 ratio, so the ratio alone cannot tell them apart;
  // A4 is by far the more common sheet.
  if (paper) return orient(PAPER_MM[paper === 'b5' ? 'a4' : paper]);
  const long = 297 * MM;
  return landscape ? [long, (long * h) / w] : [(long * w) / h, long];
}

export async function buildPdf(pages: PdfPageInput[], opts: { pageSize: PdfPageSize; title?: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  if (opts.title) pdf.setTitle(opts.title);
  pdf.setCreator('웹 문서 스캐너');
  pdf.setProducer('웹 문서 스캐너 (pdf-lib)');
  const font = pages.some((p) => p.ocr?.lines.length) ? embedGlyphlessFont(pdf) : null;
  for (const p of pages) {
    const img = p.type === 'image/png' ? await pdf.embedPng(p.bytes) : await pdf.embedJpg(p.bytes);
    const [pw, ph] = pageSizeFor(opts.pageSize, p.width, p.height);
    const page = pdf.addPage([pw, ph]);
    // Fit inside the page, centred (paper presets may differ slightly in ratio).
    const s = Math.min(pw / p.width, ph / p.height);
    const w = p.width * s;
    const h = p.height * s;
    const place = { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h };
    page.drawImage(img, place);
    if (font && p.ocr?.lines.length) drawTextLayer(page, font, p.ocr, place);
  }
  // Classic cross-reference table, no object streams: the most widely
  // readable form (as Tesseract's own PDFs).
  return pdf.save({ useObjectStreams: false });
}
