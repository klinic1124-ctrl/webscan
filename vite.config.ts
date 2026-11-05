import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
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
