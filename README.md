# 문서 스캐너 (웹)

휴대폰으로 찍은 서류·악보·사진을 스캐너로 스캔한 것처럼 만들어 주는 웹앱입니다. 모든 처리는 브라우저 안(Web Worker + OpenCV.js WebAssembly)에서 이루어지며 서버가 필요 없습니다.

- 개발 계획서: [`docs/scanner-plan.html`](docs/scanner-plan.html)
- 0단계 검증 보고서: [`docs/phase0.md`](docs/phase0.md)
- 1단계(MVP) 기록: [`docs/phase1.md`](docs/phase1.md)
- 2단계 기록(반사광 지우기, 실시간 카메라, 엔진 경량화): [`docs/phase2.md`](docs/phase2.md)
- 3단계 기록(글자 검색 PDF): [`docs/phase3.md`](docs/phase3.md)
- 4단계 기록(악보 흑백 품질): [`docs/phase4.md`](docs/phase4.md)

## 기능

- 실시간 카메라: 문서 테두리를 화면에 표시하고, 가만히 있으면 자동 촬영. 연속 촬영으로 여러 페이지를 빠르게
- 촬영 또는 사진 불러오기(여러 장 한꺼번에 가능) → 문서 영역 자동 검출 → 꼭짓점 미세 조정
- 원근 보정, 그림자 · 조명 얼룩 제거, 컬러 / 회색조 / 흑백 / 사진 모드
- 반사광 지우기: 같은 페이지를 다른 각도로 1~2장 더 찍어 반사 부분만 채워 합성
- 여러 페이지 문서: 순서 변경, 삭제, 다시 맞추기(원본 사진을 보관하므로 화질 손실 없음)
- PDF(자동 · A4 · Letter) 또는 이미지로 공유 · 저장
- 글자 검색·복사 가능한 PDF: 기기 안에서 한국어·영어 OCR (처음 쓸 때 약 8 MB를 받음)
- 기기 안 보관함(IndexedDB), 홈 화면 설치, 오프라인 동작

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

경량 OpenCV.js: `scripts/opencv/build.sh`(Emscripten 필요) 또는 GitHub Actions의 "Slim OpenCV.js" 워크플로로 만든 `opencv.js`를 `vendor/opencv/`에 두면, 앱과 테스트가 npm 전체 빌드 대신 자동으로 그것을 씁니다. 필요한 함수 목록은 `scripts/opencv/scanner.config.py`에 있습니다.

## 구조

```
src/
  App.tsx                    화면 전환 (보관함 → 문서 → 편집), 불러오기 흐름
  components/Library.tsx     보관함, 새 스캔
  components/DocumentView.tsx 페이지 목록, 순서, PDF · 이미지 내보내기
  components/Editor.tsx      영역 맞추기, 모드, 미리보기, 저장
  components/CropEditor.tsx  꼭짓점/변 핸들, 돋보기
  components/LiveCamera.tsx  실시간 카메라, 테두리 표시, 자동·연속 촬영
  lib/stability.ts           자동 촬영 시점 판정
  components/Metrics.tsx     측정 패널 (개발용)
  lib/store.ts               IndexedDB 보관함
  lib/pdf.ts                 PDF 생성 (pdf-lib)
  lib/textLayer.ts           PDF의 보이지 않는 글자층 (OCR 결과)
  lib/ocr.ts                 OCR 결과 정리 (단어 상자, 한국어 띄어쓰기 복원)
  ocr.ts                     브라우저 OCR (Tesseract.js, 앱이 직접 제공하는 모델)
  scanner.ts                 워커 클라이언트, 사진 해독
  worker/scanner.worker.ts   OpenCV 처리 워커 (Comlink)
  lib/geometry.ts            순수 기하 계산 (꼭짓점 정렬, 직선 맞춤, 종횡비 추정)
  lib/cv/pipeline.ts         검출 · 원근 보정 · 조명 균일화 · 모드별 마무리
  lib/cv/glare.ts            여러 장 정렬 · 반사광 합성
  lib/cv/synthetic.ts        정답이 있는 합성 "휴대폰 사진" 생성기 (테스트, 샘플)
test/                        Vitest (Node에서 OpenCV.js 실행)
```
