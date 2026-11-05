import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
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
  plugins: [react()],
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
