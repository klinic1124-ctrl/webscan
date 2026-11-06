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
    expect(s.push(700, page(0.05)).progress).toBe(0);
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
    expect(s.push(2700, page(0.15)).ready).toBe(true);
    s.markCaptured(page(0.15));
    // page removed from view, then a new one at the same spot
    s.push(2800, null);
    s.push(2900, page(0.15));
    expect(s.push(3500, page(0.15)).ready).toBe(true);
  });
});
