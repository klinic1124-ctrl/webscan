// Timing at real phone-photo size (4000×3000). Run with:
// SCAN_BENCH=1 npx vitest run test/bench.test.ts
import { it } from 'vitest';
import { loadCv } from '../src/lib/cv/loadCv';
import { detectQuad, processPage } from '../src/lib/cv/pipeline';
import { makeScene } from '../src/lib/cv/synthetic';

it.skipIf(!process.env.SCAN_BENCH)('12 MP timing', async () => {
  const { cv } = await loadCv();
  const sc = makeScene(cv, { kind: 'music', shadow: true, width: 4000, height: 3000 });
  detectQuad(cv, sc.rgba); // warm-up
  const t = performance.now();
  const d = detectQuad(cv, sc.rgba);
  console.log('detect ms', Math.round(performance.now() - t));
  for (const mode of ['gray', 'color', 'bw', 'photo'] as const) {
    processPage(cv, sc.rgba, d.quad, { mode, aspect: 'auto' }).out.delete(); // warm-up
    const r = processPage(cv, sc.rgba, d.quad, { mode, aspect: 'auto' });
    console.log(mode, `${r.width}x${r.height}`, JSON.stringify(r.timings), 'heapMB', Math.round(cv.HEAPU8.length / 1048576));
    r.out.delete();
  }
});
