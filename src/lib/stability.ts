// Decides when a live camera view is steady enough to take the picture.
// Corners are normalised to the frame (0..1) so tolerances do not depend on
// the camera resolution.
import type { Quad } from './geometry';

export interface StabilityOptions {
  /** How long the outline must stay put before auto-capture (ms). */
  holdMs: number;
  /** Largest corner movement between frames still counted as "still" (frame fractions). */
  moveTol: number;
  /** After a capture, the outline must move this much (or vanish) before the next auto-capture. */
  rearmMove: number;
}

export interface StabilityState {
  /** 0..1 progress towards auto-capture. */
  progress: number;
  /** Progress reached 1 and the tracker is armed. */
  ready: boolean;
  /** False right after a capture until the page changes. */
  armed: boolean;
}

export const maxCornerShift = (a: Quad, b: Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

export class StabilityTracker {
  private last: Quad | null = null;
  private stillSince: number | null = null;
  private captured: Quad | null = null;
  private armed = true;
  readonly opts: StabilityOptions;

  constructor(opts: Partial<StabilityOptions> = {}) {
    this.opts = { holdMs: 900, moveTol: 0.015, rearmMove: 0.12, ...opts };
  }

  /** Feeds one detection (null = no page found) taken at time `t` (ms). */
  push(t: number, quad: Quad | null): StabilityState {
    if (!quad) {
      this.last = null;
      this.stillSince = null;
      this.armed = true; // page left the view: the next one may be captured
      return { progress: 0, ready: false, armed: this.armed };
    }
    if (!this.armed && this.captured && maxCornerShift(quad, this.captured) > this.opts.rearmMove) this.armed = true;
    if (!this.last || maxCornerShift(quad, this.last) > this.opts.moveTol) {
      this.stillSince = t;
    }
    this.last = quad;
    const progress = this.stillSince === null ? 0 : Math.min(1, (t - this.stillSince) / this.opts.holdMs);
    return { progress, ready: progress >= 1 && this.armed, armed: this.armed };
  }

  /** Call after taking a picture of `quad`. */
  markCaptured(quad: Quad | null) {
    this.captured = quad;
    this.armed = false;
    this.stillSince = null;
  }

  reset() {
    this.last = null;
    this.stillSince = null;
    this.captured = null;
    this.armed = true;
  }
}
