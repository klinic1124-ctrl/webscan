// Invisible, searchable text over a scanned page image (the "OCR layer").
//
// Words are drawn in text render mode 3 (invisible) with a tiny embedded
// font whose glyphs are all empty. The font is a Type0/Identity-H font:
// each character is written as its UTF-16 code unit, every code maps to the
// one blank glyph (CIDToGIDMap) and back to the same Unicode value
// (ToUnicode), so any script (Korean included) can be searched and copied
// without embedding a real CJK font.
//
// Font, font dictionaries, ToUnicode map and text layout follow Tesseract's
// own PDF output as closely as possible (its pdf.ttf glyphless font,
// Apache-2.0), since those PDFs are known to work in strict viewers such as
// iOS PDFKit.
import {
  beginText,
  endText,
  PDFDocument,
  PDFArray,
  PDFHexString,
  PDFString,
  type PDFPage,
  type PDFRef,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  moveText,
  PDFOperator,
  PDFOperatorNames,
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

// Tesseract's pdf.ttf (572 bytes, Apache-2.0): .notdef and one empty glyph
// with an advance of half the font size.
const GLYPHLESS_TTF_B64 = 'AAEAAAAKAIAAAwAgT1MvMlbeyJQAAAEoAAAAYGNtYXAACgA0AAABkAAAAB5nbHlmFSJBJAAAAbgAAAAYaGVhZAt48WUAAACsAAAANmhoZWEMAgQCAAAA5AAAACRobXR4BAAAAAAAAYgAAAAIbG9jYQAMAAAAAAGwAAAABm1heHAABAAFAAABCAAAACBuYW1l8usW2gAAAdAAAABLcG9zdAABAAEAAAIcAAAAIAABAAAAAQAAsJRxEF8PPPUEBwgAAAAAAM+a/G4AAAAA1MOn8gAAAAAEAAgAAAAAEAACAAAAAAAAAAEAAAgA//8AAAQAAAAAAAQAAAEAAAAAAAAAAAAAAAAAAAACAAEAAAACAAQAAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAwAAAZAABQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUAAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAR09PRwBAAAAAAAAB//8AAAABAAGAAAAAAAAAAAAAAAAAAAABAAAAAAAABAAAAAAAAAIAAQAAAAAAFAADAAAAAAAUAAYACgAAAAAAAAAAAAAAAAAMAAAAAQAAAAAEAAgAAAMAADEhESEEAPwACAAAAAADACoAAAADAAAABQAWAAAAAQAAAAAABQALABYAAwABBAkABQAWAAAAVgBlAHIAcwBpAG8AbgAgADEALgAwVmVyc2lvbiAxLjAAAAEAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=';
const ADVANCE = 0.5; // glyph advance as a fraction of the font size

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toUnicodeCMap(): string {
  // Every 2-byte code is its own UTF-16 value (written as Tesseract does).
  const chunks = ['1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange'];
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identify-UCS def',
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
      Descent: -1,
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
      // Plain byte strings: viewers compare them byte for byte (a UTF-16
      // "Adobe" made iOS ignore the font and with it all the text).
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
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
  // Laid out the way Tesseract writes its PDFs: one text matrix per line,
  // then relative moves (Td) word to word, each word as a TJ array ending
  // in a space.
  const ops = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const line of ocr.lines) {
    let px = 0;
    let py = 0;
    line.forEach((wd, i) => {
      const hex = utf16Hex(`${wd.t} `);
      if (hex.length <= 4) return;
      const n = hex.length / 4;
      const size = Math.max(1, (wd.y1 - wd.y0) * sy);
      const width = Math.max(1, (wd.x1 - wd.x0) * sx) * (n / Math.max(1, wd.t.length));
      const x = place.x + wd.x0 * sx;
      const y = place.y + (ocr.h - wd.y1) * sy;
      if (i === 0) ops.push(setTextMatrix(1, 0, 0, 1, x, y));
      else ops.push(moveText(x - px, y - py));
      px = x;
      py = y;
      ops.push(setFontAndSize(name, size), setCharacterSqueeze((100 * width) / (n * ADVANCE * size)), PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [PDFArray.withContext(page.doc.context)].map((a) => (a.push(PDFHexString.of(hex)), a))));
    });
  }
  ops.push(endText());
  page.pushOperators(...ops);
}
