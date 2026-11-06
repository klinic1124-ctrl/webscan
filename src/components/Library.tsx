import { useEffect, useState } from 'react';
import type { SampleKind } from '../lib/cv/synthetic';
import type { DocRecord, Store } from '../lib/store';
import { useObjectUrl } from '../ui';

interface Props {
  store: Store;
  busy: boolean;
  engineReady: boolean;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  onOpen: (docId: string) => void;
  onImport: (files: File[], fromCamera: boolean) => void;
  onSample: (kind: SampleKind) => void;
  /** Opens the live camera (when the browser supports it). */
  onCamera?: () => void;
}

const SAMPLES: { id: SampleKind; label: string }[] = [
  { id: 'text', label: '서류' },
  { id: 'music', label: '악보' },
  { id: 'photo', label: '사진' },
];

export function Library({ store, busy, engineReady, run, onOpen, onImport, onSample, onCamera }: Props) {
  const [docs, setDocs] = useState<DocRecord[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = async () => setDocs(await store.listDocs());
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const remove = (id: string) =>
    void run('삭제하는 중', async () => {
      await store.deleteDoc(id);
      setConfirm(null);
      await load();
    });

  const disabled = !engineReady || busy;
  const pick = (fromCamera: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = [...(e.target.files ?? [])];
    e.target.value = '';
    if (f.length) onImport(f, fromCamera);
  };

  return (
    <>
      <section className="panel">
        <h2>새 스캔</h2>
        <div className="row">
          {onCamera ? (
            <button id="live-camera" className="btn primary" onClick={onCamera} disabled={disabled}>
              카메라로 촬영
            </button>
          ) : (
            <label className={`btn primary${disabled ? ' disabled' : ''}`}>
              <input id="camera" type="file" accept="image/*" capture="environment" onChange={pick(true)} disabled={disabled} />
              카메라로 촬영
            </label>
          )}
          <label className={`btn${disabled ? ' disabled' : ''}`}>
            <input id="gallery" type="file" accept="image/*" multiple onChange={pick(false)} disabled={disabled} />
            사진 불러오기
          </label>
        </div>
        <p className="hint">
          {onCamera ? '카메라 화면에서 문서 테두리가 보이면 가만히 들고 있으세요. 자동으로 찍습니다. "연속 촬영"을 켜면 여러 페이지를 차례로 찍어 한 문서로 묶습니다. ' : ''}
          사진을 여러 장 고르면 자동으로 영역을 찾아 한 문서로 묶습니다.
        </p>
        <div className="row samples">
          <span className="hint">시험용 샘플</span>
          {SAMPLES.map((s) => (
            <button key={s.id} className="chip" onClick={() => onSample(s.id)} disabled={disabled}>
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>보관함</h2>
        {docs === null ? null : docs.length === 0 ? (
          <p className="empty">저장된 문서가 없습니다. 위에서 첫 문서를 스캔해 보세요.</p>
        ) : (
          <ul className="docs">
            {docs.map((d) => (
              <DocRow
                key={d.id}
                store={store}
                doc={d}
                busy={busy}
                confirming={confirm === d.id}
                onOpen={() => onOpen(d.id)}
                onAskDelete={() => setConfirm(d.id)}
                onCancelDelete={() => setConfirm(null)}
                onDelete={() => remove(d.id)}
              />
            ))}
          </ul>
        )}
        <p className="hint">스캔은 이 기기의 브라우저 안에만 저장됩니다. 브라우저 데이터를 지우거나 오래 쓰지 않으면 지워질 수 있으니, 중요한 문서는 PDF로 내보내 보관하세요.</p>
      </section>
    </>
  );
}

interface RowProps {
  store: Store;
  doc: DocRecord;
  busy: boolean;
  confirming: boolean;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function DocRow({ store, doc, busy, confirming, onOpen, onAskDelete, onCancelDelete, onDelete }: RowProps) {
  const [thumb, setThumb] = useState<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    const first = doc.pageIds[0];
    if (first) void store.getPage(first).then((p) => alive && setThumb(p?.thumb ?? null));
    return () => {
      alive = false;
    };
  }, [store, doc]);
  const url = useObjectUrl(thumb);
  const date = new Date(doc.updatedAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <li className="doc-row">
      <button className="doc-open" onClick={onOpen} disabled={busy}>
        <span className="doc-thumb">{url && <img src={url} alt="" />}</span>
        <span className="doc-text">
          <strong>{doc.name}</strong>
          <span className="hint">
            {doc.pageIds.length}쪽 · {date}
          </span>
        </span>
      </button>
      {confirming ? (
        <span className="card-actions">
          <button className="mini danger" onClick={onDelete} disabled={busy}>
            삭제
          </button>
          <button className="mini" onClick={onCancelDelete}>
            취소
          </button>
        </span>
      ) : (
        <button className="mini" onClick={onAskDelete} disabled={busy} aria-label={`${doc.name} 삭제`}>
          ✕
        </button>
      )}
    </li>
  );
}
