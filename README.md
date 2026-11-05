# 문서 스캐너 (웹)

휴대폰으로 찍은 서류·악보·사진을 스캐너로 스캔한 것처럼 만들어 주는 웹앱입니다. 모든 처리는 브라우저 안(Web Worker + OpenCV.js WebAssembly)에서 이루어지며 서버가 필요 없습니다.

- 개발 계획서: [`docs/scanner-plan.html`](docs/scanner-plan.html)
- 0단계 검증 보고서: [`docs/phase0.md`](docs/phase0.md)

## 실행

```bash
npm install
npm run dev        # 개발 서버 (같은 네트워크의 휴대폰에서 접속 가능)
npm test           # 합성 사진 기반 자동 테스트
npm run build      # dist/ 에 정적 파일 생성 → 아무 정적 호스팅에 올리면 됨
```

카메라 촬영 버튼은 HTTPS(또는 localhost)에서 동작합니다.

디버그 이미지 출력: `SCAN_DEBUG=1 npx vitest run test/debug-output.test.ts` → `test-output/`
12MP 속도 측정: `SCAN_BENCH=1 npx vitest run test/bench.test.ts`

## 구조

```
src/
  App.tsx                    화면 (가져오기 → 영역 맞추기 → 결과 → 측정)
  components/CropEditor.tsx  꼭짓점/변 핸들, 돋보기
  scanner.ts                 워커 클라이언트, 사진 해독
  worker/scanner.worker.ts   OpenCV 처리 워커 (Comlink)
  lib/geometry.ts            순수 기하 계산 (꼭짓점 정렬, 직선 맞춤, 종횡비 추정)
  lib/cv/pipeline.ts         검출 · 원근 보정 · 조명 균일화 · 모드별 마무리
  lib/cv/synthetic.ts        정답이 있는 합성 "휴대폰 사진" 생성기 (테스트, 샘플)
test/                        Vitest (Node에서 OpenCV.js 실행)
```
