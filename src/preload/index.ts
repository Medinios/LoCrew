import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNEL, isInvokeChannel, type InvokeChannelName } from '../shared/channels.js';

/**
 * The only bridge between the renderer and the main process.
 *
 * This file runs in a sandboxed context, so it imports nothing but Electron and
 * the dependency-free channel allowlist. `invoke` refuses any channel outside
 * that list, which means a compromised renderer cannot reach arbitrary IPC.
 * No Node primitive, filesystem handle or shell access crosses this boundary.
 */
const api = {
  invoke(channel: InvokeChannelName, payload?: unknown): Promise<unknown> {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },

  onEvent(listener: (event: unknown) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
    };
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);
