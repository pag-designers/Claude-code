/**
 * SQLite failures that mean "this connection (or its file locks) is in a bad state", as opposed to a normal
 * constraint error: they are worth reopening the connection for (ADR-022).
 */
export function isDbFault(e: unknown): boolean {
  const m =
    e instanceof Error
      ? `${e.message} ${String((e as { code?: unknown }).code ?? '')} ${String((e as { cause?: unknown }).cause ?? '')}`
      : String(e);
  return /SQLITE_IOERR|disk I\/O error|malformed|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_PROTOCOL|SQLITE_CANTOPEN|unable to open database/i.test(
    m,
  );
}
