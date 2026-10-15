import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { invokeContract, type InvokeChannel, type IpcResult } from '@shared/ipc';
import { dispatch, type Handlers } from './dispatch';

export function registerHandlers(
  handlers: Handlers,
  isTrusted: (e: IpcMainInvokeEvent) => boolean,
): void {
  for (const channel of Object.keys(invokeContract) as InvokeChannel[]) {
    const h = handlers[channel];
    if (!h) throw new Error(`Missing IPC handler for ${channel}`);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!isTrusted(event)) {
        return {
          ok: false,
          error: { code: 'FAILED', message: 'Untrusted sender' },
        } satisfies IpcResult<never>;
      }
      return dispatch(channel, raw, h as never);
    });
  }
}
