/**
 * One JSON request against an Instagram host, with a hard timeout, the caller's AbortSignal, failure mapping to
 * `PublishError` and secret redaction. The URL of a request is never logged (it may carry the access token): the
 * log line carries only the caller's `label`.
 */
import { PublishError } from '../publish/errors';
import { abortError, isAbort, mapFailure } from './errors';
import type { SecretSet } from './redact';

export interface ClientDeps {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  now: () => number;
  secrets: SecretSet;
  log: (m: string) => void;
}

export interface CallArgs {
  method: 'GET' | 'POST';
  /** Full URL without query string. */
  url: string;
  query?: Record<string, string | undefined>;
  /** POST body, form-encoded (Graph accepts it for every publishing call). */
  form?: Record<string, string | undefined>;
  /** What to log instead of the URL, e.g. `POST /{ig-user}/media`. */
  label: string;
  signal?: AbortSignal;
}

const compact = (o: Record<string, string | undefined> | undefined): [string, string][] =>
  Object.entries(o ?? {}).filter((e): e is [string, string] => e[1] !== undefined);

export function createClient(d: ClientDeps) {
  return async function call(a: CallArgs): Promise<unknown> {
    if (a.signal?.aborted) throw abortError();
    const url = new URL(a.url);
    for (const [k, v] of compact(a.query)) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(d.timeoutMs);
    const combined = a.signal ? AbortSignal.any([a.signal, timeout]) : timeout;
    const init: RequestInit = {
      method: a.method,
      signal: combined,
      headers: { accept: 'application/json' },
    };
    if (a.form) {
      init.body = new URLSearchParams(compact(a.form)).toString();
      init.headers = { ...init.headers, 'content-type': 'application/x-www-form-urlencoded' };
    }
    let res: Response;
    try {
      res = await d.fetchImpl(url.toString(), init);
    } catch (e) {
      if (a.signal?.aborted) throw abortError();
      if (timeout.aborted) {
        d.log(`instagram: ${a.label} timed out`);
        throw new PublishError(
          'network',
          'Instagram did not answer in time. Check your connection and try again.',
          {
            cause: e,
          },
        );
      }
      d.log(`instagram: ${a.label} failed: ${d.secrets.redact(errText(e))}`);
      throw new PublishError(
        'network',
        'Could not reach Instagram. Check your internet connection and try again.',
        {
          cause: e,
        },
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (a.signal?.aborted) throw abortError();
      throw new PublishError(
        'network',
        timeout.aborted
          ? 'Instagram did not answer in time. Check your connection and try again.'
          : 'The connection to Instagram dropped. Try again.',
        { cause: e },
      );
    }
    d.log(`instagram: ${a.label} -> HTTP ${res.status}`);
    let body: unknown = null;
    let parsedOk = true;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        parsedOk = false;
      }
    }
    const hasError = typeof body === 'object' && body !== null && 'error' in (body as object);
    if (!res.ok || hasError) {
      throw mapFailure({
        status: res.ok ? 400 : res.status,
        retryAfterHeader: res.headers.get('retry-after'),
        body,
        now: d.now(),
        secrets: d.secrets,
      });
    }
    if (!parsedOk)
      throw new PublishError(
        'platform',
        'Instagram sent a response Clipfern could not read. Try again in a moment.',
      );
    return body ?? {};
  };
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

export { isAbort };
