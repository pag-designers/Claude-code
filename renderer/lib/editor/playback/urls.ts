/**
 * Preview-URL cache. `editor:previewUrl` returns a presigned URL (or `{url: null, reason}`); URLs expire, so a ready entry
 * is refreshed in the background once it is older than `ttlMs` (the old URL keeps working until the new one arrives), and
 * a media error invalidates it. Pure bookkeeping — the IPC call is injected.
 */
export interface UrlResult {
  url: string | null;
  reason: string | null;
}

export type UrlState =
  | { status: 'loading'; url: null; reason: null; fetchedAt: number; version: number }
  | { status: 'ready'; url: string; reason: null; fetchedAt: number; version: number }
  | { status: 'error'; url: null; reason: string | null; fetchedAt: number; version: number };

export interface PreviewUrlsDeps {
  fetch(assetId: string): Promise<UrlResult>;
  now(): number;
  onChange(): void;
  /** How long a presigned URL is trusted. Default 15 minutes (the existing library URLs live 20). */
  ttlMs?: number;
  /** An error is retried automatically after this long (network blips); 0 = never. Default 30 s. */
  retryErrorAfterMs?: number;
}

export class PreviewUrls {
  private readonly states = new Map<string, UrlState>();
  private readonly inflight = new Set<string>();
  private readonly ttl: number;
  private readonly retryAfter: number;
  private disposed = false;
  private versionCounter = 0;

  constructor(private readonly deps: PreviewUrlsDeps) {
    this.ttl = deps.ttlMs ?? 15 * 60_000;
    this.retryAfter = deps.retryErrorAfterMs ?? 30_000;
  }

  /** Current state; starts a fetch when unknown, stale or (after the retry delay) failed. */
  get(assetId: string): UrlState {
    const st = this.states.get(assetId);
    if (!st) {
      const loading: UrlState = {
        status: 'loading',
        url: null,
        reason: null,
        fetchedAt: this.deps.now(),
        version: ++this.versionCounter,
      };
      this.states.set(assetId, loading);
      this.load(assetId);
      return loading;
    }
    const age = this.deps.now() - st.fetchedAt;
    if (st.status === 'ready' && age > this.ttl) this.load(assetId);
    else if (st.status === 'error' && this.retryAfter > 0 && age > this.retryAfter)
      this.load(assetId);
    return st;
  }

  peek(assetId: string): UrlState | undefined {
    return this.states.get(assetId);
  }

  /** The URL stopped working (media error / 403): forget it and fetch a fresh one. */
  invalidate(assetId: string): void {
    const st = this.states.get(assetId);
    if (st?.status === 'ready') {
      this.states.set(assetId, {
        status: 'loading',
        url: null,
        reason: null,
        fetchedAt: this.deps.now(),
        version: ++this.versionCounter,
      });
      this.deps.onChange();
    }
    this.load(assetId);
  }

  /** Manual retry (the error state's button). */
  retry(assetId: string): void {
    this.states.set(assetId, {
      status: 'loading',
      url: null,
      reason: null,
      fetchedAt: this.deps.now(),
      version: ++this.versionCounter,
    });
    this.deps.onChange();
    this.load(assetId);
  }

  forget(assetId: string): void {
    this.states.delete(assetId);
  }

  dispose(): void {
    this.disposed = true;
    this.states.clear();
  }

  private load(assetId: string): void {
    if (this.inflight.has(assetId) || this.disposed) return;
    this.inflight.add(assetId);
    void this.deps
      .fetch(assetId)
      .then(
        (r) => r,
        (e: unknown): UrlResult => ({
          url: null,
          reason: e instanceof Error ? e.message : 'the preview URL could not be fetched',
        }),
      )
      .then((r) => {
        this.inflight.delete(assetId);
        if (this.disposed) return;
        const prev = this.states.get(assetId);
        const now = this.deps.now();
        const version = ++this.versionCounter;
        if (r.url) {
          // Same URL again (still valid): keep the version so consumers don't reload.
          const same = prev?.status === 'ready' && prev.url === r.url;
          this.states.set(assetId, {
            status: 'ready',
            url: r.url,
            reason: null,
            fetchedAt: now,
            version: same ? prev.version : version,
          });
          if (!same) this.deps.onChange();
        } else if (prev?.status === 'ready' && prev.fetchedAt + this.ttl * 2 > now) {
          // A background refresh failed: keep the still-usable old URL, try again later.
          this.states.set(assetId, { ...prev, fetchedAt: prev.fetchedAt + this.ttl * 0.9 });
        } else {
          this.states.set(assetId, {
            status: 'error',
            url: null,
            reason: r.reason,
            fetchedAt: now,
            version,
          });
          this.deps.onChange();
        }
      });
  }
}
