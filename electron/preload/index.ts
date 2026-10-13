import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  encodeIpcError,
  type ClipfernApi,
  type EventChannel,
  type IpcResult,
} from '@shared/ipc';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const api: ClipfernApi = {
  platform: process.platform,
  async invoke(channel, payload) {
    if (!invokeAllowed.has(channel))
      throw new Error(encodeIpcError('UNKNOWN_CHANNEL', `Unknown channel: ${String(channel)}`));
    const res = (await ipcRenderer.invoke(channel, payload)) as IpcResult<never>;
    if (!res.ok) throw new Error(encodeIpcError(res.error.code, res.error.message));
    return res.data;
  },
  on(event: EventChannel, cb: (payload: unknown) => void) {
    if (!eventAllowed.has(event))
      throw new Error(encodeIpcError('UNKNOWN_CHANNEL', `Unknown event: ${String(event)}`));
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
} as ClipfernApi;

contextBridge.exposeInMainWorld('clipfern', api);
