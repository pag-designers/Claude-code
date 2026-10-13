import { z } from 'zod';
import {
  invokeContract,
  type ipcErrorSchema,
  type InvokeChannel,
  type InvokeOutput,
  type IpcResult,
} from '@shared/ipc';

export class AppError extends Error {
  constructor(
    public readonly code: z.infer<typeof ipcErrorSchema>['code'],
    message: string,
  ) {
    super(message);
  }
}

export type Handlers = {
  [C in InvokeChannel]: (
    input: z.output<(typeof invokeContract)[C]['input']>,
  ) => Promise<InvokeOutput<C>> | InvokeOutput<C>;
};

/**
 * Validates input AND output of every handler against the contract (ADR-009) and converts
 * thrown errors into serialisable `{code,message}` results.
 */
export async function dispatch<C extends InvokeChannel>(
  channel: C,
  raw: unknown,
  handler: Handlers[C],
): Promise<IpcResult<InvokeOutput<C>>> {
  const def = invokeContract[channel];
  const parsed = def.input.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: `Invalid payload for ${channel}: ${z.prettifyError(parsed.error)}`,
      },
    };
  }
  try {
    const result = await (handler as (i: unknown) => unknown)(parsed.data);
    const out = def.output.safeParse(result);
    if (!out.success) {
      return {
        ok: false,
        error: {
          code: 'FAILED',
          message: `Handler for ${channel} returned an invalid result: ${z.prettifyError(out.error)}`,
        },
      };
    }
    return { ok: true, data: out.data as InvokeOutput<C> };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message } };
    return {
      ok: false,
      error: { code: 'FAILED', message: e instanceof Error ? e.message : String(e) },
    };
  }
}
