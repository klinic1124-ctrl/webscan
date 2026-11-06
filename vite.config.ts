import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

// A slim OpenCV.js built by scripts/opencv/build.sh replaces the full npm
// build when present (same API, only the functions the scanner uses).
const slimCv = fileURLToPath(new URL('./vendor/opencv/opencv.js', import.meta.url));
const cvAlias: Record<string, string> = existsSync(slimCv) ? { '@techstark/opencv-js': slimCv } : {};

// OCR engine files, served from this app under ocr/ with fixed names
// (Tesseract.js looks them up by name): worker, SIMD core + WASM, and the
// Korean and English models (best_int: accurate and small).
const req = createRequire(import.meta.url);
const OCR_FILES: Record<string, string> = {
  'worker.min.js': req.resolve('tesseract.js/dist/worker.min.js'),
  'tesseract-core-simd-lstm.js': req.resolve('tesseract.js-core/tesseract-core-simd-lstm.js'),
  'tesseract-core-simd-lstm.wasm': req.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm'),
  'lang/kor.traineddata.gz': req.resolve('@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz'),
  'lang/eng.traineddata.gz': req.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
};
const OCR_TYPES: Record<string, string> = { js: 'text/javascript', wasm: 'application/wasm', gz: 'application/octet-stream' };

function ocrFiles(): Plugin {
  return {
    name: 'ocr-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/ocr\/([^?]+)/);
        const file = m && OCR_FILES[m[1]];
        if (!file) return next();
        res.setHeader('Content-Type', OCR_TYPES[file.split('.').pop()!] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [name, file] of Object.entries(OCR_FILES))
        this.emitFile({ type: 'asset', fileName: `ocr/${name}`, source: readFileSync(file) });
    },
  };
}

// Build ID shown in the app and in measurement reports, so a report can be
// matched to the code that produced it (git commit + build date).
function buildId(): string {
  let rev = 'dev';
  try {
    rev = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    /* not a git checkout */
  }
  return `${rev}-${new Date().toISOString().slice(0, 10)}`;
}

export default defineConfig({
  resolve: { alias: cvAlias },
  plugins: [
    react(),
    ocrFiles(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered in main.tsx so failures stay silent
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '문서 스캐너',
        short_name: '스캐너',
        description: '휴대폰으로 찍은 서류·악보·사진을 스캐너처럼 바르게 펴서 PDF로 저장합니다.',
        lang: 'ko',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f3f5f5',
        theme_color: '#0f7f86',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // The OpenCV worker (WASM embedded, ~6 MB slim / ~11 MB npm) must work offline.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        // OCR (~8 MB) is optional: fetched on first use, then kept.
        globIgnores: ['ocr/**'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'ocr', expiration: { maxEntries: 10 } },
          },
        ],
      },
    }),
  ],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  base: './',
  worker: { format: 'es' },
  // Emit non-ASCII characters as \u escapes: some hosts reject bundles that
  // contain literal U+FFFD (pdf-lib uses one in a string).
  esbuild: { charset: 'ascii' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 12000,
    // The slim OpenCV.js is CommonJS/UMD like the npm one; convert it too.
    commonjsOptions: { include: [/node_modules/, /vendor[\\/]opencv/] },
  },
  test: {
    environment: 'node',
    alias: {
      '@techstark/opencv-js': fileURLToPath(new URL('./test/util/opencv-node.ts', import.meta.url)),
    },
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
