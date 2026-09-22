import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The React plugin supplies the automatic JSX runtime that the renderer
  // component tests need; the main-process tests are unaffected by it.
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    environment: 'node',
    // Renderer component tests need a DOM; everything else runs in plain Node.
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
