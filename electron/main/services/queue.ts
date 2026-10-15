import type { JobView } from '@shared/domain';
import type { Db } from '../db/client';
import { isDbFault } from '../db/faults';

type JobRow = Awaited<ReturnType<Db['job']['findFirstOrThrow']>>;

export function toJobView(r: JobRow): JobView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status as JobView['status'],
    progress: r.progress,
    stage: r.stage,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    error: r.error,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    startedAt: r.startedAt ? r.startedAt.getTime() : null,
    finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
  };
}

export interface JobContext<P = unknown> {
  job: JobView;
  payload: P;
  /** Aborted when the job is canceled or the queue stops. Handlers must honour it. */
  signal: AbortSignal;
  /** Report progress 0..1 and optionally the current stage label. */
  progress(value: number, stage?: string): Promise<void>;
}

export type JobHandler<P = unknown, R = unknown> = (ctx: JobContext<P>) => Promise<R>;

export interface HandlerOptions {
  /** Max simultaneous jobs of this kind (default: global concurrency). */
  concurrency?: number;
  maxAttempts?: number;
}

export interface EnqueueInput {
  kind: string;
  payload?: unknown;
  priority?: number;
  groupKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface QueueOptions {
  concurrency: () => number;
  onUpdate?: (job: JobView) => void;
  log?: (msg: string) => void;
  pollMs?: number;
  /** Backoff base in ms for retry n: base * 2^(n-1). */
  backoffBaseMs?: number;
  /** Called when a poll fails with a database fault (I/O error, corruption): the host may reopen the connection. */
  onFault?: (e: unknown) => void | Promise<void>;
}

/**
 * Durable job queue on the Job table (ADR-005). Survives restarts: on `start()` every job left
 * in `running` is re-queued, so handlers must be idempotent / stage-resumable.
 */
export class JobQueue {
  private handlers = new Map<string, { fn: JobHandler; opts: HandlerOptions }>();
  private running = new Map<string, AbortController>();
  private inflight = new Set<Promise<void>>();
  private tickPromise: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private failStreak = 0;
  private rekick = false;

  constructor(
    private readonly db: Db,
    private readonly opts: QueueOptions,
  ) {}

  register<P = unknown, R = unknown>(
    kind: string,
    fn: JobHandler<P, R>,
    opts: HandlerOptions = {},
  ): void {
    this.handlers.set(kind, { fn: fn as JobHandler, opts });
  }

  async enqueue(input: EnqueueInput): Promise<JobView> {
    const handler = this.handlers.get(input.kind);
    const row = await this.db.job.create({
      data: {
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
        priority: input.priority ?? 0,
        groupKey: input.groupKey ?? null,
        maxAttempts: input.maxAttempts ?? handler?.opts.maxAttempts ?? 3,
        runAfter: input.runAfter ?? new Date(),
      },
    });
    const view = toJobView(row);
    this.opts.onUpdate?.(view);
    this.kick();
    return view;
  }

  async start(): Promise<{ recovered: number }> {
    const res = await this.db.job.updateMany({
      where: { status: 'running' },
      data: { status: 'queued', startedAt: null, stage: 'recovered after restart' },
    });
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.opts.pollMs ?? 1500);
    this.timer.unref?.();
    this.kick();
    return { recovered: res.count };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.running.values()) c.abort(new Error('queue stopped'));
    // Let in-flight work settle so nothing touches the DB after the caller closes it.
    await this.tickPromise.catch(() => {});
    await Promise.allSettled([...this.inflight]);
  }

  kick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.rekick = true;
      return;
    }
    this.ticking = true;
    this.tickPromise = this.tick()
      .then(() => {
        this.failStreak = 0;
      })
      .catch((e) => {
        this.failStreak += 1;
        // A broken database would otherwise log every 1.5 s forever: the first failure, then one line a minute.
        if (this.failStreak === 1 || this.failStreak % 40 === 0)
          this.opts.log?.(
            `queue tick failed${this.failStreak > 1 ? ` (${this.failStreak} in a row)` : ''}: ${String(e)}`,
          );
        if (isDbFault(e)) void Promise.resolve(this.opts.onFault?.(e)).catch(() => {});
      })
      .finally(() => {
        this.ticking = false;
        if (this.rekick) {
          this.rekick = false;
          this.kick();
        }
      });
  }

  private async tick(): Promise<void> {
    const limit = Math.max(1, this.opts.concurrency());
    while (!this.stopped && this.running.size < limit) {
      const claimed = await this.claimNext();
      if (!claimed) break;
      const p: Promise<void> = this.execute(claimed).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  private async claimNext(): Promise<JobRow | null> {
    const perKind = new Map<string, number>();
    for (const id of this.running.keys()) {
      const k = this.kindOf.get(id);
      if (k) perKind.set(k, (perKind.get(k) ?? 0) + 1);
    }
    const blockedKinds = [...this.handlers.entries()]
      .filter(
        ([kind, h]) =>
          h.opts.concurrency !== undefined && (perKind.get(kind) ?? 0) >= h.opts.concurrency,
      )
      .map(([kind]) => kind);
    const runnableKinds = [...this.handlers.keys()].filter((k) => !blockedKinds.includes(k));
    if (runnableKinds.length === 0) return null;

    const candidates = await this.db.job.findMany({
      where: { status: 'queued', runAfter: { lte: new Date() }, kind: { in: runnableKinds } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 5,
    });
    for (const c of candidates) {
      const res = await this.db.job.updateMany({
        where: { id: c.id, status: 'queued' },
        data: {
          status: 'running',
          startedAt: new Date(),
          heartbeatAt: new Date(),
          attempts: { increment: 1 },
          error: null,
          progress: 0,
        },
      });
      if (res.count === 1) {
        const fresh = await this.db.job.findUniqueOrThrow({ where: { id: c.id } });
        this.kindOf.set(fresh.id, fresh.kind);
        return fresh;
      }
    }
    return null;
  }

  private kindOf = new Map<string, string>();

  private async execute(row: JobRow): Promise<void> {
    const handler = this.handlers.get(row.kind);
    const ac = new AbortController();
    this.running.set(row.id, ac);
    this.emit(row);
    try {
      if (!handler) throw new Error(`No handler registered for job kind "${row.kind}"`);
      const ctx: JobContext = {
        job: toJobView(row),
        payload: JSON.parse(row.payload) as unknown,
        signal: ac.signal,
        progress: async (value, stage) => {
          const updated = await this.db.job.update({
            where: { id: row.id },
            data: {
              progress: Math.min(1, Math.max(0, value)),
              ...(stage !== undefined ? { stage } : {}),
              heartbeatAt: new Date(),
            },
          });
          this.emit(updated);
        },
      };
      const result = await handler.fn(ctx);
      const current = await this.db.job.findUnique({ where: { id: row.id } });
      if (current?.status === 'canceled') return;
      const done = await this.db.job.update({
        where: { id: row.id },
        data: {
          status: 'succeeded',
          progress: 1,
          result: result === undefined ? null : JSON.stringify(result),
          finishedAt: new Date(),
          error: null,
        },
      });
      this.emit(done);
    } catch (err) {
      const current = await this.db.job.findUnique({ where: { id: row.id } });
      if (!current || current.status === 'canceled') return;
      if (this.stopped && ac.signal.aborted) {
        // App shutting down: leave it re-queueable for next launch.
        await this.db.job.update({
          where: { id: row.id },
          data: { status: 'queued', startedAt: null },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const willRetry = current.attempts < current.maxAttempts;
      const backoff = (this.opts.backoffBaseMs ?? 2000) * 2 ** (current.attempts - 1);
      const updated = await this.db.job.update({
        where: { id: row.id },
        data: willRetry
          ? {
              status: 'queued',
              error: message,
              runAfter: new Date(Date.now() + backoff),
              startedAt: null,
            }
          : { status: 'failed', error: message, finishedAt: new Date() },
      });
      this.opts.log?.(
        `job ${row.kind}/${row.id} ${willRetry ? 'will retry' : 'failed'}: ${message}`,
      );
      this.emit(updated);
    } finally {
      this.running.delete(row.id);
      this.kindOf.delete(row.id);
      this.kick();
    }
  }

  private emit(row: JobRow): void {
    this.opts.onUpdate?.(toJobView(row));
  }

  async cancel(id: string): Promise<void> {
    const row = await this.db.job.findUnique({ where: { id } });
    if (!row || ['succeeded', 'failed', 'canceled'].includes(row.status)) return;
    const updated = await this.db.job.update({
      where: { id },
      data: { status: 'canceled', finishedAt: new Date() },
    });
    this.running.get(id)?.abort(new Error('canceled'));
    this.emit(updated);
  }

  async retry(id: string): Promise<void> {
    const row = await this.db.job.findUnique({ where: { id } });
    if (!row || !['failed', 'canceled'].includes(row.status)) return;
    const updated = await this.db.job.update({
      where: { id },
      data: {
        status: 'queued',
        attempts: 0,
        error: null,
        progress: 0,
        runAfter: new Date(),
        finishedAt: null,
        startedAt: null,
      },
    });
    this.emit(updated);
    this.kick();
  }

  async list(limit = 50): Promise<JobView[]> {
    const rows = await this.db.job.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map(toJobView);
  }

  async get(id: string): Promise<JobView | null> {
    const row = await this.db.job.findUnique({ where: { id } });
    return row ? toJobView(row) : null;
  }
}
