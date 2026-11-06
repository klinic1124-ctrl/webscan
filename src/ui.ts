// Shared UI constants and helpers.
import { useEffect, useState } from 'react';
import type { Mode, ResolvedMode } from './lib/cv/pipeline';
import type { AspectChoice, Quad } from './lib/geometry';

export const MODES: { id: Mode; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'color', label: '컬러 문서' },
  { id: 'gray', label: '회색조' },
  { id: 'bw', label: '흑백' },
  { id: 'photo', label: '사진·그림' },
];

export const MODE_NAME: Record<ResolvedMode, string> = {
  color: '컬러',
  gray: '회색조',
  bw: '흑백',
  photo: '사진',
};

export const ASPECTS: { id: AspectChoice; label: string }[] = [
  { id: 'auto', label: '자동 추정' },
  { id: 'a4', label: 'A4' },
  { id: 'b5', label: 'B5' },
  { id: 'letter', label: 'Letter' },
  { id: 'edges', label: '변 길이' },
];

/** Reflection detection sensitivity used unless the user moves the slider. */
export const DEFAULT_GLARE_SENSITIVITY = 50;

export interface EngineInfo {
  ms: number;
  version: string;
  simd: boolean;
  threads: boolean;
}

export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Object URL for a blob, revoked when the blob changes or the component unmounts. */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/** Starts a file download (ordinary browsers; iOS shows a preview with a share button). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * True when the app runs inside another page's frame (e.g. a preview link).
 * Such frames usually block downloads and the share sheet.
 */
export function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent
  }
}

export function canShareFiles(files: File[]): boolean {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

/** Shares files through the system sheet. Returns false if cancelled or unsupported. */
export async function shareFiles(files: File[]): Promise<boolean> {
  try {
    // Files only: on iOS a title or text is saved as an extra .txt file
    // next to them ("Save to Files").
    await navigator.share({ files });
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return false;
    throw e;
  }
}

/** Removes characters that file systems reject. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'scan';
}

export function extFor(type: string) {
  return type === 'image/png' ? 'png' : 'jpg';
}

export const normalizeQuad = (q: Quad, w: number, h: number): Quad => q.map((p) => ({ x: p.x / w, y: p.y / h })) as Quad;
export const denormalizeQuad = (q: Quad, w: number, h: number): Quad => q.map((p) => ({ x: p.x * w, y: p.y * h })) as Quad;
