import type { AppNotification } from '@shared/domain';
import type { SchedulerStatus } from '@shared/publish';
import type { Settings } from '@shared/settings';
import type { Db } from '../db/client';
import type { PostingService } from './posting';

const TICK_MS = 10_000;
const KEY_PAUSED = 'internal.schedulerPaused';
const KEY_DIGEST_DAY = 'internal.digestDay';

export interface SchedulerDeps {
  db: Db;
  posting: Pick<PostingService, 'dispatchDue' | 'counts' | 'quotas' | 'todaysPosts' | 'sweepCache'>;
  getSettings(): Promise<Settings>;
  notify(n: {
    kind: AppNotification['kind'];
    level: AppNotification['level'];
    title: string;
    body?: string | null;
    href?: string | null;
    os?: boolean;
  }): Promise<unknown>;
  /** True when the OS offers a tray / menu bar icon (Linux desktops without an indicator may not). */
  trayAvailable(): boolean;
  emitStatus(s: SchedulerStatus): void;
  now?: () => number;
  timeZone?: () => string;
  tickMs?: number;
  log: (m: string) => void;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The local durable scheduler (BRIEF §9): a tick loop in the Electron main process that hands due posts to the publish
 * job (posting.ts). Posts live in the database, so a restart loses nothing: the first tick after start is the
 * catch-up pass (late but within the grace window → published, older → "missed — reschedule?").
 *
 * Serverless-worker interface (ADR-021): `dispatchDue` is the only coupling. A hosted worker would run the same
 * query against a shared database/queue and call the same publish routine with the stored tokens; nothing else
 * in this class depends on Electron.
 */
export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private paused = false;
  private lastStatus: SchedulerStatus | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private catchUp = { pending: 0, lastRunAt: null as number | null };

  constructor(private readonly d: SchedulerDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private tz(): string {
    return this.d.timeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private async readSetting<T>(key: string, fallback: T): Promise<T> {
    const r = await this.d.db.setting.findUnique({ where: { key } });
    if (!r) return fallback;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return fallback;
    }
  }

  private async writeSetting(key: string, value: unknown): Promise<void> {
    const v = JSON.stringify(value);
    await this.d.db.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.paused = await this.readSetting<boolean>(KEY_PAUSED, false);
    this.d.posting.sweepCache();
    await this.runCatchUp();
    this.timer = setInterval(() => void this.track(this.tick()), this.d.tickMs ?? TICK_MS);
    this.timer.unref?.();
    await this.publishStatus();
  }

  /** Stops the loop and waits for work in flight, so nothing touches the database after the caller closes it. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inflight]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.then(
      () => this.inflight.delete(p),
      () => this.inflight.delete(p),
    );
    return p;
  }

  /** First pass after launch: handles everything that came due while the app was closed. */
  private async runCatchUp(): Promise<void> {
    if (this.paused) return;
    const s = await this.d.getSettings();
    const graceMs = s.schedulerGraceMinutes * 60_000;
    const res = await this.d.posting.dispatchDue({ graceMs });
    this.catchUp = { pending: res.queued.length, lastRunAt: this.now() };
    if (res.queued.length || res.missed.length) {
      this.d.log(`catch-up: ${res.queued.length} resumed, ${res.missed.length} missed`);
      const parts = [
        res.queued.length ? `${res.queued.length} late post${res.queued.length === 1 ? '' : 's'} are being published now` : null,
        res.missed.length
          ? `${res.missed.length} missed the ${s.schedulerGraceMinutes}-minute grace window and need a new time`
          : null,
      ].filter(Boolean);
      await this.d.notify({
        kind: 'post',
        level: res.missed.length ? 'warning' : 'info',
        title: 'Clipfern caught up on scheduled posts',
        body: `${parts.join('; ')}.`,
        href: '/scheduler/',
        os: true,
      });
    }
  }

  async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      if (!this.paused) {
        const s = await this.d.getSettings();
        const res = await this.d.posting.dispatchDue({ graceMs: s.schedulerGraceMinutes * 60_000 });
        if (res.missed.length)
          await this.d.notify({
            kind: 'post',
            level: 'warning',
            title: `${res.missed.length} scheduled post${res.missed.length === 1 ? ' was' : 's were'} missed`,
            body: 'Your computer was asleep or Clipfern was paused at the scheduled time. Open the Scheduler to reschedule.',
            href: '/scheduler/',
            os: true,
          });
        if (this.catchUp.pending > 0 && res.queued.length === 0) this.catchUp.pending = 0;
        await this.maybeDigest(s, false);
      }
      await this.publishStatus();
    } catch (e) {
      this.d.log(`scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  async setPaused(paused: boolean): Promise<SchedulerStatus> {
    this.paused = paused;
    await this.writeSetting(KEY_PAUSED, paused);
    if (!paused) void this.track(this.tick());
    return this.publishStatus(true);
  }

  async status(): Promise<SchedulerStatus> {
    return this.buildStatus();
  }

  private async buildStatus(): Promise<SchedulerStatus> {
    const [s, c, quota] = await Promise.all([
      this.d.getSettings(),
      this.d.posting.counts(),
      this.d.posting.quotas(),
    ]);
    return {
      active: this.running,
      paused: this.paused,
      trayMode: s.schedulerTrayMode,
      trayAvailable: this.d.trayAvailable(),
      upcoming: c.upcoming,
      nextAt: c.nextAt,
      publishing: c.publishing,
      catchUp: { pending: this.catchUp.pending, lastRunAt: this.catchUp.lastRunAt },
      quota,
      now: this.now(),
    };
  }

  private async publishStatus(force = false): Promise<SchedulerStatus> {
    const st = await this.buildStatus();
    const { now: _a, ...cmpNew } = st;
    const { now: _b, ...cmpOld } = this.lastStatus ?? st;
    void _a;
    void _b;
    if (force || !this.lastStatus || !sameJson(cmpNew, cmpOld)) {
      this.lastStatus = st;
      this.d.emitStatus(st);
    }
    return st;
  }

  /* ---------------------------------------------------------------------------------- digest ---- */

  private localDay(at: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(at));
  }

  private localHour(at: number): number {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: this.tz(), hourCycle: 'h23', hour: '2-digit' })
        .formatToParts(new Date(at))
        .find((p) => p.type === 'hour')?.value ?? '0',
    );
  }

  private async maybeDigest(s: Settings, force: boolean): Promise<boolean> {
    const now = this.now();
    const today = this.localDay(now);
    if (!force) {
      if (!s.digestEnabled || this.localHour(now) < s.digestHour) return false;
      if ((await this.readSetting<string | null>(KEY_DIGEST_DAY, null)) === today) return false;
    }
    // [local midnight, next local midnight)
    let start = now;
    while (this.localDay(start - 15 * 60_000) === today) start -= 15 * 60_000;
    let end = now;
    while (this.localDay(end) === today) end += 15 * 60_000;
    const [todays, issues, accounts] = await Promise.all([
      this.d.posting.todaysPosts(start, end),
      this.d.db.post.count({
        where: { status: { in: ['failed', 'missed'] }, updatedAt: { gte: new Date(now - 24 * 3_600_000) } },
      }),
      this.d.db.socialAccount.count({ where: { status: { not: 'connected' } } }),
    ]);
    if (!force && todays.length === 0 && issues === 0 && accounts === 0) {
      await this.writeSetting(KEY_DIGEST_DAY, today); // nothing to say; do not look again today
      return false;
    }
    const fmt = new Intl.DateTimeFormat(undefined, {
      timeZone: this.tz(),
      hour: 'numeric',
      minute: '2-digit',
    });
    const times = todays
      .slice(0, 4)
      .map((p) => fmt.format(p.scheduledAt ?? new Date(now)))
      .join(', ');
    const lines = [
      todays.length
        ? `${todays.length} post${todays.length === 1 ? '' : 's'} scheduled today (${times}${todays.length > 4 ? ', …' : ''}).`
        : 'Nothing is scheduled for today.',
      issues ? `${issues} post${issues === 1 ? '' : 's'} failed or were missed in the last 24 hours.` : null,
      accounts ? `${accounts} account${accounts === 1 ? ' needs' : 's need'} reconnecting.` : null,
    ].filter(Boolean);
    await this.d.notify({
      kind: 'post',
      level: issues || accounts ? 'warning' : 'info',
      title: 'Your posting day',
      body: lines.join(' '),
      href: '/scheduler/',
      os: true,
    });
    await this.writeSetting(KEY_DIGEST_DAY, today);
    return true;
  }

  async digestNow(): Promise<{ sent: boolean }> {
    return { sent: await this.maybeDigest(await this.d.getSettings(), true) };
  }
}
