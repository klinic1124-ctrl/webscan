// Writes before/after PNGs of the synthetic scenes to test-output/ for visual
// inspection. Run with: SCAN_DEBUG=1 npx vitest run test/debug-output.test.ts
import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCv } from '../src/lib/cv/loadCv';
import { detectQuad, processPage } from '../src/lib/cv/pipeline';
import { makeScene } from '../src/lib/cv/synthetic';
import { encodePng } from './util/png';

it.skipIf(!process.env.SCAN_DEBUG)('writes debug images', async () => {
  const { cv } = await loadCv();
  mkdirSync('test-output', { recursive: true });
  for (const kind of ['text', 'music', 'photo'] as const) {
    for (const shadow of [false, true]) {
      const sc = makeScene(cv, { kind, shadow, glare: kind === 'photo' && shadow });
      const name = `${kind}${shadow ? '-shadow' : ''}`;
      writeFileSync(`test-output/${name}-in.png`, encodePng(sc.rgba.data, sc.rgba.cols, sc.rgba.rows));
      const d = detectQuad(cv, sc.rgba);
      for (const mode of ['auto', 'color', 'gray', 'bw', 'photo'] as const) {
        const r = processPage(cv, sc.rgba, d.quad, { mode, aspect: 'auto' });
        console.log(name, mode, '→', r.mode, JSON.stringify({ cls: r.classify, t: r.timings }));
        writeFileSync(`test-output/${name}-${mode}.png`, encodePng(r.out.data, r.out.cols, r.out.rows));
        r.out.delete();
      }
      sc.rgba.delete();
      sc.doc.delete();
    }
  }
});
