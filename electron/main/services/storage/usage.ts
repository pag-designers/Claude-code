import type { StorageCategory, StorageUsage } from '@shared/domain';
import type { Db } from '../../db/client';
import type { NotificationService } from '../notifications';
import { categoryOf, type StorageProvider } from './provider';

const GB = 1024 ** 3;
/** $/GB-month above the free tier. R2: 0.015, B2: 0.006. */
const PRICE_PER_GB: Record<string, number> = { r2: 0.015, b2: 0.006, memory: 0 };

export const emptyBreakdown = (): Record<StorageCategory, number> => ({
  videos: 0,
  clips: 0,
  renders: 0,
  assets: 0,
  thumbs: 0,
  other: 0,
});

export async function measureUsage(provider: StorageProvider): Promise<{
  usedBytes: number;
  objectCount: number;
  breakdown: Record<StorageCategory, number>;
}> {
  const breakdown = emptyBreakdown();
  let usedBytes = 0;
  let objectCount = 0;
  for await (const o of provider.list('')) {
    if (o.key.startsWith('.clipfern/')) continue; // connection probes
    breakdown[categoryOf(o.key)] += o.size;
    usedBytes += o.size;
    objectCount++;
  }
  return { usedBytes, objectCount, breakdown };
}

export function buildUsage(args: {
  providerId: 'r2' | 'b2';
  freeTierGb: number;
  usedBytes: number;
  objectCount: number;
  breakdown: Record<StorageCategory, number>;
  updatedAt: number | null;
  error?: string | null;
}): StorageUsage {
  const limitBytes = args.freeTierGb * GB;
  const overGb = Math.max(0, (args.usedBytes - limitBytes) / GB);
  return {
    configured: true,
    provider: args.providerId,
    usedBytes: args.usedBytes,
    objectCount: args.objectCount,
    limitBytes,
    fraction: limitBytes ? args.usedBytes / limitBytes : 0,
    breakdown: args.breakdown,
    projectedMonthlyUsd: overGb * (PRICE_PER_GB[args.providerId] ?? 0.015),
    updatedAt: args.updatedAt,
    error: args.error ?? null,
  };
}

export function unconfiguredUsage(
  providerId: 'r2' | 'b2',
  freeTierGb: number,
  reason: string | null,
): StorageUsage {
  return {
    ...buildUsage({
      providerId,
      freeTierGb,
      usedBytes: 0,
      objectCount: 0,
      breakdown: emptyBreakdown(),
      updatedAt: null,
    }),
    configured: false,
    error: reason,
  };
}

/**
 * Reads real bucket usage (object list + sizes), caches it, persists a snapshot, and raises a
 * one-time notification when usage crosses 80% of the free tier (BRIEF §3).
 */
export class StorageUsageService {
  private cached: StorageUsage | null = null;
  private cachedAt = 0;
  private inflight: Promise<StorageUsage> | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      notifications: NotificationService;
      resolve: () => Promise<
        | { ok: true; provider: StorageProvider; freeTierGb: number }
        | { ok: false; reason: string; providerId: 'r2' | 'b2'; freeTierGb: number }
      >;
      onUpdate?: (u: StorageUsage) => void;
      ttlMs?: number;
    },
  ) {}

  invalidate(): void {
    this.cachedAt = 0;
  }

  async get(refresh = false): Promise<StorageUsage> {
    const ttl = this.deps.ttlMs ?? 60_000;
    if (!refresh && this.cached && Date.now() - this.cachedAt < ttl) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this.compute().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async compute(): Promise<StorageUsage> {
    const r = await this.deps.resolve();
    if (!r.ok) {
      const u = unconfiguredUsage(r.providerId, r.freeTierGb, r.reason);
      return this.publish(u);
    }
    try {
      const m = await measureUsage(r.provider);
      const providerId = r.provider.id === 'b2' ? 'b2' : 'r2';
      const u = buildUsage({ providerId, freeTierGb: r.freeTierGb, ...m, updatedAt: Date.now() });
      await this.deps.db.storageSnapshot.create({
        data: {
          provider: providerId,
          usedBytes: BigInt(m.usedBytes),
          objectCount: m.objectCount,
          breakdown: JSON.stringify(m.breakdown),
        },
      });
      await this.maybeAlert(u);
      return this.publish(u);
    } catch (e) {
      const providerId = r.provider.id === 'b2' ? 'b2' : 'r2';
      const prev = this.cached;
      const u: StorageUsage = {
        ...(prev ?? unconfiguredUsage(providerId, r.freeTierGb, null)),
        configured: true,
        error: e instanceof Error ? e.message : String(e),
      };
      return this.publish(u);
    }
  }

  private publish(u: StorageUsage): StorageUsage {
    this.cached = u;
    this.cachedAt = Date.now();
    this.deps.onUpdate?.(u);
    return u;
  }

  private async maybeAlert(u: StorageUsage): Promise<void> {
    if (u.fraction < 0.8) return;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await this.deps.db.notification.count({
      where: { kind: 'storage', createdAt: { gte: since } },
    });
    if (recent > 0) return;
    const pct = Math.round(u.fraction * 100);
    await this.deps.notifications.create({
      kind: 'storage',
      level: u.fraction >= 1 ? 'error' : 'warning',
      title: `Storage is ${pct}% full`,
      body: 'Free up space by deleting source videos you no longer need, or old unexported renders.',
      href: '/settings?section=storage',
      os: true,
    });
  }
}
