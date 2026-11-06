import { transfer } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Quad } from '../lib/geometry';
import { StabilityTracker } from '../lib/stability';
import { scanner } from '../scanner';

interface Props {
  /** Start in continuous mode (pages are saved and the camera stays open). */
  continuous: boolean;
  /** Pages saved in this camera session (continuous mode). */
  saved: number;
  /**
   * Called with a full-resolution frame. In continuous mode the camera waits
   * for the returned promise (the page is being processed and saved).
   */
  onShot: (photo: Blob, continuous: boolean) => Promise<void>;
  /** The system camera app instead (higher resolution on some phones). */
  onNativePhoto: (file: File) => void;
  onClose: () => void;
}

type Status = 'starting' | 'live' | 'error';

const FRAME_LONG_SIDE = 640;
const DETECT_INTERVAL = 90; // ms between detections (after the previous one finished)

export function liveCameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

/**
 * Full-screen camera with the detected page outline drawn live. Takes the
 * picture by itself once the outline has been still for about a second,
 * or on the shutter button.
 */
export function LiveCamera({ continuous: startContinuous, saved, onShot, onNativePhoto, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackerRef = useRef(new StabilityTracker());
  const busyRef = useRef(false); // capturing / saving: detection paused
  const autoRef = useRef(true);
  const contRef = useRef(startContinuous);
  const quadRef = useRef<Quad | null>(null);
  const [status, setStatus] = useState<Status>('starting');
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [quad, setQuad] = useState<Quad | null>(null); // in video pixels
  const [guess, setGuess] = useState(false);
  const [progress, setProgress] = useState(0);
  const [auto, setAuto] = useState(true);
  const [cont, setCont] = useState(startContinuous);
  const [phase, setPhase] = useState<'idle' | 'flash' | 'saving'>('idle');
  const [armed, setArmed] = useState(true);
  autoRef.current = auto;
  contRef.current = cont;

  // Start the camera.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setSize({ w: v.videoWidth, h: v.videoHeight });
        setStatus('live');
      } catch (e) {
        const name = (e as Error).name;
        setError(
          name === 'NotAllowedError'
            ? '카메라 사용이 허용되지 않았습니다. 브라우저 설정에서 카메라를 허용하거나, 아래의 기본 카메라로 찍어 주세요.'
            : name === 'NotFoundError'
              ? '사용할 수 있는 카메라가 없습니다.'
              : `카메라를 열지 못했습니다 (${name}).`,
        );
        setStatus('error');
      }
    })();
    return () => {
      alive = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const capture = useCallback(async () => {
    const v = videoRef.current;
    if (!v || busyRef.current || !v.videoWidth) return;
    busyRef.current = true;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
      if (!blob) throw new Error('사진을 만들지 못했습니다');
      setPhase('flash');
      trackerRef.current.markCaptured(quadRef.current && normalize(quadRef.current, v.videoWidth, v.videoHeight));
      setArmed(false);
      setProgress(0);
      window.setTimeout(() => setPhase((p) => (p === 'flash' ? (contRef.current ? 'saving' : 'idle') : p)), 180);
      await onShot(blob, contRef.current);
    } finally {
      setPhase('idle');
      busyRef.current = false;
    }
  }, [onShot]);

  // Detection loop.
  useEffect(() => {
    if (status !== 'live') return;
    let stop = false;
    let timer = 0;
    const canvas = document.createElement('canvas');
    const tick = async () => {
      const v = videoRef.current;
      if (stop || !v) return;
      if (!busyRef.current && v.readyState >= 2 && v.videoWidth) {
        const f = Math.min(1, FRAME_LONG_SIDE / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * f);
        canvas.height = Math.round(v.videoHeight * f);
        canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
        try {
          const bmp = await createImageBitmap(canvas);
          const d = await scanner().detectFrame(transfer(bmp, [bmp]));
          if (stop) return;
          const usable = d.found || d.guess;
          const q = usable ? (d.quad.map((p) => ({ x: p.x / f, y: p.y / f })) as Quad) : null;
          quadRef.current = q;
          setQuad(q);
          setGuess(!d.found && d.guess);
          // Only a confident outline counts towards auto-capture.
          const st = trackerRef.current.push(performance.now(), d.found && q ? normalize(q, v.videoWidth, v.videoHeight) : null);
          setProgress(st.progress);
          setArmed(st.armed);
          if (st.ready && autoRef.current && !busyRef.current) await capture();
        } catch {
          /* a dropped frame is fine */
        }
      }
      if (!stop) timer = window.setTimeout(tick, DETECT_INTERVAL);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [status, capture]);

  const message =
    phase === 'saving'
      ? '저장하는 중…'
      : phase === 'flash'
        ? '찍었습니다'
        : status !== 'live'
          ? status === 'starting'
            ? '카메라를 여는 중…'
            : ''
          : !quad
            ? '문서 전체가 화면에 들어오게 비춰 주세요'
            : guess
              ? '테두리가 흐립니다. 종이와 색이 다른 바닥에 놓아 보세요'
              : !armed
                ? '다음 페이지를 놓아 주세요'
                : auto
                  ? '그대로 들고 계세요…'
                  : '셔터를 눌러 찍으세요';
  const lowRes = size.w > 0 && Math.max(size.w, size.h) < 2000;
  const ring = 2 * Math.PI * 34;

  return (
    <div className="cam" role="dialog" aria-label="문서 촬영">
      <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
      {status === 'live' && size.w > 0 && (
        <svg className="cam-overlay" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {quad && (
            <polygon
              points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
              className={`cam-quad${guess ? ' guess' : ''}${!armed ? ' done' : ''}`}
              strokeWidth={Math.max(size.w, size.h) / 220}
            />
          )}
        </svg>
      )}
      {phase === 'flash' && <div className="cam-flash" />}

      <div className="cam-top">
        <button className="cam-icon" onClick={onClose} aria-label="닫기">
          ✕
        </button>
        <div className="cam-msg" role="status" aria-live="polite">
          {message}
        </div>
        <span className="cam-res mono">{size.w ? `${size.w}×${size.h}` : ''}</span>
      </div>

      {status === 'error' && <p className="cam-error">{error}</p>}

      <div className="cam-bottom">
        {lowRes && <p className="cam-note">카메라 해상도가 낮습니다. 작은 글씨는 아래 "기본 카메라로 찍기"가 더 선명합니다.</p>}
        <div className="cam-controls">
          <div className="cam-toggles">
            <button className={`cam-chip${auto ? ' on' : ''}`} aria-pressed={auto} onClick={() => setAuto((a) => !a)}>
              자동 촬영
            </button>
            <button className={`cam-chip${cont ? ' on' : ''}`} aria-pressed={cont} onClick={() => setCont((c) => !c)}>
              연속 촬영
            </button>
          </div>
          <button className="cam-shutter" onClick={() => void capture()} disabled={status !== 'live' || phase !== 'idle'} aria-label="찍기">
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle cx="40" cy="40" r="34" className="cam-ring-bg" />
              <circle
                cx="40"
                cy="40"
                r="34"
                className="cam-ring"
                strokeDasharray={`${ring * (auto && armed ? progress : 0)} ${ring}`}
                transform="rotate(-90 40 40)"
              />
              <circle cx="40" cy="40" r="27" className="cam-dot" />
            </svg>
          </button>
          <div className="cam-side">
            {cont && saved > 0 ? (
              <button className="cam-done" onClick={onClose}>
                완료 · {saved}쪽
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
        <label className="cam-native">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) onNativePhoto(f);
            }}
          />
          기본 카메라로 찍기
        </label>
      </div>
    </div>
  );
}

function normalize(q: Quad, w: number, h: number): Quad {
  return q.map((p) => ({ x: p.x / w, y: p.y / h })) as Quad;
}
