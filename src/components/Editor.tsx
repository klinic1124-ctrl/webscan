import { useEffect, useRef, useState } from 'react';
import type { DetectResult, Mode } from '../lib/cv/pipeline';
import { fullFrameQuad, isConvex, nearestPaper, PAPER, rotateQuadCW, type AspectChoice, type Quad } from '../lib/geometry';
import type { DetectState } from '../lib/store';
import { scanner, type ScanResult, type SourceInfo } from '../scanner';
import { ASPECTS, MODE_NAME, MODES, useObjectUrl, type EngineInfo } from '../ui';
import { CropEditor } from './CropEditor';
import { Metrics } from './Metrics';

/** Everything the editor needs for one page; the photo is already loaded in the worker. */
export interface EditSession {
  docId: string;
  /** Existing page being re-edited. */
  pageId?: string;
  /** Position for a new page (default: end). */
  insertAt?: number;
  source: Blob;
  sourceName: string;
  info: SourceInfo;
  rotation: number;
  quad: Quad;
  mode: Mode;
  aspect: AspectChoice;
  detect: DetectResult | null;
  detectState: DetectState;
  loadTimings: Record<string, number>;
}

export interface SavedPage {
  session: EditSession;
  quad: Quad;
  rotation: number;
  info: SourceInfo;
  mode: Mode;
  aspect: AspectChoice;
  detectState: DetectState;
  result: ScanResult;
}

interface Props {
  session: EditSession;
  engine: EngineInfo | null;
  busy: boolean;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
  onCancel: () => void;
  onSave: (page: SavedPage) => Promise<void>;
}

export function Editor({ session, engine, busy, run, onCancel, onSave }: Props) {
  const [info, setInfo] = useState(session.info);
  const [quad, setQuad] = useState(session.quad);
  const [rotation, setRotation] = useState(session.rotation);
  const [detect, setDetect] = useState(session.detect);
  const [detectState, setDetectState] = useState<DetectState>(session.detectState);
  const [mode, setMode] = useState<Mode>(session.mode);
  const [aspect, setAspect] = useState<AspectChoice>(session.aspect);
  const [result, setResult] = useState<ScanResult | null>(null);
  const previewUrl = useObjectUrl(info.preview);
  const resultUrl = useObjectUrl(result?.blob);
  const resultRef = useRef<HTMLDivElement>(null);
  const isNew = !session.pageId;

  // Any change to the crop invalidates the preview.
  const changeQuad = (q: Quad) => {
    setQuad(q);
    setResult(null);
    setDetectState('manual');
  };

  const scan = (m: Mode, a: AspectChoice, scroll: boolean) =>
    run('스캔하는 중', async () => {
      const r = await scanner().scan(quad, { mode: m, aspect: a });
      setResult(r);
      if (scroll) requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return r;
    });

  const choose = (m: Mode, a: AspectChoice) => {
    setMode(m);
    setAspect(a);
    if (result) void scan(m, a, false);
  };

  const onRotate = () =>
    void run('회전하는 중', async () => {
      const next = await scanner().rotate();
      setQuad(rotateQuadCW(quad, info.width, info.height));
      setInfo(next);
      setRotation((r) => (r + 1) % 4);
      setResult(null);
    });

  const onRedetect = () =>
    void run('경계를 찾는 중', async () => {
      const d = await scanner().detect();
      setDetect(d);
      setQuad(d.quad);
      setDetectState(d.found ? 'found' : d.guess ? 'guess' : 'none');
      setResult(null);
    });

  const onSaveClick = () =>
    void run('페이지 저장 중', async () => {
      const r = result ?? (await scanner().scan(quad, { mode, aspect }));
      await onSave({ session, quad, rotation, info, mode, aspect, detectState, result: r });
    });

  // Keyboard: Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const convex = isConvex(quad);
  const lowRes = Math.max(info.width, info.height) < 2000 && !session.sourceName.startsWith('sample-');
  const paper = result && aspect === 'auto' ? nearestPaper(result.aspect.ratio) : null;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{isNew ? '새 페이지' : '페이지 다시 맞추기'}</h2>
          <button className="btn small ghost" onClick={onCancel} disabled={busy}>
            취소
          </button>
        </div>
        {detect && !detect.found && detect.guess && detectState !== 'manual' && (
          <p className="alert warn">테두리가 뚜렷하지 않아 추정한 영역입니다. 네 모서리가 종이 끝에 맞는지 확인해 주세요.</p>
        )}
        {detect && !detect.found && !detect.guess && detectState !== 'manual' && (
          <p className="alert warn">문서 테두리를 찾지 못했습니다. 네 모서리를 직접 맞춰 주세요. 종이와 색이 다른 바닥 위에서 찍으면 더 잘 찾습니다.</p>
        )}
        {lowRes && (
          <p className="alert warn">
            사진 해상도가 낮습니다({info.width}×{info.height}). 사진 보관함에서 고르면 줄어든 사진이 올 수 있습니다. 카메라로 직접 찍으면 원본 해상도로 스캔됩니다.
          </p>
        )}
        {previewUrl && <CropEditor previewUrl={previewUrl} width={info.width} height={info.height} quad={quad} onChange={changeQuad} />}
        <div className="row tools">
          <button className="btn small" onClick={onRedetect} disabled={busy}>
            자동 검출
          </button>
          <button className="btn small" onClick={() => changeQuad(fullFrameQuad(info.width, info.height))} disabled={busy}>
            전체 선택
          </button>
          <button className="btn small" onClick={onRotate} disabled={busy}>
            90° 회전
          </button>
        </div>
        {!convex && <p className="alert warn">모서리가 꼬여 있습니다. 사각형이 되도록 맞춰 주세요.</p>}

        <div className="opts">
          <div className="opt">
            <span className="label">출력 모드</span>
            <div className="chips" role="radiogroup" aria-label="출력 모드">
              {MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={mode === m.id} className={`chip${mode === m.id ? ' on' : ''}`} onClick={() => choose(m.id, aspect)} disabled={busy}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="opt">
            <span className="label">용지 비율</span>
            <div className="chips" role="radiogroup" aria-label="용지 비율">
              {ASPECTS.map((a) => (
                <button key={a.id} role="radio" aria-checked={aspect === a.id} className={`chip${aspect === a.id ? ' on' : ''}`} onClick={() => choose(mode, a.id)} disabled={busy}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="row split">
          <button className="btn" onClick={() => void scan(mode, aspect, true)} disabled={!convex || busy}>
            미리보기
          </button>
          <button className="btn primary grow" onClick={onSaveClick} disabled={!convex || busy}>
            {isNew ? '페이지 추가' : '변경 저장'}
          </button>
        </div>
      </section>

      {result && resultUrl && (
        <section className="panel" ref={resultRef}>
          <h2>미리보기</h2>
          <div className="tags">
            <span className="tag">
              {MODE_NAME[result.mode]}
              {mode === 'auto' ? ' (자동)' : ''}
            </span>
            <span className="tag mono">
              {result.width}×{result.height}
            </span>
            <span className="tag mono">A4 기준 약 {Math.round(Math.max(result.width, result.height) / 11.69)} dpi</span>
            {paper && <span className="tag mono">≈ {PAPER[paper].label.split(' ')[0]}</span>}
          </div>
          {result.saturatedFrac > 0.015 && (
            <p className="alert warn">
              반사광이나 과노출로 하얗게 날아간 부분이 {(result.saturatedFrac * 100).toFixed(1)}% 있습니다. 그 부분은 복원할 수 없으니 조명 각도를 바꿔 다시 찍어 보세요.
            </p>
          )}
          <div className="result">
            <img src={resultUrl} alt="스캔 미리보기" />
          </div>
          <button className="btn primary wide" onClick={onSaveClick} disabled={busy}>
            {isNew ? '페이지 추가' : '변경 저장'}
          </button>
        </section>
      )}

      <Metrics engine={engine} info={info} detect={detect} loadTimings={session.loadTimings} result={result} quad={quad} mode={mode} aspect={aspect} busy={busy} run={run} />
    </>
  );
}
