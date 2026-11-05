import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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
  plugins: [
    react(),
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
        // The OpenCV worker (WASM embedded) is ~11 MB and must work offline.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
    }),
  ],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 12000,
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
