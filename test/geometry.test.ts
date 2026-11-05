import { describe, expect, it } from 'vitest';
import {
  dist,
  estimateAspect,
  fitLine,
  interiorAngles,
  intersectLines,
  isConvex,
  nearestPaper,
  orderCorners,
  outputSize,
  projectRectangle,
  refineQuadWithEdges,
  rotateQuadCW,
  type Point,
  type Quad,
} from '../src/lib/geometry';

const A4 = 210 / 297;

describe('orderCorners', () => {
  it('orders shuffled points as TL, TR, BR, BL', () => {
    const q = orderCorners([
      { x: 90, y: 110 },
      { x: 10, y: 5 },
      { x: 5, y: 100 },
      { x: 100, y: 0 },
    ]);
    expect(q).toEqual([
      { x: 10, y: 5 },
      { x: 100, y: 0 },
      { x: 90, y: 110 },
      { x: 5, y: 100 },
    ]);
  });

  it('handles a quad rotated by ~45°', () => {
    const q = orderCorners([
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ]);
    expect(isConvex(q)).toBe(true);
    // clockwise on screen
    expect(q[1].x).toBeGreaterThan(q[0].x - 1e-9);
  });
});

describe('convexity and angles', () => {
  it('detects a self-intersecting (bow-tie) quad', () => {
    const bow: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(isConvex(bow)).toBe(false);
  });

  it('angles of a rectangle are 90°', () => {
    const r: Quad = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ];
    for (const a of interiorAngles(r)) expect(a).toBeCloseTo(90, 6);
  });
});

describe('line fitting', () => {
  it('fits and intersects two noisy lines', () => {
    const h: Point[] = [];
    const v: Point[] = [];
    for (let i = 0; i < 100; i++) {
      h.push({ x: i, y: 20 + 0.1 * i + (i % 2 ? 0.2 : -0.2) });
      v.push({ x: 50 + (i % 2 ? 0.2 : -0.2), y: i });
    }
    const p = intersectLines(fitLine(h)!, fitLine(v)!)!;
    expect(p.x).toBeCloseTo(50, 0);
    expect(p.y).toBeCloseTo(25, 0);
  });

  it('refines a slightly wrong quad onto edge pixels', () => {
    const truth: Quad = [
      { x: 100, y: 80 },
      { x: 500, y: 100 },
      { x: 480, y: 620 },
      { x: 90, y: 600 },
    ];
    const edges: Point[] = [];
    for (let i = 0; i < 4; i++) {
      const a = truth[i];
      const b = truth[(i + 1) % 4];
      for (let t = 0; t <= 1; t += 0.005) edges.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    const rough = truth.map((p, i) => ({ x: p.x + (i % 2 ? 3 : -3), y: p.y + 2 })) as Quad;
    const refined = refineQuadWithEdges(rough, edges, 8, 20);
    refined.forEach((p, i) => expect(dist(p, truth[i])).toBeLessThan(0.5));
  });
});

describe('aspect estimation (Zhang & He)', () => {
  const W = 4032;
  const H = 3024;
  const base = { aspect: A4, f: 3000, cx: W / 2, cy: H / 2, distance: 2.4 };
  const poses = [
    { rx: 25, ry: 0, rz: 3 },
    { rx: 30, ry: 15, rz: -8 },
    { rx: -20, ry: 25, rz: 12, tx: 0.2 },
    { rx: 35, ry: -10, rz: 90 },
  ];

  for (const pose of poses) {
    it(`recovers A4 ratio for pose ${JSON.stringify(pose)}`, () => {
      const q = orderCorners(projectRectangle({ ...base, ...pose }));
      const est = estimateAspect(q, W, H);
      const truth = Math.abs(pose.rz) === 90 ? 1 / A4 : A4;
      expect(['perspective', 'prior']).toContain(est.method);
      expect(Math.abs(est.ratio - truth) / truth).toBeLessThan(0.01);
      if (est.method === 'perspective') expect(Math.abs(est.focal! - 3000) / 3000).toBeLessThan(0.02);
    });
  }

  it('falls back gracefully when the photo is taken straight on', () => {
    const q = orderCorners(projectRectangle({ ...base, rx: 0, ry: 0, rz: 0 }));
    const est = estimateAspect(q, W, H);
    expect(est.method).not.toBe('perspective');
    expect(est.ratio).toBeCloseTo(A4, 3);
  });

  it('is more accurate than raw edge lengths under strong tilt', () => {
    const q = orderCorners(projectRectangle({ ...base, rx: 40, ry: 0, rz: 0 }));
    const [t, , b] = [dist(q[0], q[1]), 0, dist(q[2], q[3])];
    const naive = Math.max(t, b) / Math.max(dist(q[1], q[2]), dist(q[3], q[0]));
    const est = estimateAspect(q, W, H);
    expect(Math.abs(naive - A4)).toBeGreaterThan(0.05);
    expect(Math.abs(est.ratio - A4)).toBeLessThan(0.01);
  });
});

describe('paper presets and output size', () => {
  it('snaps to A4 and Letter in both orientations', () => {
    expect(nearestPaper(0.707)).toBe('a4');
    expect(nearestPaper(1.414)).toBe('a4');
    expect(nearestPaper(0.773)).toBe('letter');
    expect(nearestPaper(0.55)).toBeNull();
  });

  it('keeps the requested ratio and caps the long side', () => {
    const q: Quad = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
      { x: 3000, y: 4200 },
      { x: 0, y: 4200 },
    ];
    const s = outputSize(q, A4, 4000);
    expect(Math.max(s.width, s.height)).toBe(4000);
    expect(s.width / s.height).toBeCloseTo(A4, 2);
  });

  it('rotates a quad with its image', () => {
    const q: Quad = [
      { x: 10, y: 20 },
      { x: 90, y: 20 },
      { x: 90, y: 60 },
      { x: 10, y: 60 },
    ];
    const r = rotateQuadCW(q, 100, 80);
    expect(r[0]).toEqual({ x: 19, y: 10 });
    expect(r[2]).toEqual({ x: 59, y: 90 });
  });
});
