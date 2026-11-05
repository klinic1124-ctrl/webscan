import { transfer } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CropEditor } from './components/CropEditor';
import type { DetectResult, Mode } from './lib/cv/pipeline';
import type { SampleKind } from './lib/cv/synthetic';
import {
  fullFrameQuad,
  isConvex,
  nearestPaper,
  PAPER,
  rotateQuadCW,
  type AspectChoice,
  type Quad,
} from './lib/geometry';
import { decodeFile, deviceSummary, scanner, type ScanResult, type SourceInfo } from './scanner';

const MODES: { id: Mode; label: string }[] = [
  { id: 'auto', label: '자동' },
  { id: 'color', label: '컬러 문서' },
  { id: 'gray', label: '회색조' },
  { id: 'bw', label: '흑백' },
  { id: 'photo', label: '사진·그림' },
];

const MODE_NAME: Record<Exclude<Mode, 'auto'>, string> = {
  color: '컬러 문서',
  gray: '회색조',
  bw: '흑백',
  photo: '사진·그림',
};

const ASPECTS: { id: AspectChoice; label: string }[] = [
  { id: 'auto', label: '자동 추정' },
  { id: 'a4', label: 'A4' },
  { id: 'b5', label: 'B5' },
  { id: 'letter', label: 'Letter' },
  { id: 'edges', label: '변 길이' },
];

const SAMPLES: { id: SampleKind; label: string }[] = [
  { id: 'text', label: '서류' },
  { id: 'music', label: '악보' },
  { id: 'photo', label: '사진' },
];

const TIMING_LABEL: Record<string, string> = {
  decode: '사진 해독',
  toMat: 'OpenCV 변환',
  generate: '샘플 생성',
  downscale: '축소',
  preview: '미리보기',
  rotate: '회전',
  detect: '경계 검출',
  warp: '원근 보정',
  analyze: '분석',
  flatten: '조명 균일화',
  finish: '모드 마무리',
  toRGBA: '색 변환',
  encode: '파일 인코딩',
  total: '스캔 합계',
};

interface EngineInfo {
  ms: number;
  version: string;
  simd: boolean;
  threads: boolean;
}

interface Source extends SourceInfo {
  url: string;
  name: string;
}

interface Bench {
  runs: number;
  avg: Record<string, number>;
  heapMB: number;
}

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [mode, setMode] = useState<Mode>('auto');
  const [aspect, setAspect] = useState<AspectChoice>('auto');
  const [result, setResult] = useState<(ScanResult & { url: string }) | null>(null);
  const [loadTimings, setLoadTimings] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bench, setBench] = useState<Bench | null>(null);
  const [copied, setCopied] = useState(false);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    scanner()
      .init()
      .then(setEngine)
      .catch((e) => setEngineError(String(e?.message ?? e)));
  }, []);

  // Revoke object URLs when replaced.
  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

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

  const adopt = async (info: SourceInfo, name: string, extra: Record<string, number> = {}) => {
    setResult(null);
    setBench(null);
    setSource({ ...info, url: URL.createObjectURL(info.preview), name });
    const t = performance.now();
    const d = await scanner().detect();
    setLoadTimings({ ...extra, ...info.timings, detect: Math.round(performance.now() - t) });
    setDetect(d);
    setQuad(d.quad);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void run('사진을 읽는 중', async () => {
      const t = performance.now();
      const bmp = await decodeFile(file);
      const decode = Math.round(performance.now() - t);
      // Transfer (not copy) the decoded bitmap to the worker.
      const info = await scanner().loadBitmap(transfer(bmp, [bmp]));
      await adopt(info, file.name.replace(/\.[^.]+$/, ''), { decode });
    });
  };

  const onSample = (kind: SampleKind) =>
    void run('샘플을 만드는 중', async () => {
      const info = await scanner().loadSample(kind);
      await adopt(info, `sample-${kind}`);
    });

  const onRotate = () =>
    void run('회전하는 중', async () => {
      if (!source || !quad) return;
      const info = await scanner().rotate();
      const q = rotateQuadCW(quad, source.width, source.height);
      setResult(null);
      setSource({ ...info, url: URL.createObjectURL(info.preview), name: source.name });
      setQuad(q);
    });

  const onRedetect = () =>
    void run('경계를 찾는 중', async () => {
      const d = await scanner().detect();
      setDetect(d);
      setQuad(d.quad);
    });

  const doScan = useCallback(
    (m: Mode, a: AspectChoice, q: Quad) =>
      run('스캔하는 중', async () => {
        const r = await scanner().scan(q, { mode: m, aspect: a });
        setResult({ ...r, url: URL.createObjectURL(r.blob) });
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }),
    [run],
  );

  // Re-run the scan when the mode or page size changes after a first scan.
  const rescan = (m: Mode, a: AspectChoice) => {
    setMode(m);
    setAspect(a);
    if (result && quad) void doScan(m, a, quad);
  };

  const onBench = () =>
    void run('벤치마크 실행 중 (3회)', async () => {
      if (!quad) return;
      const runs = 3;
      const sums: Record<string, number> = {};
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await scanner().detect();
        sums.detect = (sums.detect ?? 0) + performance.now() - t;
        const r = await scanner().scan(quad, { mode, aspect });
        for (const [k, v] of Object.entries(r.timings)) sums[k] = (sums[k] ?? 0) + v;
      }
      const avg = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(v / runs)]));
      const heap = await scanner().heapBytes();
      setBench({ runs, avg, heapMB: Math.round(heap / 1048576) });
    });

  const report = () =>
    JSON.stringify(
      {
        device: deviceSummary(),
        build: __BUILD_ID__,
        engine,
        source: source && { width: source.width, height: source.height },
        detect: detect && {
          found: detect.found,
          guess: detect.guess,
          method: detect.method,
          edgeSupport: +detect.edgeSupport.toFixed(2),
          contrast: detect.contrast,
          candidates: detect.candidates,
          ms: Math.round(detect.ms),
        },
        load: loadTimings,
        scan: result && {
          mode: result.mode,
          size: `${result.width}x${result.height}`,
          aspect: { ratio: +result.aspect.ratio.toFixed(4), method: result.aspect.method },
          classify: result.classify,
          saturatedPct: +(result.saturatedFrac * 100).toFixed(2),
          timings: result.timings,
          bytes: result.blob.size,
        },
        bench,
      },
      null,
      2,
    );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(report());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('복사하지 못했습니다. 아래 측정 결과를 길게 눌러 직접 복사해 주세요.');
    }
  };

  const fileName = () => {
    if (!result || !source) return 'scan.jpg';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    return `${source.name}-scan-${stamp}.${result.blob.type === 'image/png' ? 'png' : 'jpg'}`;
  };

  const onShare = async () => {
    if (!result) return;
    const file = new File([result.blob], fileName(), { type: result.blob.type });
    try {
      await navigator.share({ files: [file], title: file.name });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('공유하지 못했습니다. 저장 버튼을 사용해 주세요.');
    }
  };
  const canShare =
    typeof navigator !== 'undefined' &&
    !!navigator.canShare &&
    !!result &&
    navigator.canShare({ files: [new File([result.blob], 'x.jpg', { type: result.blob.type })] });

  const convex = quad ? isConvex(quad) : true;
  const estimatedPaper = result?.aspect && aspect === 'auto' ? nearestPaper(result.aspect.ratio) : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>문서 스캐너</h1>
            <p className="sub">0단계 검증 빌드 <span className="mono">{__BUILD_ID__}</span> · 사진은 이 기기 밖으로 나가지 않습니다</p>
          </div>
        </div>
        <span className={`engine ${engine ? 'ok' : engineError ? 'bad' : ''}`}>
          {engine ? `엔진 준비 ${fmt(engine.ms)}` : engineError ? '엔진 오류' : '엔진 불러오는 중…'}
        </span>
      </header>

      {engineError && <p className="alert bad">OpenCV 엔진을 불러오지 못했습니다: {engineError}</p>}

      <section className="panel">
        <h2>
          <span className="step">1</span>사진 가져오기
        </h2>
        <div className="row">
          <label className="btn primary">
            <input id="camera" type="file" accept="image/*" capture="environment" onChange={onFile} disabled={!engine || !!busy} />
            카메라로 촬영
          </label>
          <label className="btn">
            <input id="gallery" type="file" accept="image/*" onChange={onFile} disabled={!engine || !!busy} />
            사진 선택
          </label>
        </div>
        <div className="row samples">
          <span className="hint">시험용 샘플</span>
          {SAMPLES.map((s) => (
            <button key={s.id} className="chip" onClick={() => onSample(s.id)} disabled={!engine || !!busy}>
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {source && quad && (
        <section className="panel">
          <h2>
            <span className="step">2</span>문서 영역 맞추기
          </h2>
          {detect && !detect.found && detect.guess && (
            <p className="alert warn">테두리가 뚜렷하지 않아 추정한 영역입니다. 네 모서리가 종이 끝에 맞는지 확인해 주세요. 종이와 색이 다른 바닥 위에서 찍으면 더 정확합니다.</p>
          )}
          {detect && !detect.found && !detect.guess && (
            <p className="alert warn">문서 테두리를 찾지 못했습니다. 네 모서리를 직접 맞춰 주세요. 종이와 색이 다른 바닥 위에서 찍으면 더 잘 찾습니다.</p>
          )}
          {Math.max(source.width, source.height) < 2000 && !source.name.startsWith('sample-') && (
            <p className="alert warn">
              사진 해상도가 낮습니다({source.width}×{source.height}). 일부 앱 안의 브라우저는 사진을 줄여서 넘겨 줍니다. Safari나 Chrome에서 직접 열면 원본 해상도로 스캔할 수 있습니다.
            </p>
          )}
          <CropEditor previewUrl={source.url} width={source.width} height={source.height} quad={quad} onChange={setQuad} />
          <div className="row tools">
            <button className="btn small" onClick={onRedetect} disabled={!!busy}>자동 검출</button>
            <button className="btn small" onClick={() => setQuad(fullFrameQuad(source.width, source.height))} disabled={!!busy}>전체 선택</button>
            <button className="btn small" onClick={onRotate} disabled={!!busy}>90° 회전</button>
          </div>
          {!convex && <p className="alert warn">모서리가 꼬여 있습니다. 사각형이 되도록 맞춰 주세요.</p>}

          <div className="opts">
            <div className="opt">
              <span className="label">용지 비율</span>
              <div className="chips" role="radiogroup" aria-label="용지 비율">
                {ASPECTS.map((a) => (
                  <button key={a.id} role="radio" aria-checked={aspect === a.id} className={`chip${aspect === a.id ? ' on' : ''}`} onClick={() => rescan(mode, a.id)} disabled={!!busy}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="opt">
              <span className="label">출력 모드</span>
              <div className="chips" role="radiogroup" aria-label="출력 모드">
                {MODES.map((m) => (
                  <button key={m.id} role="radio" aria-checked={mode === m.id} className={`chip${mode === m.id ? ' on' : ''}`} onClick={() => rescan(m.id, aspect)} disabled={!!busy}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <button className="btn primary wide" onClick={() => void doScan(mode, aspect, quad)} disabled={!convex || !!busy}>
            스캔하기
          </button>
        </section>
      )}

      {result && (
        <section className="panel" ref={resultRef}>
          <h2>
            <span className="step">3</span>스캔 결과
          </h2>
          <div className="tags">
            <span className="tag">{MODE_NAME[result.mode]}{mode === 'auto' ? ' (자동 판별)' : ''}</span>
            <span className="tag mono">{result.width}×{result.height}px</span>
            <span className="tag mono">비율 {result.aspect.ratio.toFixed(3)}{estimatedPaper ? ` ≈ ${PAPER[estimatedPaper].label.split(' ')[0]}` : ''}</span>
            <span className="tag mono">A4 기준 약 {Math.round(Math.max(result.width, result.height) / 11.69)} dpi</span>
            <span className="tag mono">{(result.blob.size / 1024).toFixed(0)} KB</span>
          </div>
          {result.saturatedFrac > 0.015 && (
            <p className="alert warn">
              반사광이나 과노출로 하얗게 날아간 부분이 {(result.saturatedFrac * 100).toFixed(1)}% 있습니다. 그 부분은 복원할 수 없으니 조명 각도를 바꿔 다시 찍어 보세요.
            </p>
          )}
          <div className="result">
            <img src={result.url} alt="스캔 결과" />
          </div>
          <div className="row">
            <a className="btn primary" href={result.url} download={fileName()}>
              저장
            </a>
            {canShare && (
              <button className="btn" onClick={onShare}>
                공유·파일에 저장
              </button>
            )}
          </div>
        </section>
      )}

      {(source || engine) && (
        <section className="panel metrics">
          <h2>
            <span className="step">⏱</span>측정
          </h2>
          <p className="hint">0단계 목표: 중급 휴대폰에서 1장 스캔 2초 이내. 측정 결과를 복사해 개발자에게 보내 주세요.</p>
          <table>
            <tbody>
              {engine && (
                <tr>
                  <th>OpenCV {engine.version}</th>
                  <td>
                    로딩 {fmt(engine.ms)} · SIMD {engine.simd ? '사용' : '없음'} · 스레드 {engine.threads ? '사용' : '없음'}
                  </td>
                </tr>
              )}
              {source && (
                <tr>
                  <th>원본</th>
                  <td>
                    {source.width}×{source.height}px ({((source.width * source.height) / 1e6).toFixed(1)} MP)
                  </td>
                </tr>
              )}
              {detect && (
                <tr>
                  <th>경계 검출</th>
                  <td>
                    {detect.found ? `성공 · ${detect.method}` : detect.guess ? `추정 · ${detect.method}` : '실패'} · 엣지 일치 {Math.round(detect.edgeSupport * 100)}% · 대비 {detect.contrast}
                  </td>
                </tr>
              )}
              {Object.entries({ ...loadTimings, ...(result?.timings ?? {}) }).map(([k, v]) => (
                <tr key={k} className={k === 'total' ? 'sum' : ''}>
                  <th>{TIMING_LABEL[k] ?? k}</th>
                  <td className="mono">{fmt(v)}</td>
                </tr>
              ))}
              {result && (
                <tr>
                  <th>자동 판별 지표</th>
                  <td className="mono">
                    배경 거칠기 {result.classify.bgRoughness} · 색채도 {result.classify.colorfulness}
                  </td>
                </tr>
              )}
              {bench && (
                <>
                  <tr className="sum">
                    <th>벤치마크 평균 ({bench.runs}회)</th>
                    <td className="mono">
                      검출 {fmt(bench.avg.detect)} + 스캔 {fmt(bench.avg.total)}
                    </td>
                  </tr>
                  <tr>
                    <th>WASM 메모리</th>
                    <td className="mono">{bench.heapMB} MB</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          <div className="row">
            <button className="btn small" onClick={onBench} disabled={!quad || !!busy}>
              벤치마크 (3회 반복)
            </button>
            <button className="btn small" onClick={onCopy}>
              {copied ? '복사했습니다' : '측정 결과 복사'}
            </button>
          </div>
          <details>
            <summary>측정 결과 원문</summary>
            <pre>{report()}</pre>
          </details>
        </section>
      )}

      {error && <p className="alert bad">{error}</p>}
      {busy && (
        <div className="busy" role="status">
          <span className="spinner" aria-hidden="true" />
          {busy}…
        </div>
      )}
    </div>
  );
}
