# 1단계 (MVP) 진행 기록

0단계 판정(iPhone, 12MP 1장 약 1.5초) 이후 2026-11-05에 착수했다.

## 완료

| 기능 | 내용 | 파일 |
|---|---|---|
| 여러 페이지 문서 | 문서마다 페이지 순서 보관. 추가(촬영 1장 → 편집 화면, 여러 장 → 자동 처리), 순서 변경(◀ ▶), 삭제(확인 단계), 다시 맞추기, 이름 변경 | `src/components/DocumentView.tsx`, `src/App.tsx` |
| 기기 안 보관함 | IndexedDB. 페이지마다 **원본 사진 · 회전 · 꼭짓점(0~1 비율) · 모드 · 비율**을 저장해 나중에 화질 손실 없이 다시 처리. 결과 이미지와 썸네일도 저장 | `src/lib/store.ts` |
| 자동 처리 표시 | 여러 장을 한 번에 불러오면 자동 검출 후 저장. 테두리를 확실히 못 찾은 페이지는 "확인 필요" 표시 | `src/App.tsx` |
| PDF 내보내기 | pdf-lib. JPEG는 재압축 없이 그대로 넣음. 용지: 자동(A4·Letter 비율이면 그 크기, 아니면 사진 비율) / A4 / Letter. 문서 이름이 PDF 제목과 파일 이름 | `src/lib/pdf.ts` |
| 저장 · 공유 | iOS 공유 시트(파일에 저장 등) 지원 시 공유 버튼, 아니면 내려받기. PDF는 "만들기" 후 별도 버튼으로 공유해 iOS의 사용자 동작 제한을 피함 | `src/components/DocumentView.tsx` |
| 홈 화면 설치 · 오프라인 | 매니페스트, 아이콘, 서비스 워커가 엔진(약 11MB) 포함 전체를 캐시. 한 번 열면 비행기 모드에서도 촬영 · 스캔 · 저장 가능 | `vite.config.ts`, `public/` |
| 저장 공간 보호 | `navigator.storage.persist()` 요청, 보관함에 "중요한 문서는 PDF로 보관" 안내 | `src/lib/store.ts` |

## 검증

- 자동 테스트 51개 통과(저장소 4, PDF 4 추가).
- 브라우저(휴대폰 화면 크기) 흐름 확인:
  - 1장 촬영 → 흑백 미리보기 → 추가
  - 2장 한꺼번에 불러오기 → 자동 처리
  - 순서 변경 → 이름 변경 → PDF(3쪽, A4) 내려받기
  - 새로고침 후 보관함 유지 → 페이지 다시 편집(컬러로 변경)
  - 새 문서에서 취소하면 빈 문서가 남지 않음
- 오프라인: 서비스 워커 설치 후 네트워크를 끊고 새로고침 → 엔진 준비 → 샘플 스캔 → 페이지 저장까지 동작.

## 보류: OpenCV.js 경량 빌드

목표: 쓰는 함수만 넣고 SIMD를 켠 OpenCV.js를 직접 빌드해 첫 다운로드(현재 brotli 2.5MB / gzip 3.5MB, 원본 10.8MB)와 처리 시간을 줄인다.

이 작업에는 Emscripten SDK와 OpenCV 소스를 내려받아 빌드해야 한다. 이번 개발 환경에서는 외부 코드를 내려받아 실행하는 단계가 안전 정책으로 막혀 진행하지 못했다. 진행 방법은 둘 중 하나다.

1. 개발 환경에서 해당 작업을 허용한 뒤 다시 요청한다.
2. 로컬 PC에서 아래처럼 빌드해 `src/vendor/opencv.js`로 넣는다. 그러면 Vite 별칭으로 교체하도록 코드를 맞춘다.

```bash
git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install 3.1.64 && ./emsdk activate 3.1.64 && source emsdk_env.sh && cd ..
git clone --depth 1 --branch 4.12.0 https://github.com/opencv/opencv
# opencv/platforms/js/opencv_js.config.py 를 사용 함수만 남기도록 수정한 뒤
python opencv/platforms/js/build_js.py build_js --build_wasm --simd
```

현재 상태에서도 엔진은 화면과 별도로 백그라운드에서 받아지고, 두 번째 방문부터는 캐시에서 즉시(약 0.1초) 준비된다. 그래서 MVP 출시를 막는 문제는 아니다.

## 남은 확인

- iPhone 실기기: 여러 장(10쪽 이상) 문서의 메모리와 PDF 크기, 홈 화면 설치 후 동작
- 안드로이드: 실기기 또는 원격 테스트 서비스
- 빌드 도구(workbox-build)의 npm audit 경고는 빌드할 때만 쓰이고 앱에는 포함되지 않는다.
