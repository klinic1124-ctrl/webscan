// Black & white quality on printed sheet music photographed with a phone.
// SCORE_REPORT=1 prints the numbers; SCAN_DEBUG=1 also writes images
// (CROP_Y=0.76: which band of the page); SCORE_MODE=gray to look at grey.
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadCv } from '../src/lib/cv/loadCv';
import { processPage } from '../src/lib/cv/pipeline';
import { encodePng } from './util/png';
import { makeScore, measureScore, photograph, type PhotoOptions } from './util/score';

const CASES: { name: string; photo: PhotoOptions }[] = [
  { name: 'good light', photo: {} },
  { name: 'soft focus', photo: { blur: 1.8 } },
  { name: 'dim, uneven', photo: { white: 165, shade: 0.5, noise: 5 } },
  { name: 'far (7 MP page)', photo: { width: 2268, height: 3024, blur: 1.2 } },
  { name: 'far + soft', photo: { width: 2268, height: 3024, blur: 1.8, white: 190, noise: 4 } },
  { name: 'show-through', photo: { showThrough: 0.22 } },
];

describe('sheet music in black & white', async () => {
  const { cv } = await loadCv();
  const crisp = makeScore(cv, 2480);
  const faded = makeScore(cv, 2480, 3, 105); // a pale photocopy
  for (const c of [...CASES, { name: 'faded copy', photo: {}, faded: true }, { name: 'faded + far', photo: CASES[3].photo, faded: true }]) {
    it(c.name, () => {
      const score = 'faded' in c ? faded : crisp;
      const { rgba, quad } = photograph(cv, score.doc, c.photo);
      const r = processPage(cv, rgba, quad, { mode: (process.env.SCORE_MODE as 'bw' | 'gray') ?? 'bw', aspect: 'a4' });
      const q = measureScore(cv, r.out, score);
      if (process.env.SCORE_REPORT || process.env.SCAN_DEBUG)
        console.log(c.name.padEnd(16), `${r.width}x${r.height}`, Object.entries(q).map(([k, v]) => `${k} ${v.toFixed(k === 'noise' ? 0 : 3)}`).join('  '));
      if (process.env.SCAN_DEBUG) {
        mkdirSync('test-output', { recursive: true });
        // Left half of a band of the page (CROP_Y: its top, as a fraction).
        const y0 = Math.round(r.height * Number(process.env.CROP_Y ?? 0.12));
        const cw = Math.round(r.width * 0.5);
        const ch = Math.round(r.height * 0.12);
        const buf = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) buf.set(r.out.data.subarray((y0 + y) * r.width * 4, ((y0 + y) * r.width + cw) * 4), y * cw * 4);
        writeFileSync(`test-output/score-${c.name.replace(/\W+/g, '-')}.png`, encodePng(buf, cw, ch));
      }
      rgba.delete();
      r.out.delete();
      // Every staff line whole (no gap longer than a staff space), stems and
      // noteheads intact, half notes still open, strokes not much bolder
      // than printed, and next to no stray ink.
      expect(q.staffWhole).toBeGreaterThanOrEqual(0.95);
      expect(q.stems).toBeGreaterThanOrEqual(0.98);
      expect(q.filledHeads).toBeGreaterThanOrEqual(0.98);
      expect(q.hollowOpen).toBeGreaterThanOrEqual(0.95);
      expect(q.weight).toBeLessThan(1.7);
      expect(q.noise).toBeLessThan(600);
    });
  }
});
