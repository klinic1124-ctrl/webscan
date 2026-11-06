// Decides when a live camera view is steady enough to take the picture.
// Corners are normalised to the frame (0..1) so tolerances do not depend on
// the camera resolution.
import type { Quad } from './geometry';

export interface StabilityOptions {
  /** How long the outline must stay put before auto-capture (ms). */
  holdMs: number;
  /**
   * Largest corner movement still counted as "still" (frame fractions),
   * measured from where the outline was when it came to rest, not from the
   * previous frame: with fast detection a slow drift moves very little per
   * frame and would otherwise count as still.
   */
  moveTol: number;
  /** After a capture, the outline must move this much (or vanish) before the next auto-capture. */
  rearmMove: number;
  /** Missed detections shorter than this do not reset anything (ms). */
  dropoutMs: number;
  /** Out-of-place outlines needed in a row to count as movement (single odd frames are ignored). */
  moveFrames: number;
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
  /** Where the outline came to rest. */
  private anchor: Quad | null = null;
  private stillSince: number | null = null;
  private lostSince: number | null = null;
  private away = 0;
  private captured: Quad | null = null;
  private armed = true;
  readonly opts: StabilityOptions;

  constructor(opts: Partial<StabilityOptions> = {}) {
    this.opts = { holdMs: 900, moveTol: 0.015, rearmMove: 0.12, dropoutMs: 350, moveFrames: 2, ...opts };
  }

  private progressAt(t: number): number {
    return this.stillSince === null ? 0 : Math.min(1, (t - this.stillSince) / this.opts.holdMs);
  }

  /** Feeds one detection (null = no page found) taken at time `t` (ms). */
  push(t: number, quad: Quad | null): StabilityState {
    if (!quad) {
      this.lostSince ??= t;
      if (t - this.lostSince >= this.opts.dropoutMs) {
        this.anchor = null;
        this.stillSince = null;
        this.away = 0;
        this.armed = true; // page left the view: the next one may be captured
        return { progress: 0, ready: false, armed: true };
      }
      // A brief miss: hold the progress, but never capture on a miss.
      return { progress: this.progressAt(t), ready: false, armed: this.armed };
    }
    this.lostSince = null;
    if (!this.armed && this.captured && maxCornerShift(quad, this.captured) > this.opts.rearmMove) this.armed = true;
    if (!this.anchor) {
      this.anchor = quad;
      this.stillSince = t;
      this.away = 0;
    } else if (maxCornerShift(quad, this.anchor) > this.opts.moveTol) {
      this.away++;
      if (this.away >= this.opts.moveFrames) {
        // Really moving: start again from here.
        this.anchor = quad;
        this.stillSince = t;
        this.away = 0;
      }
      return { progress: this.away ? this.progressAt(t) : 0, ready: false, armed: this.armed };
    } else {
      this.away = 0;
    }
    const progress = this.progressAt(t);
    return { progress, ready: progress >= 1 && this.armed, armed: this.armed };
  }

  /** Call after taking a picture of `quad`. */
  markCaptured(quad: Quad | null) {
    this.captured = quad;
    this.armed = false;
    this.anchor = null;
    this.stillSince = null;
    this.away = 0;
  }

  reset() {
    this.anchor = null;
    this.stillSince = null;
    this.lostSince = null;
    this.away = 0;
    this.captured = null;
    this.armed = true;
  }
}
