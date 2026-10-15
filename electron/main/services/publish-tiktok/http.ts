/**
 * One HTTP client for the TikTok hosts: hard timeout + the caller's AbortSignal, typed errors, and redaction of
 * every secret (tokens, client secret, authorization code, upload-URL query strings) in logs and messages.
 */
import { PublishError } from '../publish/errors';
import { mapApiFailure, redact } from './errors';
import { isObject } from './lenient';

export type Fetch = typeof fetch;

export interface ClientOpts {
  fetchImpl: Fetch;
  apiBase: string;
  timeoutMs: number;
  log?: (m: string) => void;
  now: () => number;
  /** Secrets known up front; more can be added with `addSecret`. */
  secrets?: (string | null | undefined)[];
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

export const abortError = (): Error => {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
};

export function retryAfterSeconds(headers: Headers, nowMs: number): number | null {
  const ra = headers.get('retry-after');
  if (!ra) return null;
  const n = Number(ra.trim());
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, (at - nowMs) / 1000) : null;
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const c = (e as { cause?: unknown }).cause;
    const code =
      c && typeof c === 'object' && 'code' in c
        ? ` (${String((c as { code: unknown }).code)})`
        : '';
    return `${e.name}: ${e.message}${code}`;
  }
  return String(e);
}

export class TiktokClient {
  private readonly secrets: string[];

  constructor(private readonly o: ClientOpts) {
    this.secrets = (o.secrets ?? []).filter((s): s is string => !!s);
  }

  addSecret(s: string | null | undefined): void {
    if (s && !this.secrets.includes(s)) this.secrets.push(s);
  }

  scrub(text: string): string {
    return redact(text, this.secrets);
  }

  log(m: string): void {
    this.o.log?.(this.scrub(m));
  }

  /** One request; throws AbortError on abort and PublishError('network') on timeout / transport failure. */
  async raw(a: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Log label (a path, never a URL with a query). */
    label: string;
    doing: string;
  }): Promise<RawResponse> {
    const { signal } = a;
    if (signal?.aborted) throw abortError();
    const timeout = AbortSignal.timeout(a.timeoutMs ?? this.o.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.o.fetchImpl(a.url, {
        method: a.method,
        headers: a.headers,
        body: a.body as BodyInit | undefined,
        signal: combined,
        redirect: 'manual',
      });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      this.log(`tiktok: ${a.method} ${a.label} failed: ${errText(e)}`);
      throw new PublishError(
        'network',
        timeout.aborted
          ? `TikTok did not answer in time while ${a.doing}.`
          : `Could not reach TikTok while ${a.doing}. Check the internet connection.`,
        { retryable: true },
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      if (signal?.aborted) throw abortError();
      throw new PublishError(
        'network',
        timeout.aborted
          ? `TikTok did not answer in time while ${a.doing}.`
          : `The connection to TikTok dropped while ${a.doing}.`,
        { retryable: true },
      );
    }
    this.log(`tiktok: ${a.method} ${a.label} -> ${res.status}`);
    return { status: res.status, headers: res.headers, text };
  }

  /**
   * A v2 API call: `{ data, error: { code, message, log_id } }` where `error.code === 'ok'` means success.
   * Returns `data` (unknown; callers parse leniently) and the raw text.
   */
  async api(a: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    token: string;
    body?: unknown;
    signal?: AbortSignal;
    doing: string;
  }): Promise<{ data: unknown; text: string; status: number }> {
    this.addSecret(a.token);
    const qs = a.query ? `?${new URLSearchParams(a.query).toString()}` : '';
    const res = await this.raw({
      method: a.method,
      url: `${this.o.apiBase}${a.path}${qs}`,
      headers: {
        Authorization: `Bearer ${a.token}`,
        ...(a.body !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
      },
      body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
      signal: a.signal,
      label: a.path,
      doing: a.doing,
    });
    const json = parseJson(res.text);
    const err = isObject(json) && isObject(json.error) ? json.error : null;
    const code = err && typeof err.code === 'string' ? err.code : '';
    if (res.status >= 200 && res.status < 300 && (code === 'ok' || (!err && isObject(json)))) {
      return { data: isObject(json) ? json.data : undefined, text: res.text, status: res.status };
    }
    if (res.status >= 200 && res.status < 300 && !isObject(json))
      throw new PublishError(
        'platform',
        'TikTok sent a response Clipfern could not read. Try again in a moment.',
      );
    this.log(`tiktok: ${a.path} error ${res.status} ${code || '(no code)'}`);
    throw mapApiFailure({
      httpStatus: res.status,
      code,
      message: this.scrub(err && typeof err.message === 'string' ? err.message : ''),
      retryAfterSec: retryAfterSeconds(res.headers, this.o.now()),
      doing: a.doing,
    });
  }

  /** POST form to the OAuth token / revoke endpoints. Returns the parsed object or throws a mapped error. */
  async oauth(a: {
    path: string;
    form: Record<string, string>;
    signal?: AbortSignal;
    doing: string;
  }): Promise<Record<string, unknown>> {
    const res = await this.raw({
      method: 'POST',
      url: `${this.o.apiBase}${a.path}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams(a.form).toString(),
      signal: a.signal,
      label: a.path,
      doing: a.doing,
    });
    const json = parseJson(res.text);
    const obj = isObject(json) ? json : {};
    const code = typeof obj.error === 'string' ? obj.error : '';
    if (res.status >= 200 && res.status < 300 && !code) return obj;
    this.log(`tiktok: ${a.path} error ${res.status} ${code || '(no code)'}`);
    throw mapApiFailure({
      httpStatus: res.status,
      code: code || (res.status === 400 || res.status === 401 ? 'invalid_grant' : ''),
      message: this.scrub(typeof obj.error_description === 'string' ? obj.error_description : ''),
      retryAfterSec: retryAfterSeconds(res.headers, this.o.now()),
      doing: a.doing,
    });
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
