/**
 * One JSON GET against a provider, with a hard timeout, the caller's AbortSignal, status mapping to typed
 * errors, and key redaction. The API key never appears in a log line or an error message.
 */
import type { BrollProvider } from '@shared/brand';
import { abortError, networkError, providerError, rateLimitError, rejectedError } from './errors';

export type Fetch = typeof fetch;

export interface GetJsonArgs {
  provider: BrollProvider;
  /** Full URL (may carry the key: Pixabay). NEVER logged. */
  url: string;
  /** What to log instead of the URL. */
  label: string;
  headers?: Record<string, string>;
  /** Secret to scrub from anything derived from the response/exception text. */
  secret: string;
  signal?: AbortSignal;
  timeoutMs: number;
  fetchImpl: Fetch;
  log?: (m: string) => void;
  now: () => number;
}

/** Seconds to wait from the headers of a 429, or null when the provider did not say. */
export function retryAfterSeconds(
  provider: BrollProvider,
  headers: Headers,
  nowMs: number,
): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const n = Number(ra.trim());
    if (Number.isFinite(n) && n >= 0) return n;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, (at - nowMs) / 1000);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const n = Number(reset.trim());
    if (Number.isFinite(n) && n >= 0) {
      // Pexels: epoch seconds. Pixabay: seconds until the window resets.
      if (provider === 'pexels' && n > 1e9) return Math.max(0, n - nowMs / 1000);
      if (n < 1e9) return n;
    }
  }
  return null;
}

export const scrub = (text: string, secret: string): string =>
  secret ? text.split(secret).join('***') : text;

export async function getJson(a: GetJsonArgs): Promise<unknown> {
  const { provider, signal } = a;
  if (signal?.aborted) throw abortError();
  const timeout = AbortSignal.timeout(a.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  a.log?.(`broll: GET ${provider} ${a.label}`);
  let res: Response;
  try {
    res = await a.fetchImpl(a.url, { headers: a.headers, signal: combined });
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timeout.aborted) throw networkError(provider, true);
    a.log?.(`broll: ${provider} request failed: ${scrub(errText(e), a.secret)}`);
    throw networkError(provider);
  }
  if (res.status === 429) {
    void res.body?.cancel().catch(() => {});
    throw rateLimitError(provider, retryAfterSeconds(provider, res.headers, a.now()));
  }
  if (res.status === 401 || res.status === 403) {
    void res.body?.cancel().catch(() => {});
    throw rejectedError(provider);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (signal?.aborted) throw abortError();
    if (timeout.aborted) throw networkError(provider, true);
    throw networkError(provider);
  }
  if (
    res.status === 400 &&
    provider === 'pixabay' &&
    /api key|invalid key|key.*invalid/i.test(text)
  )
    throw rejectedError(provider);
  if (res.status === 404) throw providerError(provider, 'that clip is no longer available.');
  if (!res.ok) {
    a.log?.(`broll: ${provider} HTTP ${res.status}: ${scrub(text.slice(0, 120), a.secret)}`);
    throw providerError(
      provider,
      res.status >= 500
        ? `the service is having trouble (HTTP ${res.status}). Try again shortly.`
        : `the request was refused (HTTP ${res.status}).`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw providerError(
      provider,
      'sent a response Clipfern could not read. Try again in a moment.',
    );
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const c = (e as { cause?: unknown }).cause;
    const code =
      c && typeof c === 'object' && 'code' in c
        ? ` (${String((c as { code: unknown }).code)})`
        : '';
    return `${e.message}${code}`;
  }
  return String(e);
}
