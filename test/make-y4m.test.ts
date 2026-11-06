// Writes a short fake-camera video (Y4M) of synthetic pages for browser tests
// of the live camera. Run with: MAKE_Y4M=<output path> npx vitest run test/make-y4m.test.ts
import { it } from 'vitest';
import { openSync, writeSync, closeSync } from 'node:fs';
import { loadCv } from '../src/lib/cv/loadCv';
import { makeScene, type SceneOptions } from '../src/lib/cv/synthetic';

it.skipIf(!process.env.MAKE_Y4M)('fake camera video', async () => {
  const { cv } = await loadCv();
  const W = 960;
  const H = 720;
  const fd = openSync(process.env.MAKE_Y4M!, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = (o: Partial<SceneOptions>) => {
    const sc = makeScene(cv, { kind: 'text', width: W, height: H, seed: 5, ...o } as SceneOptions);
    const d: Uint8Array = sc.rgba.data;
    const Y = Buffer.alloc(W * H);
    const U = Buffer.alloc((W / 2) * (H / 2));
    const V = Buffer.alloc((W / 2) * (H / 2));
    for (let i = 0; i < W * H; i++) Y[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    for (let y = 0; y < H / 2; y++) {
      for (let x = 0; x < W / 2; x++) {
        let r = 0, g = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const k = ((2 * y + dy) * W + 2 * x + dx) * 4;
          r += d[k]; g += d[k + 1]; b += d[k + 2];
        }
        r /= 4; g /= 4; b /= 4;
        U[y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
        V[y * (W / 2) + x] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
      }
    }
    writeSync(fd, 'FRAME\n');
    writeSync(fd, Y);
    writeSync(fd, U);
    writeSync(fd, V);
    sc.rgba.delete();
    sc.doc.delete();
  };
  const empty = { pose: { distance: 1000 } };
  for (let i = 0; i < 8; i++) frame(empty); // 0.8 s empty table
  for (let i = 0; i < 8; i++) frame({ pose: { rx: 18 + i * 1.5, ry: -6 + i, rz: 4 - i * 0.8 } }); // 0.8 s page moving in
  for (let i = 0; i < 20; i++) frame({ pose: { rx: 30, ry: 2, rz: -2.4 } }); // 2 s still
  for (let i = 0; i < 6; i++) frame(empty); // page taken away
  for (let i = 0; i < 20; i++) frame({ kind: 'music', pose: { rx: 20, ry: -4, rz: 3 } }); // next page, 2 s still
  closeSync(fd);
});
