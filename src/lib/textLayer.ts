// Invisible, searchable text over a scanned page image (the "OCR layer").
//
// Words are drawn in text render mode 3 (invisible) with a tiny embedded
// font whose glyphs are all empty. The font is a Type0/Identity-H font:
// each character is written as its UTF-16 code unit, every code maps to the
// one blank glyph (CIDToGIDMap) and back to the same Unicode value
// (ToUnicode), so any script (Korean included) can be searched and copied
// without embedding a real CJK font. Same approach as Tesseract's own PDFs.
import {
  beginText,
  endText,
  PDFDocument,
  PDFHexString,
  type PDFPage,
  type PDFRef,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
} from 'pdf-lib';

/** One recognised word, in pixels of the page image (top-left origin). */
export interface OcrWord {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** OCR result of one page image. */
export interface OcrPage {
  /** Image size the boxes refer to. */
  w: number;
  h: number;
  lines: OcrWord[][];
}

// Tiny TrueType font: .notdef and one box glyph (never painted: render
// mode 3; the box gives viewers a character cell to highlight), 500/1000,
// ascent 1000 / descent 0 so a glyph box is exactly the font size tall.
const GLYPHLESS_TTF_B64 = 'AAEAAAAKAIAAAwAgT1MvMkT/RUAAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmKOMxFAAAAcwAAAAYaGVhZC8w+MgAAACsAAAANmhoZWEF3QH2AAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAMAAAAAAHEAAAABm1heHAABAAGAAABCAAAACBuYW1lqWij/wAAAeQAAABmcG9zdABOAAAAAAJMAAAAJgABAAAAAQAACCpxwV8PPPUAAwPoAAAAAOcTWgAAAAAA5xNaAAAAAAAB9APoAAAAAwACAAAAAAAAAAEAAAPoAAAAAAH0AAAAAAH0AAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAQAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAPoAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAwAAAABAAAAAAH0A+gAAwAAMREhEQH0A+j8GAAAAAQANgABAAAAAAABAAkAAAABAAAAAAACAAcACQADAAEECQABABIAEAADAAEECQACAA4AIkdseXBoTGVzc1JlZ3VsYXIARwBsAHkAcABoAEwAZQBzAHMAUgBlAGcAdQBsAGEAcgAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAEoAAA==';
const ADVANCE = 0.5; // glyph advance as a fraction of the font size

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toUnicodeCMap(): string {
  // One range per high byte: a bfrange may not cross a high-byte boundary.
  const ranges: string[] = [];
  for (let hi = 0; hi < 256; hi++) {
    const h = hi.toString(16).padStart(2, '0').toUpperCase();
    ranges.push(`<${h}00> <${h}FF> <${h}00>`);
  }
  const chunks: string[] = [];
  for (let i = 0; i < ranges.length; i += 100) {
    const part = ranges.slice(i, i + 100);
    chunks.push(`${part.length} beginbfrange\n${part.join('\n')}\nendbfrange`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/** Adds the glyphless font to the document; returns its reference. */
export function embedGlyphlessFont(pdf: PDFDocument): PDFRef {
  const ctx = pdf.context;
  const ttf = b64(GLYPHLESS_TTF_B64);
  const fontFile = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: 'GlyphLessFont',
      Flags: 5,
      FontBBox: [0, 0, 500, 1000],
      ItalicAngle: 0,
      Ascent: 1000,
      Descent: 0,
      CapHeight: 1000,
      StemV: 80,
      FontFile2: fontFile,
    }),
  );
  // Every CID → glyph 1.
  const map = new Uint8Array(65536 * 2);
  for (let i = 1; i < map.length; i += 2) map[i] = 1;
  const cidToGid = ctx.register(ctx.flateStream(map));
  const cidFont = ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: { Registry: PDFHexString.fromText('Adobe'), Ordering: PDFHexString.fromText('Identity'), Supplement: 0 },
      FontDescriptor: descriptor,
      DW: 1000 * ADVANCE,
      CIDToGIDMap: cidToGid,
    }),
  );
  const toUnicode = ctx.register(ctx.flateStream(toUnicodeCMap()));
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'GlyphLessFont',
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  );
}

function utf16Hex(s: string): string {
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) continue; // outside the BMP: skipped
    hex += c.toString(16).padStart(4, '0');
  }
  return hex;
}

/**
 * Draws the words of `ocr` invisibly over an image placed at (x, y) with
 * size w×h points on `page`.
 */
export function drawTextLayer(
  page: PDFPage,
  font: PDFRef,
  ocr: OcrPage,
  place: { x: number; y: number; width: number; height: number },
): void {
  const sx = place.width / ocr.w;
  const sy = place.height / ocr.h;
  const name = page.node.newFontDictionaryKey('OCR');
  page.node.setFontDictionary(name, font);
  const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const line of ocr.lines) {
    line.forEach((wd, i) => {
      // A space after each word but the last keeps words apart when copied.
      const text = i < line.length - 1 ? `${wd.t} ` : wd.t;
      const hex = utf16Hex(text);
      if (!hex) return;
      const n = hex.length / 4;
      const size = Math.max(1, (wd.y1 - wd.y0) * sy);
      const width = Math.max(1, (wd.x1 - wd.x0) * sx) * (n / Math.max(1, wd.t.length));
      ops.push(
        setFontAndSize(name, size),
        setCharacterSqueeze((100 * width) / (n * ADVANCE * size)),
        setTextMatrix(1, 0, 0, 1, place.x + wd.x0 * sx, place.y + (ocr.h - wd.y1) * sy),
        showText(PDFHexString.of(hex)),
      );
    });
  }
  ops.push(endText());
  page.pushOperators(...ops);
}
