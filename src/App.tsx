import { transfer } from 'comlink';
import { useCallback, useEffect, useState } from 'react';
import { DocumentView } from './components/DocumentView';
import { Editor, type EditSession, type SavedPage } from './components/Editor';
import { Library } from './components/Library';
import type { DetectResult } from './lib/cv/pipeline';
import type { SampleKind } from './lib/cv/synthetic';
import { createStore, requestPersistence, type DetectState, type PageRecord } from './lib/store';
import { decodeFile, scanner } from './scanner';
import { denormalizeQuad, fmtMs, normalizeQuad, type EngineInfo } from './ui';

const store = createStore();

type View = { name: 'library' } | { name: 'doc'; docId: string } | { name: 'edit'; session: EditSession };

const SAMPLE_NAME: Record<SampleKind, string> = { text: '서류', music: '악보', photo: '사진' };

const detectStateOf = (d: DetectResult): DetectState => (d.found ? 'found' : d.guess ? 'guess' : 'none');

/** Decodes a photo, hands it to the worker and applies the stored rotation. */
async function loadSource(blob: Blob, rotation: number) {
  const t = performance.now();
  const bmp = await decodeFile(blob);
  const decode = Math.round(performance.now() - t);
  // Transfer (not copy) the decoded bitmap to the worker.
  let info = await scanner().loadBitmap(transfer(bmp, [bmp]));
  for (let i = 0; i < rotation; i++) info = await scanner().rotate();
  return { info, timings: { decode, ...info.timings } };
}

async function newSession(docId: string, source: Blob, sourceName: string): Promise<EditSession> {
  const { info, timings } = await loadSource(source, 0);
  const t = performance.now();
  const detect = await scanner().detect();
  return {
    docId,
    source,
    sourceName,
    info,
    rotation: 0,
    quad: detect.quad,
    mode: 'auto',
    aspect: 'auto',
    detect,
    detectState: detectStateOf(detect),
    loadTimings: { ...timings, detect: Math.round(performance.now() - t) },
  };
}

export function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: 'library' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped whenever pages change behind an open document view. */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    scanner()
      .init()
      .then(setEngine)
      .catch((e) => setEngineError(String(e?.message ?? e)));
    void requestPersistence();
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view.name]);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  /** One photo → editor; several → processed automatically into the document. */
  const importFiles = (docId: string | null, files: File[], fromCamera: boolean) =>
    void run('사진을 읽는 중', async () => {
      const id = docId ?? (await store.createDoc()).id;
      if (files.length === 1) {
        const name = fromCamera ? 'camera' : files[0].name.replace(/\.[^.]+$/, '');
        setView({ name: 'edit', session: await newSession(id, files[0], name) });
        return;
      }
      for (let i = 0; i < files.length; i++) {
        setBusy(`사진 처리 중 ${i + 1}/${files.length}`);
        const { info } = await loadSource(files[i], 0);
        const detect = await scanner().detect();
        const r = await scanner().scan(detect.quad, { mode: 'auto', aspect: 'auto' });
        await store.savePage({
          docId: id,
          source: files[i],
          rotation: 0,
          quad: normalizeQuad(detect.quad, info.width, info.height),
          mode: 'auto',
          aspect: 'auto',
          detect: detectStateOf(detect),
          result: r.blob,
          resultMode: r.mode,
          width: r.width,
          height: r.height,
          thumb: r.thumb,
        });
      }
      setView({ name: 'doc', docId: id });
      setRevision((r) => r + 1);
    });

  const startSample = (kind: SampleKind) =>
    void run('샘플을 만드는 중', async () => {
      const doc = await store.createDoc(`샘플 ${SAMPLE_NAME[kind]}`);
      const info = await scanner().loadSample(kind);
      const source = await scanner().exportSource();
      const t = performance.now();
      const detect = await scanner().detect();
      setView({
        name: 'edit',
        session: {
          docId: doc.id,
          source,
          sourceName: `sample-${kind}`,
          info,
          rotation: 0,
          quad: detect.quad,
          mode: 'auto',
          aspect: 'auto',
          detect,
          detectState: detectStateOf(detect),
          loadTimings: { ...info.timings, detect: Math.round(performance.now() - t) },
        },
      });
    });

  const editPage = (page: PageRecord) =>
    void run('페이지를 여는 중', async () => {
      const { info, timings } = await loadSource(page.source, page.rotation);
      setView({
        name: 'edit',
        session: {
          docId: page.docId,
          pageId: page.id,
          source: page.source,
          sourceName: 'page',
          info,
          rotation: page.rotation,
          quad: denormalizeQuad(page.quad, info.width, info.height),
          mode: page.mode,
          aspect: page.aspect,
          detect: null,
          detectState: page.detect,
          loadTimings: timings,
        },
      });
    });

  const savePage = async ({ session, quad, rotation, info, mode, aspect, detectState, result }: SavedPage) => {
    await store.savePage(
      {
        id: session.pageId,
        docId: session.docId,
        source: session.source,
        rotation,
        quad: normalizeQuad(quad, info.width, info.height),
        mode,
        aspect,
        detect: detectState,
        result: result.blob,
        resultMode: result.mode,
        width: result.width,
        height: result.height,
        thumb: result.thumb,
      },
      session.insertAt,
    );
    setView({ name: 'doc', docId: session.docId });
  };

  const cancelEdit = useCallback(
    (session: EditSession) =>
      void run('돌아가는 중', async () => {
        // A brand-new document that never got a page is dropped again.
        const doc = await store.getDoc(session.docId);
        if (doc && doc.pageIds.length === 0) {
          await store.deleteDoc(doc.id);
          setView({ name: 'library' });
        } else {
          setView({ name: 'doc', docId: session.docId });
        }
      }),
    [run],
  );

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => view.name !== 'library' && !busy && setView({ name: 'library' })} aria-label="보관함으로">
          <span className="mark" aria-hidden="true" />
          <span>
            <span className="title">문서 스캐너</span>
            <span className="sub">
              사진은 이 기기 밖으로 나가지 않습니다 · <span className="mono">{__BUILD_ID__}</span>
            </span>
          </span>
        </button>
        <span className={`engine ${engine ? 'ok' : engineError ? 'bad' : ''}`}>
          {engine ? `엔진 준비 ${fmtMs(engine.ms)}` : engineError ? '엔진 오류' : '엔진 불러오는 중…'}
        </span>
      </header>

      {engineError && <p className="alert bad">영상 처리 엔진을 불러오지 못했습니다: {engineError}</p>}
      {error && (
        <p className="alert bad" role="alert">
          {error}
        </p>
      )}

      {view.name === 'library' && (
        <Library
          store={store}
          busy={!!busy}
          engineReady={!!engine}
          run={run}
          onOpen={(docId) => setView({ name: 'doc', docId })}
          onImport={(files, cam) => importFiles(null, files, cam)}
          onSample={startSample}
        />
      )}
      {view.name === 'doc' && (
        <DocumentView
          store={store}
          docId={view.docId}
          revision={revision}
          busy={!!busy}
          engineReady={!!engine}
          run={run}
          onBack={() => setView({ name: 'library' })}
          onImport={(files, cam) => importFiles(view.docId, files, cam)}
          onEditPage={editPage}
          onError={setError}
        />
      )}
      {view.name === 'edit' && (
        <Editor
          session={view.session}
          engine={engine}
          busy={!!busy}
          run={run}
          onCancel={() => cancelEdit(view.session)}
          onSave={savePage}
        />
      )}

      {busy && (
        <div className="busy" role="status">
          <span className="spinner" aria-hidden="true" />
          {busy}…
        </div>
      )}
    </div>
  );
}
