import Anthropic from '@anthropic-ai/sdk';
import { redact } from '../../logger';

export type LlmErrorCode =
  | 'no-key'
  | 'auth'
  | 'billing'
  | 'rate-limit'
  | 'overloaded'
  | 'network'
  | 'bad-request'
  | 'refusal'
  | 'truncated'
  | 'invalid-output'
  | 'too-long'
  | 'empty-transcript'
  | 'api';

/** Every failure of the LLM layer carries a stable `code` and a user-presentable message. */
export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(redact(message), options);
    this.name = 'LlmError';
  }
}

export const NO_KEY_MESSAGE = 'Add your Anthropic API key in Settings → API Keys.';

export function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof Anthropic.APIUserAbortError ||
    (e instanceof Error && (e.name === 'AbortError' || e.name === 'APIUserAbortError'))
  );
}

/** Anthropic error type from the response body, e.g. "overloaded_error". */
function bodyErrorType(e: InstanceType<typeof Anthropic.APIError>): string | null {
  const body = e.error as { error?: { type?: unknown } } | undefined;
  const t = body?.error?.type;
  return typeof t === 'string' ? t : null;
}

/**
 * Errors worth ONE more attempt when they appear after the response stream had started (the SDK
 * already retries connection-level failures and 429/5xx before the first byte).
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof Anthropic.APIUserAbortError) return false;
  if (e instanceof Anthropic.APIConnectionError) return true;
  if (e instanceof Anthropic.APIError) {
    if (e.status === undefined) {
      const t = bodyErrorType(e);
      return t === 'overloaded_error' || t === 'api_error';
    }
    return e.status === 429 || e.status >= 500;
  }
  return false;
}

export function mapApiError(e: unknown, model: string): Error {
  if (e instanceof LlmError) return e;
  if (isAbortError(e)) return e instanceof Error ? e : abortError();
  if (e instanceof Anthropic.AuthenticationError)
    return new LlmError(
      'auth',
      'Anthropic rejected the API key. Re-enter it in Settings → API Keys and press Test.',
      { cause: e },
    );
  if (e instanceof Anthropic.PermissionDeniedError)
    return new LlmError(
      'auth',
      `This API key is not allowed to use ${model}. Check the key's permissions or pick another model in Settings.`,
      { cause: e },
    );
  if (e instanceof Anthropic.NotFoundError)
    return new LlmError(
      'bad-request',
      `Anthropic does not know the model "${model}". Check the model names in Settings.`,
      { cause: e },
    );
  if (e instanceof Anthropic.RateLimitError)
    return new LlmError(
      'rate-limit',
      'Anthropic rate limit reached and automatic retries ran out. Wait a minute and retry.',
      { cause: e },
    );
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance|billing/i.test(e.message))
      return new LlmError(
        'billing',
        'Your Anthropic account has no credit left. Add credit at console.anthropic.com → Plans & Billing.',
        { cause: e },
      );
    return new LlmError('bad-request', `Anthropic rejected the request: ${e.message}`, {
      cause: e,
    });
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new LlmError('network', 'The request to Anthropic timed out. Retry in a moment.', {
      cause: e,
    });
  if (e instanceof Anthropic.APIConnectionError)
    return new LlmError(
      'network',
      'Could not reach the Anthropic API. Check your internet connection.',
      { cause: e },
    );
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529 || bodyErrorType(e) === 'overloaded_error')
      return new LlmError('overloaded', 'Anthropic is overloaded right now. Retry in a minute.', {
        cause: e,
      });
    return new LlmError(
      'api',
      `Anthropic API error${e.status ? ` (${e.status})` : ''}: ${e.message}`,
      {
        cause: e,
      },
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}
