import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * The two Electron entry points deliberately use different module formats.
 *
 * main is CommonJS because Electron only exposes its own module to require()
 * in the main process; importing "electron" from an ESM entry point fails. The
 * ESM-only runtime SDKs are loaded with dynamic import() from inside it, which
 * also keeps them out of startup and off the path until an agent actually runs.
 *
 * preload is CommonJS because Electron only supports ESM preload scripts when
 * the renderer sandbox is disabled, and this app keeps the sandbox on.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
