// On-device storage (IndexedDB). Documents hold an ordered list of page ids;
// each page keeps its original photo plus every setting, so it can be
// re-cropped or re-processed later without quality loss.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AspectChoice, Quad } from './geometry';
import type { Mode, ResolvedMode } from './cv/pipeline';

export interface DocRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pageIds: string[];
}

export type DetectState = 'found' | 'guess' | 'none' | 'manual';

export interface PageRecord {
  id: string;
  docId: string;
  createdAt: number;
  /** The photo as picked (camera JPEG), untouched. */
  source: Blob;
  /** Quarter turns clockwise applied to the source before cropping. */
  rotation: number;
  /** Corners as fractions (0..1) of the rotated source, TL, TR, BR, BL. */
  quad: Quad;
  mode: Mode;
  aspect: AspectChoice;
  detect: DetectState;
  /** Processed page (JPEG, or PNG for black & white). */
  result: Blob;
  resultMode: ResolvedMode;
  width: number;
  height: number;
  /** Small JPEG for lists. */
  thumb: Blob;
  /** Extra photos of the same page used to remove reflections. */
  extras?: ExtraShotRecord[];
  /** Reflection detection sensitivity chosen for this page (0..100). */
  glareSensitivity?: number;
}

export interface ExtraShotRecord {
  source: Blob;
  rotation: number;
  /** Corners as fractions (0..1) of this rotated photo. */
  quad: Quad;
}

/**
 * Images are stored as raw bytes, not Blobs. iOS WebKit (notably in-app
 * browsers) can fail to display or read Blobs that come back out of
 * IndexedDB ("WebKitBlobResource error 1"); ArrayBuffers are copied into
 * memory and always work. Pages saved earlier as Blobs are still read.
 */
interface Bytes {
  buf: ArrayBuffer;
  type: string;
}
const BINARY = ['source', 'result', 'thumb'] as const;
type BinaryKey = (typeof BINARY)[number];
type StoredExtra = Omit<ExtraShotRecord, 'source'> & { source: Bytes | Blob };
type StoredPage = Omit<PageRecord, BinaryKey | 'extras'> & Record<BinaryKey, Bytes | Blob> & { extras?: StoredExtra[] };

const toBytes = async (b: Blob): Promise<Bytes> => ({ buf: await b.arrayBuffer(), type: b.type });
const toBlob = (v: Bytes | Blob): Blob => (v && 'buf' in v ? new Blob([v.buf], { type: v.type }) : (v as Blob));

async function toStored(p: PageRecord): Promise<StoredPage> {
  const out = { ...p } as unknown as StoredPage;
  for (const k of BINARY) out[k] = await toBytes(p[k]);
  if (p.extras) out.extras = await Promise.all(p.extras.map(async (e) => ({ ...e, source: await toBytes(e.source) })));
  return out;
}

function fromStored(s: StoredPage): PageRecord {
  const out = { ...s } as unknown as PageRecord;
  for (const k of BINARY) out[k] = toBlob(s[k]);
  if (s.extras) out.extras = s.extras.map((e) => ({ ...e, source: toBlob(e.source) }));
  return out;
}

interface Schema extends DBSchema {
  docs: { key: string; value: DocRecord };
  pages: { key: string; value: StoredPage; indexes: { docId: string } };
}

export type Store = ReturnType<typeof createStore>;

/** Moves one element of a list (returns a new array). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

export function defaultDocName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `스캔 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function createStore(dbName = 'scanner') {
  let dbp: Promise<IDBPDatabase<Schema>> | null = null;
  const db = () =>
    (dbp ??= openDB<Schema>(dbName, 1, {
      upgrade(d) {
        d.createObjectStore('docs', { keyPath: 'id' });
        const pages = d.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('docId', 'docId');
      },
    }));

  return {
    async listDocs(): Promise<DocRecord[]> {
      const all = await (await db()).getAll('docs');
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    async getDoc(id: string): Promise<DocRecord | undefined> {
      return (await db()).get('docs', id);
    },

    async createDoc(name = defaultDocName()): Promise<DocRecord> {
      const now = Date.now();
      const doc: DocRecord = { id: uid(), name, createdAt: now, updatedAt: now, pageIds: [] };
      await (await db()).put('docs', doc);
      return doc;
    },

    async renameDoc(id: string, name: string): Promise<DocRecord | undefined> {
      const d = await db();
      const doc = await d.get('docs', id);
      if (!doc) return undefined;
      const next = { ...doc, name: name.trim() || doc.name, updatedAt: Date.now() };
      await d.put('docs', next);
      return next;
    },

    async deleteDoc(id: string): Promise<void> {
      const d = await db();
      const tx = d.transaction(['docs', 'pages'], 'readwrite');
      const keys = await tx.objectStore('pages').index('docId').getAllKeys(id);
      await Promise.all([...keys.map((k) => tx.objectStore('pages').delete(k)), tx.objectStore('docs').delete(id)]);
      await tx.done;
    },

    /** Pages in document order. */
    async getPages(docId: string): Promise<PageRecord[]> {
      const d = await db();
      const doc = await d.get('docs', docId);
      if (!doc) return [];
      const pages = await d.getAllFromIndex('pages', 'docId', docId);
      const byId = new Map(pages.map((p) => [p.id, p]));
      return doc.pageIds
        .map((id) => byId.get(id))
        .filter((p): p is StoredPage => !!p)
        .map(fromStored);
    },

    async getPage(id: string): Promise<PageRecord | undefined> {
      const p = await (await db()).get('pages', id);
      return p && fromStored(p);
    },

    /** Inserts a new page (appended, or at `index`) or replaces an existing one. */
    async savePage(page: Omit<PageRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: number }, index?: number): Promise<PageRecord> {
      const d = await db();
      // Read the bytes first: an IndexedDB transaction closes if we await
      // anything else while it is open.
      const stored = await toStored({ ...page, id: page.id ?? uid(), createdAt: page.createdAt ?? 0 });
      const tx = d.transaction(['docs', 'pages'], 'readwrite');
      const doc = await tx.objectStore('docs').get(page.docId);
      if (!doc) throw new Error('문서를 찾을 수 없습니다');
      const existing = page.id ? await tx.objectStore('pages').get(page.id) : undefined;
      stored.createdAt = page.createdAt ?? existing?.createdAt ?? Date.now();
      const rec: PageRecord = { ...page, id: stored.id, createdAt: stored.createdAt };
      await tx.objectStore('pages').put(stored);
      const pageIds = doc.pageIds.includes(rec.id)
        ? doc.pageIds
        : index === undefined
          ? [...doc.pageIds, rec.id]
          : moveItem([...doc.pageIds, rec.id], doc.pageIds.length, index);
      await tx.objectStore('docs').put({ ...doc, pageIds, updatedAt: Date.now() });
      await tx.done;
      return rec;
    },

    async deletePage(docId: string, pageId: string): Promise<void> {
      const d = await db();
      const tx = d.transaction(['docs', 'pages'], 'readwrite');
      const doc = await tx.objectStore('docs').get(docId);
      await tx.objectStore('pages').delete(pageId);
      if (doc) await tx.objectStore('docs').put({ ...doc, pageIds: doc.pageIds.filter((p) => p !== pageId), updatedAt: Date.now() });
      await tx.done;
    },

    async movePage(docId: string, from: number, to: number): Promise<DocRecord | undefined> {
      const d = await db();
      const doc = await d.get('docs', docId);
      if (!doc) return undefined;
      const next = { ...doc, pageIds: moveItem(doc.pageIds, from, to), updatedAt: Date.now() };
      await d.put('docs', next);
      return next;
    },

    close() {
      void dbp?.then((d) => d.close());
      dbp = null;
    },
  };
}

/** Asks the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
