/**
 * Optimistic, debounced, revision-checked saving of ONE Brand Kit (framework free, unit tested).
 *
 * - `edit()` applies a patch to the local draft immediately and schedules a flush (text/slider edits are debounced,
 *   discrete edits pass `immediate`). Top-level spec keys are REPLACED whole, exactly like `brand:update`.
 * - Saves are serialised and carry `baseRev`; a CONFLICT keeps the local edits, stops saving and raises `conflict`
 *   until the person reloads (drop local edits) or keeps theirs (re-base onto the latest revision and resend).
 * - `adopt()` takes a newer server copy only while nothing is pending, so a late refetch can never clobber an edit.
 */
import type { BrandKit, BrandKitPatch } from '@shared/brand';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface SaverSnapshot {
  /** Server copy with every pending/in-flight edit applied: what the UI shows. */
  kit: BrandKit;
  status: SaveStatus;
  error: string | null;
  savedAt: number | null;
}

export type UpdateFn = (input: {
  id: string;
  patch: BrandKitPatch;
  baseRev: number;
}) => Promise<BrandKit>;

export interface SaverOptions {
  update: UpdateFn;
  debounceMs?: number;
  now?: () => number;
}

export function mergePatch(a: BrandKitPatch, b: BrandKitPatch): BrandKitPatch {
  const out: BrandKitPatch = {};
  const name = b.name ?? a.name;
  if (name !== undefined) out.name = name;
  if (a.spec || b.spec) out.spec = { ...a.spec, ...b.spec };
  return out;
}

export function applyPatch(kit: BrandKit, patch: BrandKitPatch): BrandKit {
  if (patch.name === undefined && !patch.spec) return kit;
  return {
    ...kit,
    name: patch.name ?? kit.name,
    spec: patch.spec ? { ...kit.spec, ...patch.spec } : kit.spec,
  };
}

const isEmpty = (p: BrandKitPatch) =>
  p.name === undefined && (!p.spec || Object.keys(p.spec).length === 0);

function codeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

export class KitSaver {
  private server: BrandKit;
  private pending: BrandKitPatch = {};
  private inflight: BrandKitPatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private status: SaveStatus = 'idle';
  private error: string | null = null;
  private savedAt: number | null = null;
  private snap: SaverSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly updateFn: UpdateFn;
  private running: Promise<void> | null = null;

  constructor(kit: BrandKit, opts: SaverOptions) {
    this.server = kit;
    this.updateFn = opts.update;
    this.debounceMs = opts.debounceMs ?? 450;
    this.now = opts.now ?? Date.now;
    this.snap = this.build();
  }

  /* ------------------------------------------------------------- store api (useSyncExternalStore) */

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): SaverSnapshot => this.snap;

  private build(): SaverSnapshot {
    const draft = applyPatch(applyPatch(this.server, this.inflight ?? {}), this.pending);
    return { kit: draft, status: this.status, error: this.error, savedAt: this.savedAt };
  }

  private emit() {
    const next = this.build();
    const prev = this.snap;
    if (
      prev.kit === next.kit &&
      prev.status === next.status &&
      prev.error === next.error &&
      prev.savedAt === next.savedAt
    )
      return;
    this.snap = next;
    for (const l of [...this.listeners]) l();
  }

  /* ------------------------------------------------------------------------------------- editing */

  /** Apply `patch` to the draft now; sends it after the debounce (or at once with `immediate`). */
  edit(patch: BrandKitPatch, opts: { immediate?: boolean } = {}): void {
    if (isEmpty(patch)) return;
    this.pending = mergePatch(this.pending, patch);
    if (this.status !== 'conflict' && this.status !== 'saving') {
      this.status = 'dirty';
      this.error = null;
    }
    this.emit();
    if (this.status === 'conflict') return;
    this.schedule(opts.immediate ? 0 : this.debounceMs);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  /** Sends everything pending. Resolves when the queue is empty (or saving is blocked by a conflict/error). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (!isEmpty(this.pending) && this.status !== 'conflict') {
      const sent = this.pending;
      this.pending = {};
      this.inflight = sent;
      this.status = 'saving';
      this.error = null;
      this.emit();
      try {
        const saved = await this.updateFn({
          id: this.server.id,
          patch: sent,
          baseRev: this.server.rev,
        });
        this.inflight = null;
        this.server = saved;
        this.savedAt = this.now();
        this.status = isEmpty(this.pending) ? 'saved' : 'dirty';
        this.emit();
      } catch (e) {
        this.inflight = null;
        this.pending = mergePatch(sent, this.pending);
        if (codeOf(e) === 'CONFLICT') {
          this.status = 'conflict';
          this.error = null;
        } else {
          this.status = 'error';
          this.error = e instanceof Error ? e.message : 'Could not save.';
        }
        this.emit();
        return;
      }
    }
  }

  /** After an error: try again right away. */
  retry(): Promise<void> {
    if (this.status === 'error') this.status = isEmpty(this.pending) ? 'idle' : 'dirty';
    this.emit();
    return this.flush();
  }

  /* --------------------------------------------------------------------- external copy of the kit */

  /**
   * A fresher copy arrived (refetch, `brand:changed`). Taken only when there is nothing to lose. Returns true when
   * the draft changed.
   */
  adopt(latest: BrandKit): boolean {
    if (latest.id !== this.server.id) return false;
    if (this.status === 'conflict' || this.status === 'saving' || !isEmpty(this.pending))
      return false;
    if (latest.rev <= this.server.rev && latest.isDefault === this.server.isDefault) return false;
    this.server = latest;
    if (this.status === 'error') this.status = 'idle';
    this.emit();
    return true;
  }

  /** Conflict → drop my edits and show the latest saved kit. */
  reload(latest: BrandKit): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = {};
    this.server = latest;
    this.status = 'idle';
    this.error = null;
    this.emit();
  }

  /** Conflict → keep my edits: re-base them onto the latest revision and send. */
  keepMine(latest: BrandKit): Promise<void> {
    this.server = latest;
    this.status = isEmpty(this.pending) ? 'idle' : 'dirty';
    this.emit();
    return this.flush();
  }

  /** Server-managed flags (default star) that are not part of a patch. */
  setDefaultFlag(isDefault: boolean) {
    if (this.server.isDefault === isDefault) return;
    this.server = { ...this.server, isDefault };
    this.emit();
  }

  hasPending(): boolean {
    return !isEmpty(this.pending) || this.inflight !== null;
  }

  /** Unmounting must not lose edits: send what is pending (the saver keeps running until the queue is empty). */
  dispose(): void {
    void this.flush();
  }
}
