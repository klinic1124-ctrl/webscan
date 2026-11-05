import { useCallback, useEffect, useState } from 'react';
import { buildPdf, type PdfPageSize } from '../lib/pdf';
import type { DocRecord, PageRecord, Store } from '../lib/store';
import { canShareFiles, downloadBlob, isEmbedded, extFor, fmtBytes, MODE_NAME, safeFileName, shareFiles, useObjectUrl } from '../ui';

interface Props {
  store: Store;
  docId: string;
  /** Changes when pages were added from outside this view. */
  revision: number;
  busy: boolean;
  engineReady: boolean;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  onBack: () => void;
  onImport: (files: File[], fromCamera: boolean) => void;
  onEditPage: (page: PageRecord) => void;
  onError: (msg: string) => void;
}

const SIZES: { id: PdfPageSize; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'a4', label: 'A4' },
  { id: 'letter', label: 'Letter' },
];

export function DocumentView({ store, docId, revision, busy, engineReady, run, onBack, onImport, onEditPage, onError }: Props) {
  const [doc, setDoc] = useState<DocRecord | null>(null);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [name, setName] = useState('');
  const [pageSize, setPageSize] = useState<PdfPageSize>('auto');
  const [pdf, setPdf] = useState<File | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await store.getDoc(docId);
    setDoc(d ?? null);
    setName(d?.name ?? '');
    setPages(await store.getPages(docId));
    setPdf(null);
  }, [store, docId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const rename = async () => {
    if (doc && name.trim() && name !== doc.name) {
      const d = await store.renameDoc(doc.id, name);
      if (d) setDoc(d);
      setPdf(null);
    } else if (doc) setName(doc.name);
  };

  const move = (from: number, to: number) =>
    void run('순서 바꾸는 중', async () => {
      await store.movePage(docId, from, to);
      await load();
    });

  const remove = (id: string) =>
    void run('삭제하는 중', async () => {
      await store.deletePage(docId, id);
      setConfirmDelete(null);
      await load();
    });

  const makePdf = () =>
    void run('PDF 만드는 중', async () => {
      const inputs = await Promise.all(
        pages.map(async (p) => ({
          bytes: new Uint8Array(await p.result.arrayBuffer()),
          type: p.result.type,
          width: p.width,
          height: p.height,
        })),
      );
      const bytes = await buildPdf(inputs, { pageSize, title: doc?.name });
      setPdf(new File([bytes as BlobPart], `${safeFileName(doc?.name ?? 'scan')}.pdf`, { type: 'application/pdf' }));
    });

  const imageFiles = () =>
    pages.map((p, i) => new File([p.result], `${safeFileName(doc?.name ?? 'scan')}-${String(i + 1).padStart(2, '0')}.${extFor(p.result.type)}`, { type: p.result.type }));

  const share = async (files: File[]) => {
    try {
      await shareFiles(files, doc?.name ?? '스캔');
    } catch {
      onError('공유하지 못했습니다. 저장 버튼을 사용해 주세요.');
    }
  };

  const saveImages = () => {
    for (const f of imageFiles()) downloadBlob(f, f.name);
  };

  if (!doc) {
    return (
      <section className="panel">
        <p>문서를 찾을 수 없습니다.</p>
        <button className="btn" onClick={onBack}>
          보관함으로
        </button>
      </section>
    );
  }

  const images = pages.length ? imageFiles() : [];
  const canShareImages = images.length > 0 && canShareFiles(images);
  const canSharePdf = !!pdf && canShareFiles([pdf]);
  const needsCheck = pages.filter((p) => p.detect === 'guess' || p.detect === 'none').length;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <button className="btn small ghost" onClick={onBack} disabled={busy}>
            ← 보관함
          </button>
          <span className="hint">{pages.length}쪽</span>
        </div>
        <label className="label" htmlFor="doc-name">
          문서 이름
        </label>
        <input
          id="doc-name"
          className="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {needsCheck > 0 && <p className="alert warn">테두리를 확실히 찾지 못한 페이지가 {needsCheck}쪽 있습니다. "확인 필요" 표시된 페이지를 눌러 영역을 확인해 주세요.</p>}

        {pages.length > 0 ? (
          <ol className="pages">
            {pages.map((p, i) => (
              <PageCard
                key={p.id}
                page={p}
                index={i}
                count={pages.length}
                busy={busy}
                confirming={confirmDelete === p.id}
                onEdit={() => onEditPage(p)}
                onMove={(to) => move(i, to)}
                onAskDelete={() => setConfirmDelete(p.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => remove(p.id)}
              />
            ))}
          </ol>
        ) : (
          <p className="empty">아직 페이지가 없습니다. 아래에서 촬영하거나 사진을 불러오세요.</p>
        )}

        <div className="row">
          <label className={`btn primary${!engineReady || busy ? ' disabled' : ''}`}>
            <input
              id="doc-camera"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={!engineReady || busy}
              onChange={(e) => {
                const f = [...(e.target.files ?? [])];
                e.target.value = '';
                if (f.length) onImport(f, true);
              }}
            />
            페이지 촬영
          </label>
          <label className={`btn${!engineReady || busy ? ' disabled' : ''}`}>
            <input
              id="doc-gallery"
              type="file"
              accept="image/*"
              multiple
              disabled={!engineReady || busy}
              onChange={(e) => {
                const f = [...(e.target.files ?? [])];
                e.target.value = '';
                if (f.length) onImport(f, false);
              }}
            />
            사진 불러오기
          </label>
        </div>
      </section>

      {pages.length > 0 && (
        <section className="panel">
          <h2>내보내기</h2>
          {isEmbedded() && (
            <p className="alert warn">
              지금은 다른 페이지 안에 열린 미리보기라서 파일 저장과 공유가 막힐 수 있습니다. 앱 주소로 직접 열면 정상적으로 저장됩니다.
            </p>
          )}
          <div className="opt">
            <span className="label">PDF 용지</span>
            <div className="chips" role="radiogroup" aria-label="PDF 용지">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={pageSize === s.id}
                  className={`chip${pageSize === s.id ? ' on' : ''}`}
                  onClick={() => {
                    setPageSize(s.id);
                    setPdf(null);
                  }}
                  disabled={busy}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="hint">자동: 페이지 비율이 A4나 Letter와 같으면 그 크기로, 아니면 사진 비율 그대로 만듭니다.</span>
          </div>
          {!pdf ? (
            <button className="btn primary wide" onClick={makePdf} disabled={busy}>
              PDF 만들기 ({pages.length}쪽)
            </button>
          ) : (
            <div className="export-ready">
              <p>
                <strong>{pdf.name}</strong> <span className="mono hint">{fmtBytes(pdf.size)}</span>
              </p>
              <div className="row">
                {canSharePdf && (
                  <button className="btn primary" onClick={() => void share([pdf])}>
                    PDF 공유·파일에 저장
                  </button>
                )}
                <button className={`btn${canSharePdf ? '' : ' primary'}`} onClick={() => downloadBlob(pdf, pdf.name)}>
                  PDF 내려받기
                </button>
              </div>
            </div>
          )}
          <div className="row">
            {canShareImages && (
              <button className="btn small" onClick={() => void share(images)} disabled={busy}>
                이미지 공유 ({images.length}장)
              </button>
            )}
            <button className="btn small" onClick={saveImages} disabled={busy}>
              이미지 내려받기
            </button>
          </div>
        </section>
      )}
    </>
  );
}

interface CardProps {
  page: PageRecord;
  index: number;
  count: number;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onMove: (to: number) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function PageCard({ page, index, count, busy, confirming, onEdit, onMove, onAskDelete, onCancelDelete, onDelete }: CardProps) {
  const thumb = useObjectUrl(page.thumb);
  const [broken, setBroken] = useState(false);
  const check = page.detect === 'guess' || page.detect === 'none';
  return (
    <li className="page-card">
      <button className="thumb" onClick={onEdit} disabled={busy} aria-label={`${index + 1}쪽 편집`}>
        {thumb && !broken && <img src={thumb} alt="" onError={() => setBroken(true)} />}
        {broken && <span className="thumb-missing">미리보기를 불러오지 못했습니다</span>}
        <span className="num mono">{index + 1}</span>
        {check && <span className="flag">확인 필요</span>}
      </button>
      <span className="meta">
        {MODE_NAME[page.resultMode]}
        {page.extras?.length ? ` · ${page.extras.length + 1}장 합성` : ''}
      </span>
      {confirming ? (
        <div className="card-actions">
          <button className="mini danger" onClick={onDelete} disabled={busy}>
            삭제
          </button>
          <button className="mini" onClick={onCancelDelete}>
            취소
          </button>
        </div>
      ) : (
        <div className="card-actions">
          <button className="mini" onClick={() => onMove(index - 1)} disabled={busy || index === 0} aria-label={`${index + 1}쪽을 앞으로`}>
            ◀
          </button>
          <button className="mini" onClick={() => onMove(index + 1)} disabled={busy || index === count - 1} aria-label={`${index + 1}쪽을 뒤로`}>
            ▶
          </button>
          <button className="mini" onClick={onAskDelete} disabled={busy} aria-label={`${index + 1}쪽 삭제`}>
            ✕
          </button>
        </div>
      )}
    </li>
  );
}
