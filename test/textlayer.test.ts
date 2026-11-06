// The invisible OCR text layer must come back out of the PDF as the same
// text, at the word positions, for Korean and Latin alike. Checked with
// poppler's pdftotext (skipped where it is not installed).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPdf } from '../src/lib/pdf';
import type { OcrPage } from '../src/lib/textLayer';
import { encodePng } from './util/png';

let hasPdftotext = true;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
} catch {
  hasPdftotext = false;
}

const W = 1000;
const H = 1414;
const ocr: OcrPage = {
  w: W,
  h: H,
  lines: [
    [
      { t: '견적서', x0: 100, y0: 100, x1: 300, y1: 160 },
      { t: '2026년', x0: 340, y0: 100, x1: 520, y1: 160 },
    ],
    [
      { t: 'Total:', x0: 100, y0: 300, x1: 260, y1: 340 },
      { t: '₩12,000', x0: 290, y0: 300, x1: 480, y1: 340 },
    ],
  ],
};

describe.skipIf(!hasPdftotext)('OCR text layer', () => {
  it('is searchable text in the right place, and invisible', async () => {
    const png = encodePng(new Uint8Array(W * H * 4).fill(255), W, H);
    const bytes = await buildPdf(
      [
        { bytes: png, type: 'image/png', width: W, height: H, ocr },
        { bytes: png, type: 'image/png', width: W, height: H },
      ],
      { pageSize: 'a4' },
    );
    // Strict viewers (iOS) need the font's registry as plain bytes.
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).toMatch(/\/Registry \(Adobe\)/);
    expect(raw).toMatch(/\/Ordering \(Identity\)/);
    expect(raw).not.toMatch(/\/ObjStm/);

    const dir = mkdtempSync(join(tmpdir(), 'ocr-'));
    const file = join(dir, 'a.pdf');
    writeFileSync(file, bytes);

    const text = execFileSync('pdftotext', ['-layout', file, '-']).toString();
    expect(text).toContain('견적서 2026년');
    expect(text).toContain('Total: ₩12,000');

    // Word boxes: page is A4 (595×842 pt) and the image fills it exactly.
    const html = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', file, '-']).toString();
    const words = [...html.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)</g)].map((m) => ({
      t: m[5],
      x0: +m[1],
      y0: +m[2],
      x1: +m[3],
      y1: +m[4],
    }));
    const s = 595.28 / W;
    for (const line of ocr.lines)
      for (const w of line) {
        const got = words.find((x) => x.t === w.t.replace('&', '&amp;'));
        expect(got, w.t).toBeTruthy();
        expect(Math.abs(got!.x0 - w.x0 * s)).toBeLessThan(3);
        // Top edge (viewers differ in how far below the baseline they extend).
        expect(Math.abs(got!.y0 - w.y0 * s)).toBeLessThan(3);
        // The word (plus its trailing space) spans about the box width.
        expect(got!.x1 - got!.x0).toBeGreaterThan((w.x1 - w.x0) * s * 0.8);
        expect(got!.x1 - got!.x0).toBeLessThan((w.x1 - w.x0) * s * 1.35);
      }

    // Page 2 has no text layer.
    const p2 = execFileSync('pdftotext', ['-f', '2', '-l', '2', file, '-']).toString();
    expect(p2.trim()).toBe('');
  });
});
