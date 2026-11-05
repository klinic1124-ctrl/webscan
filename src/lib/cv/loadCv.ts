import cvModule from '@techstark/opencv-js';

// OpenCV.js typings ship incomplete; the pipeline uses the runtime API directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mat = any;

let cached: Promise<{ cv: CV }> | null = null;

/**
 * Waits for the OpenCV.js runtime (WASM embedded in the JS file).
 */
export function loadCv(): Promise<{ cv: CV }> {
  if (!cached) {
    cached = (async () => {
      // Static import on purpose: the module object has a `then` method, so a
      // dynamic import() would try to resolve it as a promise and hang.
      const cv: CV = cvModule;
      if (!cv.Mat) {
        await new Promise<void>((resolve) => {
          // Chain, never replace: OpenCV.js may rely on its own hook, and
          // overwriting it leaves the runtime half-initialised in browsers.
          const prev = cv.onRuntimeInitialized;
          cv.onRuntimeInitialized = () => {
            prev?.();
            resolve();
          };
          // Also poll, in case initialisation finished before the hook was set.
          const timer = setInterval(() => {
            if (cv.Mat) {
              clearInterval(timer);
              resolve();
            }
          }, 25);
        });
      }
      // The emscripten module defines `then` (it is "thenable"). Returning it
      // from any async function would make that promise wait on it forever
      // once the runtime is up, so drop it now that initialisation is done.
      if (typeof cv.then === 'function') delete cv.then;
      return { cv };
    })();
  }
  return cached;
}

/** Tracks Mats created in a block and frees them (WASM heap is not GC'd). */
export class MatScope {
  private mats: Mat[] = [];
  add<T extends Mat>(m: T): T {
    this.mats.push(m);
    return m;
  }
  /** Removes a Mat from the scope so the caller owns it. */
  keep<T extends Mat>(m: T): T {
    this.mats = this.mats.filter((x) => x !== m);
    return m;
  }
  dispose() {
    for (const m of this.mats) {
      if (m && !m.isDeleted()) m.delete();
    }
    this.mats = [];
  }
}

export function scoped<T>(fn: (s: MatScope) => T): T {
  const s = new MatScope();
  try {
    return fn(s);
  } finally {
    s.dispose();
  }
}

/**
 * Deep copy of a Mat. Do not use `Mat.clone()` with this OpenCV.js build: it
 * returns a Mat that shares pixel memory with the original, so writing to
 * the "clone" silently changes the source (and deleting either frees both).
 */
export function copyMat(cv: CV, m: Mat): Mat {
  const d = new cv.Mat();
  m.copyTo(d);
  return d;
}
