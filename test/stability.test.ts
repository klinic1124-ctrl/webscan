import { describe, expect, it } from 'vitest';
import type { Quad } from '../src/lib/geometry';
import { StabilityTracker } from '../src/lib/stability';

const page = (dx = 0, dy = 0): Quad => [
  { x: 0.2 + dx, y: 0.1 + dy },
  { x: 0.8 + dx, y: 0.1 + dy },
  { x: 0.8 + dx, y: 0.9 + dy },
  { x: 0.2 + dx, y: 0.9 + dy },
];

describe('StabilityTracker', () => {
  it('becomes ready after holding still for holdMs', () => {
    const s = new StabilityTracker({ holdMs: 900 });
    expect(s.push(0, page()).ready).toBe(false);
    expect(s.push(450, page(0.002)).progress).toBeCloseTo(0.5, 1);
    expect(s.push(950, page(0.004)).ready).toBe(true);
  });

  it('restarts the timer when the page moves', () => {
    const s = new StabilityTracker({ holdMs: 900 });
    s.push(0, page());
    s.push(600, page());
    s.push(650, page(0.05));
    expect(s.push(700, page(0.05)).progress).toBe(0); // second frame away: moved
    expect(s.push(1700, page(0.05)).ready).toBe(true);
  });

  it('does not capture the same page twice; re-arms when the page changes or leaves', () => {
    const s = new StabilityTracker({ holdMs: 500 });
    s.push(0, page());
    expect(s.push(600, page()).ready).toBe(true);
    s.markCaptured(page());
    s.push(700, page());
    expect(s.push(2000, page()).ready).toBe(false); // still the same page
    // next page slid in at a clearly different place
    s.push(2100, page(0.15));
    s.push(2150, page(0.15)); // second frame there: it moved
    expect(s.push(2700, page(0.15)).ready).toBe(true);
    s.markCaptured(page(0.15));
    // page removed from view, then a new one at the same spot
    s.push(2800, null);
    s.push(3200, null); // gone long enough
    s.push(3300, page(0.15));
    expect(s.push(4300, page(0.15)).ready).toBe(true);
  });

  it('a slow drift is movement, even when each frame moves little (fast detection)', () => {
    const s = new StabilityTracker({ holdMs: 900, moveTol: 0.015 });
    // 50 ms frames, 0.004 per frame: each step is under the tolerance,
    // but over 900 ms the page travels 0.07.
    let ready = false;
    for (let t = 0, x = 0; t <= 1500; t += 50, x += 0.004) ready ||= s.push(t, page(x)).ready;
    expect(ready).toBe(false);
  });

  it('small jitter around one place still captures', () => {
    const s = new StabilityTracker({ holdMs: 900 });
    let ready = false;
    for (let t = 0, i = 0; t <= 1000; t += 50, i++) ready ||= s.push(t, page(i % 2 ? 0.006 : -0.006)).ready;
    expect(ready).toBe(true);
  });

  it('ignores a single odd outline and brief missed detections', () => {
    const s = new StabilityTracker({ holdMs: 900 });
    s.push(0, page());
    s.push(300, page());
    s.push(350, page(0.2)); // one wrong detection
    s.push(400, null); // and a miss
    s.push(450, null);
    expect(s.push(500, page()).progress).toBeCloseTo(500 / 900, 2);
    expect(s.push(950, page()).ready).toBe(true);
  });
});
