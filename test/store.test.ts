import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { createStore, moveItem, type PageRecord } from '../src/lib/store';
import type { Quad } from '../src/lib/geometry';

const quad: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];

function page(docId: string, label: string): Omit<PageRecord, 'id' | 'createdAt'> {
  return {
    docId,
    source: new Blob([`src-${label}`], { type: 'image/jpeg' }),
    rotation: 0,
    quad,
    mode: 'auto',
    aspect: 'auto',
    detect: 'found',
    result: new Blob([`res-${label}`], { type: 'image/jpeg' }),
    resultMode: 'gray',
    width: 100,
    height: 141,
    thumb: new Blob([`th-${label}`], { type: 'image/jpeg' }),
  };
}

let n = 0;
const fresh = () => createStore(`test-${n++}`);

describe('moveItem', () => {
  it('moves forward and backward, clamping the target', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 1, 99)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('store', () => {
  it('keeps pages in document order across add, move, insert and delete', async () => {
    const s = fresh();
    const doc = await s.createDoc('계약서');
    const a = await s.savePage(page(doc.id, 'a'));
    const b = await s.savePage(page(doc.id, 'b'));
    const c = await s.savePage(page(doc.id, 'c'));
    await s.movePage(doc.id, 2, 0); // c a b
    const d = await s.savePage(page(doc.id, 'd'), 1); // c d a b
    await s.deletePage(doc.id, a.id); // c d b
    const pages = await s.getPages(doc.id);
    expect(pages.map((p) => p.id)).toEqual([c.id, d.id, b.id]);
    expect(await pages[0].source.text()).toBe('src-c');
  });

  it('replaces a page in place when saved again with its id', async () => {
    const s = fresh();
    const doc = await s.createDoc();
    const a = await s.savePage(page(doc.id, 'a'));
    await s.savePage(page(doc.id, 'b'));
    await s.savePage({ ...a, mode: 'bw', resultMode: 'bw' });
    const pages = await s.getPages(doc.id);
    expect(pages).toHaveLength(2);
    expect(pages[0].id).toBe(a.id);
    expect(pages[0].mode).toBe('bw');
  });

  it('lists documents newest first and deletes a document with its pages', async () => {
    const s = fresh();
    const first = await s.createDoc('첫째');
    await new Promise((r) => setTimeout(r, 5));
    const second = await s.createDoc('둘째');
    await new Promise((r) => setTimeout(r, 5)); // distinct timestamps for a stable order
    const p = await s.savePage(page(first.id, 'x'));
    expect((await s.listDocs()).map((d) => d.name)).toEqual(['첫째', '둘째']); // first was updated by savePage
    await s.renameDoc(second.id, '  ');
    expect((await s.getDoc(second.id))?.name).toBe('둘째');
    await s.deleteDoc(first.id);
    expect(await s.getPage(p.id)).toBeUndefined();
    expect((await s.listDocs()).map((d) => d.id)).toEqual([second.id]);
  });

  it('stores images as bytes and still reads pages saved as Blobs', async () => {
    const name = `test-${n++}`;
    const s = createStore(name);
    const doc = await s.createDoc();
    const a = await s.savePage(page(doc.id, 'a'));

    const raw = await openDB(name);
    const rec = await raw.get('pages', a.id);
    expect(rec.thumb.buf).toBeInstanceOf(ArrayBuffer);
    expect(rec.thumb.type).toBe('image/jpeg');

    // A page written by the earlier version (Blob fields) is still readable.
    const old = { ...page(doc.id, 'old'), id: 'legacy', createdAt: 1 };
    await raw.put('pages', old);
    await raw.put('docs', { ...(await raw.get('docs', doc.id)), pageIds: [a.id, 'legacy'] });
    raw.close();

    const pages = await s.getPages(doc.id);
    expect(await pages[0].thumb.text()).toBe('th-a');
    expect(pages[0].thumb.type).toBe('image/jpeg');
    expect(await pages[1].result.text()).toBe('res-old');
  });

  it('keeps extra photos (for reflection removal) with the page', async () => {
    const s = fresh();
    const doc = await s.createDoc();
    const a = await s.savePage({
      ...page(doc.id, 'a'),
      extras: [{ source: new Blob(['extra-1'], { type: 'image/jpeg' }), rotation: 1, quad }],
    });
    const [p] = await s.getPages(doc.id);
    expect(p.id).toBe(a.id);
    expect(p.extras).toHaveLength(1);
    expect(p.extras![0].rotation).toBe(1);
    expect(await p.extras![0].source.text()).toBe('extra-1');
  });
});
