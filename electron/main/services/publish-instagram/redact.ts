/**
 * Keeps secrets out of anything that can reach a log line, an error message or the UI: access tokens, the app
 * secret, authorization codes and presigned-URL signatures. Defence in depth: callers also register the exact secret
 * strings they hold, so a value is scrubbed even when it does not match a known pattern.
 */

/** Exact strings (tokens, app secret, code, signed URLs) that must never be printed. */
export class SecretSet {
  private readonly values = new Set<string>();

  add(...vals: (string | null | undefined)[]): void {
    for (const v of vals) if (v && v.length >= 6) this.values.add(v);
  }

  /** Replaces every registered secret and every secret-looking pattern. */
  redact(text: string): string {
    let out = text;
    // Longest first so that a signed URL is replaced before the token that is part of it.
    const sorted = [...this.values].sort((a, b) => b.length - a.length);
    for (const s of sorted) out = out.split(s).join('***');
    out = out.replace(
      /\b(access_token|client_secret|ig_exchange_token|code)=[^&\s"'<>]+/gi,
      '$1=***',
    );
    // Query strings of URLs (S3/R2 presigned signatures live there).
    out = out.replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g, '$1?…');
    // Instagram / Facebook user-token shapes (IGAA…, IGQV…, EAA…).
    out = out.replace(/\bIG[A-Za-z0-9_-]{40,}/g, '***').replace(/\bEAA[A-Za-z0-9]{30,}/g, '***');
    return out;
  }
}
