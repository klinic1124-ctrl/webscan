import { transfer } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentView } from './components/DocumentView';
import { Editor, type EditSession, type SavedPage, type Shot } from './components/Editor';
import { Library } from './components/Library';
import { LiveCamera, liveCameraSupported } from './components/LiveCamera';
import type { DetectResult } from './lib/cv/pipeline';
import type { SampleKind } from './lib/cv/synthetic';
import { createStore, requestPersistence, type DetectState, type ExtraShotRecord, type PageRecord } from './lib/store';
import { decodeFile, scanner, type SourceInfo } from './scanner';
import { DEFAULT_GLARE_SENSITIVITY, denormalizeQuad, fmtMs, normalizeQuad, type EngineInfo } from './ui';

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

/** Adds a stored extra photo (reflection removal) back into the worker. */
async function loadExtra(e: ExtraShotRecord): Promise<Shot> {
  const bmp = await decodeFile(e.source);
  let info: SourceInfo = await scanner().addShot(transfer(bmp, [bmp]));
  const index = await scanner().shotCount() - 1;
  for (let i = 0; i < e.rotation; i++) info = await scanner().rotate(index);
  return { source: e.source, info, rotation: e.rotation, quad: denormalizeQuad(e.quad, info.width, info.height) };
}

async function newSession(docId: string, source: Blob, sourceName: string): Promise<EditSession> {
  const { info, timings } = await loadSource(source, 0);
  const t = performance.now();
  const detect = await scanner().detect();
  return {
    docId,
    sourceName,
    shots: [{ source, info, rotation: 0, quad: detect.quad }],
    mode: 'auto',
    aspect: 'auto',
    glareSensitivity: DEFAULT_GLARE_SENSITIVITY,
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

  const run = useCallback(async <T,>(label: string, fn: (status: (label: string) => void) => Promise<T>): Promise<T | undefined> => {
    setBusy(label);
    setError(null);
    try {
      return await fn(setBusy);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);

  /** Detects, processes with automatic settings and saves one photo as a page. */
  const autoPage = async (docId: string, photo: Blob) => {
    const { info } = await loadSource(photo, 0);
    const detect = await scanner().detect();
    const r = await scanner().scan(detect.quad, { mode: 'auto', aspect: 'auto' });
    await store.savePage({
      docId,
      source: photo,
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
  };

  // Live camera. In continuous mode each shot becomes a page right away and
  // the camera stays open; the document is created with the first page.
  const [camera, setCamera] = useState<{ docId: string | null; saved: number } | null>(null);
  const cameraDoc = useRef<string | null>(null);
  const openCamera = (docId: string | null) => {
    cameraDoc.current = docId;
    setCamera({ docId, saved: 0 });
  };
  const onCameraShot = async (photo: Blob, continuous: boolean) => {
    if (!continuous) {
      setCamera(null);
      importFiles(cameraDoc.current, [new File([photo], 'camera.jpg', { type: photo.type })], true);
      return;
    }
    try {
      const id = cameraDoc.current ?? (await store.createDoc()).id;
      cameraDoc.current = id;
      await autoPage(id, photo);
      setCamera((c) => (c ? { docId: id, saved: c.saved + 1 } : c));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const closeCamera = () => {
    const saved = camera?.saved ?? 0;
    setCamera(null);
    if (saved > 0 && cameraDoc.current) {
      setView({ name: 'doc', docId: cameraDoc.current });
      setRevision((r) => r + 1);
    }
  };
  const cameraNative = (file: File) => {
    setCamera(null);
    importFiles(cameraDoc.current, [file], true);
  };
  const canLive = liveCameraSupported();

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
        await autoPage(id, files[i]);
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
          sourceName: `sample-${kind}`,
          shots: [{ source, info, rotation: 0, quad: detect.quad }],
          mode: 'auto',
          aspect: 'auto',
          glareSensitivity: DEFAULT_GLARE_SENSITIVITY,
          detect,
          detectState: detectStateOf(detect),
          loadTimings: { ...info.timings, detect: Math.round(performance.now() - t) },
        },
      });
    });

  const editPage = (page: PageRecord) =>
    void run('페이지를 여는 중', async () => {
      const { info, timings } = await loadSource(page.source, page.rotation);
      const shots: Shot[] = [{ source: page.source, info, rotation: page.rotation, quad: denormalizeQuad(page.quad, info.width, info.height) }];
      for (const e of page.extras ?? []) shots.push(await loadExtra(e));
      setView({
        name: 'edit',
        session: {
          docId: page.docId,
          pageId: page.id,
          sourceName: 'page',
          shots,
          mode: page.mode,
          aspect: page.aspect,
          glareSensitivity: page.glareSensitivity ?? DEFAULT_GLARE_SENSITIVITY,
          detect: null,
          detectState: page.detect,
          loadTimings: timings,
        },
      });
    });

  const savePage = async ({ session, shots, mode, aspect, glareSensitivity, detectState, result }: SavedPage) => {
    const [main, ...extras] = shots;
    await store.savePage(
      {
        id: session.pageId,
        docId: session.docId,
        source: main.source,
        rotation: main.rotation,
        quad: normalizeQuad(main.quad, main.info.width, main.info.height),
        mode,
        aspect,
        detect: detectState,
        result: result.blob,
        resultMode: result.mode,
        width: result.width,
        height: result.height,
        thumb: result.thumb,
        extras: extras.map((e) => ({ source: e.source, rotation: e.rotation, quad: normalizeQuad(e.quad, e.info.width, e.info.height) })),
        glareSensitivity,
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
          onCamera={canLive ? () => openCamera(null) : undefined}
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
          onCamera={canLive ? () => openCamera(view.docId) : undefined}
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

      {camera && (
        <LiveCamera continuous={false} saved={camera.saved} onShot={onCameraShot} onNativePhoto={cameraNative} onClose={closeCamera} />
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
