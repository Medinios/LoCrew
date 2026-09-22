import type { RendererApi } from '../shared/ipc.js';

declare global {
  interface Window {
    api: RendererApi;
  }
}

export {};
