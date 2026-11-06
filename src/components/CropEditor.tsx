import { useEffect, useRef, useState } from 'react';
import { clampQuad, type Point, type Quad } from '../lib/geometry';

interface Props {
  previewUrl: string;
  /** Full-resolution source size; the quad is in these coordinates. */
  width: number;
  height: number;
  quad: Quad;
  onChange: (q: Quad) => void;
}

type Drag = { kind: 'corner' | 'edge'; index: number; last: Point; pointerId: number };

const HANDLE_PX = 11; // visible radius in screen px
const HIT_PX = 26; // touch target radius
const LOUPE_PX = 132;
const LOUPE_ZOOM = 3;

/**
 * Four corner handles plus four edge handles over the photo. While a corner
 * is dragged, a magnifier shows the area under the finger in the opposite
 * top corner so the finger never hides the point being placed.
 */
export function CropEditor({ previewUrl, width, height, quad, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1); // source px per screen px
  const [drag, setDrag] = useState<Drag | null>(null);
  const quadRef = useRef(quad);
  quadRef.current = quad;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(width / Math.max(1, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const toImage = (e: React.PointerEvent): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };

  const start = (kind: Drag['kind'], index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ kind, index, last: toImage(e), pointerId: e.pointerId });
  };

  const move = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = toImage(e);
    const q = quadRef.current.map((c) => ({ ...c })) as Quad;
    if (drag.kind === 'corner') {
      q[drag.index] = p;
    } else {
      const dx = p.x - drag.last.x;
      const dy = p.y - drag.last.y;
      for (const i of [drag.index, (drag.index + 1) % 4]) {
        q[i] = { x: q[i].x + dx, y: q[i].y + dy };
      }
    }
    setDrag({ ...drag, last: p });
    onChange(clampQuad(q, width, height));
  };

  const end = (e: React.PointerEvent) => {
    if (drag && e.pointerId === drag.pointerId) setDrag(null);
  };

  // Magnifier
  const active = drag?.kind === 'corner' ? quad[drag.index] : null;
  useEffect(() => {
    const canvas = loupeRef.current;
    const img = imgRef.current;
    if (!active || !canvas || !img || !img.naturalWidth) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = LOUPE_PX * dpr;
    canvas.height = LOUPE_PX * dpr;
    const ctx = canvas.getContext('2d')!;
    // Work in preview-image pixels (the <img> may be a downscaled copy; use
    // separate x/y factors because each side was rounded on its own).
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const fx = iw / width;
    const fy = ih / height;
    const span = (LOUPE_PX / LOUPE_ZOOM) * scale; // source px shown across the loupe
    const sw = span * fx;
    const sh = span * fy;
    const sx = active.x * fx - sw / 2;
    const sy = active.y * fy - sh / 2;
    const kx = canvas.width / sw; // canvas px per preview px
    const ky = canvas.height / sh;
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Clip the source rectangle to the image ourselves: near the photo's edge
    // it sticks out, and Safari then stretches the visible part over the
    // whole loupe instead of leaving the outside empty, which shifts the view
    // away from the crosshair.
    const x0 = Math.max(0, sx);
    const y0 = Math.max(0, sy);
    const x1 = Math.min(iw, sx + sw);
    const y1 = Math.min(ih, sy + sh);
    if (x1 > x0 && y1 > y0) {
      ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * kx, (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
    }
    // adjacent edges
    const toL = (p: Point) => [(p.x * fx - sx) * kx, (p.y * fy - sy) * ky] as const;
    const i = drag!.index;
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(...toL(quad[(i + 3) % 4]));
    ctx.lineTo(...toL(active));
    ctx.lineTo(...toL(quad[(i + 1) % 4]));
    ctx.stroke();
    ctx.strokeStyle = '#ff7a45';
    ctx.lineWidth = 1 * dpr;
    const c = canvas.width / 2;
    ctx.beginPath();
    ctx.moveTo(c - 10 * dpr, c);
    ctx.lineTo(c + 10 * dpr, c);
    ctx.moveTo(c, c - 10 * dpr);
    ctx.lineTo(c, c + 10 * dpr);
    ctx.stroke();
  }, [active, drag, quad, scale, width, height]);

  const pts = quad.map((p) => `${p.x},${p.y}`).join(' ');
  const r = HANDLE_PX * scale;
  const hit = HIT_PX * scale;
  const loupeLeft = active ? active.x > width / 2 : false;

  return (
    <div
      className="crop"
      ref={wrapRef}
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `calc(62vh * ${width / height})` }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img ref={imgRef} src={previewUrl} alt="촬영한 사진" draggable={false} />
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="문서 영역 편집">
        <path
          className="crop-shade"
          fillRule="evenodd"
          d={`M0 0H${width}V${height}H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(' L')}Z`}
        />
        <polygon className="crop-outline" points={pts} strokeWidth={2 * scale} />
        {quad.map((p, i) => {
          const n = quad[(i + 1) % 4];
          const mx = (p.x + n.x) / 2;
          const my = (p.y + n.y) / 2;
          return (
            <g key={`e${i}`} className="crop-handle edge" onPointerDown={start('edge', i)}>
              <circle cx={mx} cy={my} r={hit} className="hit" />
              <rect x={mx - r * 0.9} y={my - r * 0.9} width={r * 1.8} height={r * 1.8} rx={r * 0.5} strokeWidth={2 * scale} />
            </g>
          );
        })}
        {quad.map((p, i) => (
          <g
            key={`c${i}`}
            className={`crop-handle corner${drag?.kind === 'corner' && drag.index === i ? ' on' : ''}`}
            onPointerDown={start('corner', i)}
          >
            <circle cx={p.x} cy={p.y} r={hit} className="hit" />
            <circle cx={p.x} cy={p.y} r={r} strokeWidth={2.5 * scale} />
          </g>
        ))}
      </svg>
      {active && (
        <canvas
          ref={loupeRef}
          className="loupe"
          style={{ width: LOUPE_PX, height: LOUPE_PX, [loupeLeft ? 'left' : 'right']: 8 }}
        />
      )}
    </div>
  );
}
