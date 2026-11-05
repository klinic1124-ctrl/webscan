// Main-thread side: worker client and image decoding.
import * as Comlink from 'comlink';
import type { ScannerApi } from './worker/scanner.worker';

export type { ScanResult, SourceInfo } from './worker/scanner.worker';

let client: Comlink.Remote<ScannerApi> | null = null;

export function scanner(): Comlink.Remote<ScannerApi> {
  if (!client) {
    const worker = new Worker(new URL('./worker/scanner.worker.ts', import.meta.url), { type: 'module' });
    client = Comlink.wrap<ScannerApi>(worker);
  }
  return client;
}

/**
 * Decodes a photo with its EXIF orientation applied. Falls back to an <img>
 * element for formats createImageBitmap cannot read directly.
 */
export async function decodeFile(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export function deviceSummary() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGB: nav.deviceMemory ?? null,
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
  };
}
