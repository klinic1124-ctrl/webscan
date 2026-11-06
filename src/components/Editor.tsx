import { transfer } from 'comlink';
import { useEffect, useRef, useState } from 'react';
import type { DetectResult, Mode } from '../lib/cv/pipeline';
import { fullFrameQuad, isConvex, nearestPaper, PAPER, rotateQuadCW, type AspectChoice, type Quad } from '../lib/geometry';
import type { DetectState } from '../lib/store';
import { decodeFile, scanner, type ScanResult, type SourceInfo } from '../scanner';
import { ASPECTS, DEFAULT_GLARE_SENSITIVITY, MODE_NAME, MODES, useObjectUrl, type EngineInfo } from '../ui';
import { CropEditor } from './CropEditor';
import { Metrics } from './Metrics';

/** One photo of the page: shots[0] is the main photo, the rest fill in reflections. */
export interface Shot {
  source: Blob;
  info: SourceInfo;
  rotation: number;
  quad: Quad;
}

/** Everything the editor needs for one page; the photos are already loaded in the worker. */
export interface EditSession {
  docId: string;
  /** Existing page being re-edited. */
  pageId?: string;
  /** Position for a new page (default: end). */
  insertAt?: number;
  sourceName: string;
  shots: Shot[];
  mode: Mode;
  aspect: AspectChoice;
  /** Reflection detection sensitivity 0..100 (50 = default). */
  glareSensitivity: number;
  detect: DetectResult | null;
  detectState: DetectState;
  loadTimings: Record<string, number>;
}

export interface SavedPage {
  session: EditSession;
  shots: Shot[];
  mode: Mode;
  aspect: AspectChoice;
  glareSensitivity: number;
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

const MAX_SHOTS = 3;

export function Editor({ session, engine, busy, run, onCancel, onSave }: Props) {
  const [shots, setShots] = useState<Shot[]>(session.shots);
  const [sel, setSel] = useState(0);
  const [detect, setDetect] = useState(session.detect);
  const [detectState, setDetectState] = useState<DetectState>(session.detectState);
  const [mode, setMode] = useState<Mode>(session.mode);
  const [aspect, setAspect] = useState<AspectChoice>(session.aspect);
  const [sens, setSens] = useState(session.glareSensitivity);
  const [showOverlay, setShowOverlay] = useState(true);
  const [result, setResult] = useState<ScanResult | null>(null);
  const sensTimer = useRef<number | undefined>(undefined);
  const current = shots[Math.min(sel, shots.length - 1)];
  const previewUrl = useObjectUrl(current.info.preview);
  const resultUrl = useObjectUrl(result?.blob);
  const overlayUrl = useObjectUrl(result?.overlay);
  const resultRef = useRef<HTMLDivElement>(null);
  const isNew = !session.pageId;
  const isSample = session.sourceName.startsWith('sample-');

  const updateShot = (i: number, patch: Partial<Shot>) => setShots((list) => list.map((s, k) => (k === i ? { ...s, ...patch } : s)));

  // Any change to a crop invalidates the preview.
  const changeQuad = (q: Quad) => {
    updateShot(sel, { quad: q });
    setResult(null);
    if (sel === 0) setDetectState('manual');
  };

  const scanNow = (list: Shot[], m: Mode, a: AspectChoice, g: number, quick: boolean) =>
    scanner().scan(
      list[0].quad,
      { mode: m, aspect: a, glareSensitivity: g },
      list.slice(1).map((s) => s.quad),
      'image/jpeg',
      quick,
    );

  const preview = (m: Mode, a: AspectChoice, scroll: boolean, g = sens) =>
    run(shots.length > 1 ? '사진을 합성하는 중' : '스캔하는 중', async () => {
      const r = await scanNow(shots, m, a, g, true);
      setResult(r);
      if (scroll) requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return r;
    });

  const choose = (m: Mode, a: AspectChoice) => {
    setMode(m);
    setAspect(a);
    if (result) void preview(m, a, false);
  };

  const onRotate = () =>
    void run('회전하는 중', async () => {
      const i = sel;
      const next = await scanner().rotate(i);
      updateShot(i, { info: next, rotation: (shots[i].rotation + 1) % 4, quad: rotateQuadCW(shots[i].quad, shots[i].info.width, shots[i].info.height) });
      setResult(null);
    });

  const onRedetect = () =>
    void run('경계를 찾는 중', async () => {
      const d = await scanner().detect(sel);
      updateShot(sel, { quad: d.quad });
      if (sel === 0) {
        setDetect(d);
        setDetectState(d.found ? 'found' : d.guess ? 'guess' : 'none');
      }
      setResult(null);
    });

  const addShot = (file: File | null, sampleKind?: string) =>
    void run('사진을 더하는 중', async () => {
      let info: SourceInfo & { index: number };
      let source: Blob;
      if (file) {
        const bmp = await decodeFile(file);
        info = await scanner().addShot(transfer(bmp, [bmp]));
        source = file;
      } else {
        info = await scanner().loadSample(sampleKind as 'text', shots.length);
        source = await scanner().exportSource(info.index);
      }
      const d = await scanner().detect(info.index);
      const next = [...shots, { source, info, rotation: 0, quad: d.quad }];
      setShots(next);
      setSel(next.length - 1);
      setResult(null);
    });

  const removeShot = (i: number) =>
    void run('사진을 빼는 중', async () => {
      await scanner().removeShot(i);
      setShots((list) => list.filter((_, k) => k !== i));
      setSel(0);
      setResult(null);
    });

  // Sensitivity slider: re-preview shortly after the user stops moving it.
  const changeSens = (v: number) => {
    setSens(v);
    window.clearTimeout(sensTimer.current);
    sensTimer.current = window.setTimeout(() => void preview(mode, aspect, false, v), 450);
  };
  useEffect(() => () => window.clearTimeout(sensTimer.current), []);

  const onSaveClick = () =>
    void run(shots.length > 1 ? '합성해서 저장하는 중' : '페이지 저장 중', async () => {
      // Quick previews are reduced in size: save from a full-resolution scan.
      const r = result && !result.preview ? result : await scanNow(shots, mode, aspect, sens, false);
      await onSave({ session, shots, mode, aspect, glareSensitivity: sens, detectState, result: r });
    });

  // Keyboard: Escape cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const convex = shots.every((s) => isConvex(s.quad));
  const info = current.info;
  const lowRes = sel === 0 && Math.max(info.width, info.height) < 2000 && !isSample;
  const paper = result && aspect === 'auto' ? nearestPaper(result.aspect.ratio) : null;
  const canAdd = shots.length < MAX_SHOTS;
  const glare = !!result && result.saturatedFrac > 0.015;

  const addButtons = (primary: boolean) => (
    <div className="row">
      <label className={`btn small${primary ? ' primary' : ''}${busy ? ' disabled' : ''}`}>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) addShot(f);
          }}
        />
        다른 각도로 한 장 더 찍기
      </label>
      <label className={`btn small${busy ? ' disabled' : ''}`}>
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) addShot(f);
          }}
        />
        사진에서 고르기
      </label>
      {isSample && (
        <button className="btn small" onClick={() => addShot(null, session.sourceName.slice('sample-'.length))} disabled={busy}>
          샘플로 한 장 더
        </button>
      )}
    </div>
  );

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{isNew ? '새 페이지' : '페이지 다시 맞추기'}</h2>
          <button className="btn small ghost" onClick={onCancel} disabled={busy}>
            취소
          </button>
        </div>
        {sel === 0 && detect && !detect.found && detect.guess && detectState !== 'manual' && (
          <p className="alert warn">테두리가 뚜렷하지 않아 추정한 영역입니다. 네 모서리가 종이 끝에 맞는지 확인해 주세요.</p>
        )}
        {sel === 0 && detect && !detect.found && !detect.guess && detectState !== 'manual' && (
          <p className="alert warn">문서 테두리를 찾지 못했습니다. 네 모서리를 직접 맞춰 주세요. 종이와 색이 다른 바닥 위에서 찍으면 더 잘 찾습니다.</p>
        )}
        {lowRes && (
          <p className="alert warn">
            사진 해상도가 낮습니다({info.width}×{info.height}). 사진 보관함에서 고르면 줄어든 사진이 올 수 있습니다. 카메라로 직접 찍으면 원본 해상도로 스캔됩니다.
          </p>
        )}

        {shots.length > 1 && (
          <div className="shots" role="tablist" aria-label="이 페이지의 사진">
            {shots.map((s, i) => (
              <ShotTab key={i} shot={s} index={i} selected={i === sel} busy={busy} onSelect={() => setSel(i)} onRemove={i > 0 ? () => removeShot(i) : undefined} />
            ))}
          </div>
        )}
        {shots.length > 1 && <p className="hint">사진마다 네 모서리를 맞춰 주세요. 기본 사진을 쓰고, 반사된 부분만 다른 사진에서 가져옵니다.</p>}

        {previewUrl && <CropEditor previewUrl={previewUrl} width={info.width} height={info.height} quad={current.quad} onChange={changeQuad} />}
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
        {!convex && <p className="alert warn">모서리가 꼬인 사진이 있습니다. 사각형이 되도록 맞춰 주세요.</p>}

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
          <details className="opt glare-box" open={shots.length > 1 || undefined}>
            <summary className="label">반사광 지우기{shots.length > 1 ? ` · 사진 ${shots.length}장` : ''}</summary>
            <p className="hint">광택 사진이나 코팅된 종이에 반사광이 있으면, 조명이나 휴대폰 각도를 바꿔 같은 페이지를 한두 장 더 찍으세요. 반사된 부분만 다른 사진으로 채웁니다.</p>
            {shots.length > 1 && (
              <div className="sens">
                <label htmlFor="glare-sens" className="sens-head">
                  <span>반사 판정 민감도</span>
                  <span className="mono">{sens === DEFAULT_GLARE_SENSITIVITY ? '기본' : sens}</span>
                </label>
                <input
                  id="glare-sens"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={sens}
                  onChange={(e) => changeSens(Number(e.target.value))}
                  aria-describedby="glare-sens-hint"
                />
                <div className="sens-scale" aria-hidden="true">
                  <span>뚜렷한 반사만</span>
                  <span>은은한 번들거림까지</span>
                </div>
                <p id="glare-sens-hint" className="hint">
                  반사가 덜 지워졌으면 오른쪽으로, 반사가 아닌 부분까지 바뀌면 왼쪽으로 옮기세요. 결과의 주황색이 다른 사진에서 가져온 부분입니다.
                  {sens !== DEFAULT_GLARE_SENSITIVITY && (
                    <>
                      {' '}
                      <button className="link" onClick={() => changeSens(DEFAULT_GLARE_SENSITIVITY)} disabled={busy}>
                        기본값으로
                      </button>
                    </>
                  )}
                </p>
              </div>
            )}
            {canAdd ? addButtons(false) : <p className="hint">사진은 페이지당 {MAX_SHOTS}장까지 쓸 수 있습니다.</p>}
          </details>
        </div>
        <div className="row split">
          <button className="btn" onClick={() => void preview(mode, aspect, true)} disabled={!convex || busy}>
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
            {result.fusion && (
              <span className="tag">
                사진 {result.fusion.shots}장 합성 · {(result.fusion.replacedFrac * 100).toFixed(1)}% 보정
              </span>
            )}
          </div>
          {result.fusion && result.fusion.aligned.some((a) => !a) && (
            <p className="hint">일부 사진은 세밀한 정렬에 실패해 모서리 기준으로만 맞췄습니다. 반사 부분 경계가 어긋나 보이면 그 사진의 모서리를 더 정확히 맞춰 주세요.</p>
          )}
          {glare && (
            <div className="alert warn">
              <p>
                반사광이나 과노출로 하얗게 날아간 부분이 {(result.saturatedFrac * 100).toFixed(1)}% 있습니다.
                {canAdd ? ' 각도를 바꿔 한 장 더 찍으면 그 부분을 채울 수 있습니다.' : ''}
              </p>
              {canAdd && addButtons(true)}
            </div>
          )}
          {result.fusion && overlayUrl && (
            <label className="check">
              <input id="show-overlay" type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} />
              다른 사진에서 가져온 부분 표시 (주황색)
            </label>
          )}
          <div className="result">
            <div className="result-stack">
              <img src={resultUrl} alt="스캔 미리보기" />
              {result.fusion && overlayUrl && showOverlay && <img className="overlay" src={overlayUrl} alt="" />}
            </div>
          </div>
          {result.preview && <p className="hint">빠른 미리보기입니다. 저장할 때 원래 해상도로 다시 처리합니다.</p>}
          <button className="btn primary wide" onClick={onSaveClick} disabled={busy}>
            {isNew ? '페이지 추가' : '변경 저장'}
          </button>
        </section>
      )}

      <Metrics engine={engine} info={shots[0].info} detect={detect} loadTimings={session.loadTimings} result={result} quad={shots[0].quad} extraQuads={shots.slice(1).map((s) => s.quad)} mode={mode} aspect={aspect} busy={busy} run={run} />
    </>
  );
}

function ShotTab({ shot, index, selected, busy, onSelect, onRemove }: { shot: Shot; index: number; selected: boolean; busy: boolean; onSelect: () => void; onRemove?: () => void }) {
  const url = useObjectUrl(shot.info.preview);
  return (
    <div className={`shot${selected ? ' on' : ''}`}>
      <button role="tab" aria-selected={selected} className="shot-btn" onClick={onSelect} disabled={busy}>
        {url && <img src={url} alt="" />}
        <span>{index === 0 ? '기본' : `추가 ${index}`}</span>
      </button>
      {onRemove && (
        <button className="mini" onClick={onRemove} disabled={busy} aria-label={`추가 사진 ${index} 빼기`}>
          ✕
        </button>
      )}
    </div>
  );
}
