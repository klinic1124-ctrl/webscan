import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildPdf, pageSizeFor } from '../src/lib/pdf';
import { encodePng } from './util/png';

// Smallest valid JPEG (1×1, progressive) — pdf-lib only reads its header.
const JPEG_1PX = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  ),
  (c) => c.charCodeAt(0),
);

const MM = 72 / 25.4;
const close = (a: number, b: number) => Math.abs(a - b) < 0.5;

describe('pageSizeFor', () => {
  it('snaps an A4-ratio page to A4 and keeps orientation', () => {
    const [w, h] = pageSizeFor('auto', 2435, 3434);
    expect(close(w, 210 * MM) && close(h, 297 * MM)).toBe(true);
    const [lw, lh] = pageSizeFor('auto', 3434, 2435);
    expect(close(lw, 297 * MM) && close(lh, 210 * MM)).toBe(true);
  });

  it('uses the image ratio when no paper matches (receipt)', () => {
    const [w, h] = pageSizeFor('auto', 800, 2400);
    expect(close(h, 297 * MM)).toBe(true);
    expect(w / h).toBeCloseTo(1 / 3, 3);
  });

  it('forces Letter when asked', () => {
    const [w, h] = pageSizeFor('letter', 1000, 1000);
    expect(close(w, 612) && close(h, 792)).toBe(true);
  });
});

describe('buildPdf', () => {
  it('writes one page per scan with the right sizes and title', async () => {
    const png = encodePng(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
    const bytes = await buildPdf(
      [
        { bytes: JPEG_1PX, type: 'image/jpeg', width: 2435, height: 3434 },
        { bytes: new Uint8Array(png), type: 'image/png', width: 3434, height: 2435 },
      ],
      { pageSize: 'auto', title: '악보 모음' },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe('악보 모음');
    const [p1, p2] = doc.getPages().map((p) => p.getSize());
    expect(close(p1.width, 210 * MM)).toBe(true);
    expect(close(p2.width, 297 * MM)).toBe(true);
  });
});
