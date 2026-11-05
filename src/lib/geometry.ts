// Pure geometry helpers (no OpenCV dependency) — unit-testable in Node.

export interface Point {
  x: number;
  y: number;
}

/** Quadrilateral ordered TL, TR, BR, BL (image coordinates, y grows downward). */
export type Quad = [Point, Point, Point, Point];

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Orders 4 arbitrary points as TL, TR, BR, BL (clockwise on screen). */
export function orderCorners(pts: Point[]): Quad {
  if (pts.length !== 4) throw new Error(`orderCorners needs 4 points, got ${pts.length}`);
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  // atan2 with y-down grows clockwise on screen.
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  return [0, 1, 2, 3].map((i) => ({ ...sorted[(start + i) % 4] })) as Quad;
}

export function polygonArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Interior angles in degrees at each corner. */
export function interiorAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const prev = q[(i + 3) % 4];
    const next = q[(i + 1) % 4];
    const v1x = prev.x - p.x;
    const v1y = prev.y - p.y;
    const v2x = next.x - p.x;
    const v2y = next.y - p.y;
    const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/** [top, right, bottom, left] edge lengths. */
export function edgeLengths(q: Quad): [number, number, number, number] {
  return [dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0])];
}

export function scaleQuad(q: Quad, s: number): Quad {
  return q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
}

export function fullFrameQuad(w: number, h: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
}

export function clampQuad(q: Quad, w: number, h: number): Quad {
  return q.map((p) => ({
    x: Math.min(w - 1, Math.max(0, p.x)),
    y: Math.min(h - 1, Math.max(0, p.y)),
  })) as Quad;
}

/** Rotates a quad together with its image by 90° clockwise. Image was w×h. */
export function rotateQuadCW(q: Quad, _w: number, h: number): Quad {
  const r = q.map((p) => ({ x: h - 1 - p.y, y: p.x }));
  return orderCorners(r);
}

// ---------------------------------------------------------------------------
// Line fitting (used to refine detected corners on edge pixels)

export interface Line {
  /** Point on the line */
  px: number;
  py: number;
  /** Unit direction */
  dx: number;
  dy: number;
}

/** Total-least-squares line fit (PCA). */
export function fitLine(points: Point[]): Line | null {
  const n = points.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) };
}

export function intersectLines(a: Line, b: Line): Point | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return { x: a.px + t * a.dx, y: a.py + t * a.dy };
}

/**
 * Refines a quad by fitting a line to the edge pixels lying near each side
 * and intersecting neighbouring lines. Falls back to the original corner when
 * a side has too little support or the refined corner moves too far.
 */
export function refineQuadWithEdges(
  q: Quad,
  edgePoints: Point[],
  band: number,
  maxMove: number,
): Quad {
  const sides: Point[][] = [[], [], [], []];
  for (const p of edgePoints) {
    let best = -1;
    let bestD = band;
    for (let i = 0; i < 4; i++) {
      const a = q[i];
      const b = q[(i + 1) % 4];
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const len2 = vx * vx + vy * vy;
      const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
      if (t < 0.08 || t > 0.92) continue; // ignore near corners (rounded/occluded)
      const d = Math.abs((p.x - a.x) * vy - (p.y - a.y) * vx) / Math.sqrt(len2);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) sides[best].push(p);
  }
  const lines = sides.map((pts, i) => {
    const len = dist(q[i], q[(i + 1) % 4]);
    return pts.length >= Math.max(12, len * 0.25) ? fitLine(pts) : null;
  });
  return q.map((p, i) => {
    // corner i is the intersection of side (i-1) and side i
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    if (!l1 || !l2) return { ...p };
    const r = intersectLines(l1, l2);
    if (!r || dist(r, p) > maxMove) return { ...p };
    return r;
  }) as Quad;
}

// ---------------------------------------------------------------------------
// Aspect ratio of the real rectangle (Zhang & He, "Whiteboard scanning and
// image enhancement", 2007). Uses the perspective of the quad to recover the
// camera focal length and from it the true width/height ratio.

export interface AspectEstimate {
  /** width / height of the physical document */
  ratio: number;
  method: 'perspective' | 'prior' | 'edges';
  /** Focal length in pixels used for the estimate. */
  focal?: number;
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function edgeRatio(q: Quad): number {
  const [t, r, b, l] = edgeLengths(q);
  return Math.max(t, b) / Math.max(l, r);
}

export function estimateAspect(q: Quad, imgW: number, imgH: number): AspectEstimate {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  const m1: V3 = [q[0].x, q[0].y, 1]; // TL
  const m2: V3 = [q[1].x, q[1].y, 1]; // TR
  const m3: V3 = [q[3].x, q[3].y, 1]; // BL
  const m4: V3 = [q[2].x, q[2].y, 1]; // BR
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const fallback = (): AspectEstimate => ({ ratio: edgeRatio(q), method: 'edges' });
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return fallback();

  const maxDim = Math.max(imgW, imgH);
  const ratioWithFocal = (f: number) => {
    const toCam = (n: V3): V3 => [(n[0] - u0 * n[2]) / f, (n[1] - v0 * n[2]) / f, n[2]];
    const a = toCam(n2);
    const b = toCam(n3);
    return Math.sqrt(dot(a, a) / dot(b, b));
  };
  const valid = (r: number) => Number.isFinite(r) && r > 0.1 && r < 10;

  // With two vanishing points the focal length is observable.
  const nz = n2[2] * n3[2];
  if (Math.abs(n2[2]) > 1e-4 && Math.abs(n3[2]) > 1e-4) {
    const f2 =
      -(
        n2[0] * n3[0] -
        (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
        nz * u0 * u0 +
        (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + nz * v0 * v0)
      ) / nz;
    const f = Math.sqrt(f2);
    // Phone cameras: ~0.4×–4× the long side (ultra-wide .. tele). Outside => noise.
    if (f2 > 0 && f > 0.4 * maxDim && f < 4 * maxDim) {
      const ratio = ratioWithFocal(f);
      if (valid(ratio)) return { ratio, method: 'perspective', focal: f };
    }
  }

  // One (or no) vanishing point: f is not observable from the quad. Use the
  // typical main phone camera (~26 mm equivalent => f ≈ 0.75 × long side).
  const f = PRIOR_FOCAL * maxDim;
  const ratio = ratioWithFocal(f);
  return valid(ratio) ? { ratio, method: 'prior', focal: f } : fallback();
}

/** Focal length prior as a fraction of the image's long side (26 mm-equivalent lens). */
export const PRIOR_FOCAL = 0.75;

// ---------------------------------------------------------------------------
// Paper presets

export type AspectChoice = 'auto' | 'edges' | 'a4' | 'b5' | 'letter' | 'square';

export const PAPER: Record<Exclude<AspectChoice, 'auto' | 'edges'>, { label: string; ratio: number }> = {
  a4: { label: 'A4 (210×297)', ratio: 210 / 297 },
  b5: { label: 'B5 (182×257)', ratio: 182 / 257 },
  letter: { label: 'Letter (8.5×11)', ratio: 8.5 / 11 },
  square: { label: '정사각형', ratio: 1 },
};

/** Paper preset whose portrait/landscape ratio is within tol of `ratio`. */
export function nearestPaper(ratio: number, tol = 0.035): keyof typeof PAPER | null {
  let best: keyof typeof PAPER | null = null;
  let bestErr = tol;
  for (const key of Object.keys(PAPER) as (keyof typeof PAPER)[]) {
    const p = PAPER[key].ratio;
    for (const r of [p, 1 / p]) {
      const err = Math.abs(ratio - r) / r;
      if (err < bestErr) {
        bestErr = err;
        best = key;
      }
    }
  }
  return best;
}

/**
 * Output size for the flattened page. Keeps roughly the number of source
 * pixels the document covered (no upscaling), with the requested ratio,
 * capped at maxLong on the long side.
 */
export function outputSize(q: Quad, ratio: number, maxLong = 4000): { width: number; height: number } {
  const [t, r, b, l] = edgeLengths(q);
  const area = Math.max(t, b) * Math.max(l, r);
  let width = Math.sqrt(area * ratio);
  let height = Math.sqrt(area / ratio);
  const s = Math.min(1, maxLong / Math.max(width, height));
  width = Math.max(16, Math.round(width * s));
  height = Math.max(16, Math.round(height * s));
  return { width, height };
}

/** Resolves the page ratio for a user choice; presets follow the quad's orientation. */
export function resolveRatio(choice: AspectChoice, q: Quad, imgW: number, imgH: number): AspectEstimate {
  const est = estimateAspect(q, imgW, imgH);
  if (choice === 'auto') return est;
  if (choice === 'edges') return { ratio: edgeRatio(q), method: 'edges' };
  const p = PAPER[choice].ratio;
  const landscape = est.ratio > 1;
  return { ratio: landscape ? 1 / p : p, method: est.method };
}

// ---------------------------------------------------------------------------
// Synthetic camera (tests and the built-in sample image)

export interface CameraPose {
  /** document width / height */
  aspect: number;
  /** rotations in degrees */
  rx: number;
  ry: number;
  rz: number;
  /** distance in units of document height */
  distance: number;
  /** focal length in pixels */
  f: number;
  cx: number;
  cy: number;
  /** lateral offset of the document centre, in units of document height */
  tx?: number;
  ty?: number;
}

/** Projects a planar w×h rectangle through a pinhole camera; returns TL,TR,BR,BL. */
export function projectRectangle(p: CameraPose): Quad {
  const w = p.aspect;
  const h = 1;
  const rad = Math.PI / 180;
  const [ax, ay, az] = [p.rx * rad, p.ry * rad, p.rz * rad];
  const rot = (x: number, y: number, z: number): V3 => {
    // Rx
    let y1 = y * Math.cos(ax) - z * Math.sin(ax);
    let z1 = y * Math.sin(ax) + z * Math.cos(ax);
    let x1 = x;
    // Ry
    const x2 = x1 * Math.cos(ay) + z1 * Math.sin(ay);
    const z2 = -x1 * Math.sin(ay) + z1 * Math.cos(ay);
    x1 = x2;
    z1 = z2;
    // Rz
    const x3 = x1 * Math.cos(az) - y1 * Math.sin(az);
    y1 = x1 * Math.sin(az) + y1 * Math.cos(az);
    return [x3, y1, z1];
  };
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return corners.map(([x, y]) => {
    const [X, Y, Z0] = rot(x, y, 0);
    const Z = Z0 + p.distance;
    return {
      x: (p.f * (X + (p.tx ?? 0))) / Z + p.cx,
      y: (p.f * (Y + (p.ty ?? 0))) / Z + p.cy,
    };
  }) as Quad;
}
