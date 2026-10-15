/**
 * Transport for the YouTube publisher: one request with a hard timeout and the caller's AbortSignal. Network-level
 * failures surface as `TransportError` (the upload loop retries those), user aborts as an `AbortError`.
 * Nothing here logs URLs or headers (they carry bearer tokens and upload-session ids).
 */
export type Fetch = typeof fetch;

export interface HttpCtx {
  fetchImpl: Fetch;
  timeoutMs: number;
  log: (m: string) => void;
  now: () => number;
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
}

export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    readonly timedOut: boolean,
    cause?: unknown,
  ) {
    super(timedOut ? 'request timed out' : 'network error', cause !== undefined ? { cause } : undefined);
  }
}

export function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

export interface SendInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function send(ctx: HttpCtx, url: string, init: SendInit): Promise<Reply> {
  const { signal } = init;
  if (signal?.aborted) throw abortError();
  const timeout = AbortSignal.timeout(init.timeoutMs ?? ctx.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await ctx.fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: combined,
      // A resumable-upload 308 ("Resume Incomplete") must reach us as is, never be followed as a redirect.
      redirect: 'manual',
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw new TransportError(timeout.aborted, e);
  }
}

/** Replaces every secret (>= 4 chars) in `text` by `***`. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Retry-After in seconds (delta or HTTP date), null when absent/unreadable. */
export function retryAfterSec(headers: Headers, nowMs: number): number | null {
  const ra = headers.get('retry-after')?.trim();
  if (!ra) return null;
  const n = Number(ra);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, (at - nowMs) / 1000) : null;
}
