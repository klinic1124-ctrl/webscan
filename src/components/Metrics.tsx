import { useState } from 'react';
import type { DetectResult, Mode } from '../lib/cv/pipeline';
import type { AspectChoice, Quad } from '../lib/geometry';
import { deviceSummary, scanner, type ScanResult, type SourceInfo } from '../scanner';
import { fmtMs, type EngineInfo } from '../ui';

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
  fuse: '반사광 합성',
  encode: '파일 인코딩',
  total: '스캔 합계',
};

interface Bench {
  runs: number;
  avg: Record<string, number>;
  heapMB: number;
}

interface Props {
  engine: EngineInfo | null;
  info: SourceInfo;
  detect: DetectResult | null;
  loadTimings: Record<string, number>;
  result: ScanResult | null;
  quad: Quad;
  extraQuads?: Quad[];
  mode: Mode;
  aspect: AspectChoice;
  busy: boolean;
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T | undefined>;
}

/** Developer measurements (collapsed by default). */
export function Metrics({ engine, info, detect, loadTimings, result, quad, extraQuads = [], mode, aspect, busy, run }: Props) {
  const [bench, setBench] = useState<Bench | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const onBench = () =>
    void run('벤치마크 실행 중 (3회)', async () => {
      const runs = 3;
      const sums: Record<string, number> = {};
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await scanner().detect();
        sums.detect = (sums.detect ?? 0) + performance.now() - t;
        const r = await scanner().scan(quad, { mode, aspect }, extraQuads);
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
        source: { width: info.width, height: info.height },
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
          fusion: result.fusion,
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
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
    }
  };

  const rows = { ...loadTimings, ...(result?.timings ?? {}) };

  return (
    <details className="panel metrics">
      <summary>측정 (개발용)</summary>
      <table>
        <tbody>
          {engine && (
            <tr>
              <th>OpenCV {engine.version}</th>
              <td>
                로딩 {fmtMs(engine.ms)} · SIMD {engine.simd ? '사용' : '없음'} · 스레드 {engine.threads ? '사용' : '없음'}
              </td>
            </tr>
          )}
          <tr>
            <th>원본</th>
            <td>
              {info.width}×{info.height}px ({((info.width * info.height) / 1e6).toFixed(1)} MP)
            </td>
          </tr>
          {detect && (
            <tr>
              <th>경계 검출</th>
              <td>
                {detect.found ? `성공 · ${detect.method}` : detect.guess ? `추정 · ${detect.method}` : '실패'} · 엣지 일치 {Math.round(detect.edgeSupport * 100)}% · 대비 {detect.contrast}
              </td>
            </tr>
          )}
          {Object.entries(rows).map(([k, v]) => (
            <tr key={k} className={k === 'total' ? 'sum' : ''}>
              <th>{TIMING_LABEL[k] ?? k}</th>
              <td className="mono">{fmtMs(v)}</td>
            </tr>
          ))}
          {bench && (
            <>
              <tr className="sum">
                <th>벤치마크 평균 ({bench.runs}회)</th>
                <td className="mono">
                  검출 {fmtMs(bench.avg.detect)} + 스캔 {fmtMs(bench.avg.total)}
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
        <button className="btn small" onClick={onBench} disabled={busy}>
          벤치마크 (3회 반복)
        </button>
        <button className="btn small" onClick={onCopy}>
          {copied ? '복사했습니다' : '측정 결과 복사'}
        </button>
      </div>
      {copyFailed && <p className="hint">복사하지 못했습니다. 아래 원문을 길게 눌러 직접 복사해 주세요.</p>}
      <pre>{report()}</pre>
    </details>
  );
}
