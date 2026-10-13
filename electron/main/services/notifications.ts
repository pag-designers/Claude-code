import {
  notificationInputSchema,
  type AppNotification,
  type NotificationInput,
} from '@shared/domain';
import type { Db } from '../db/client';

type Row = {
  id: string;
  kind: string;
  level: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export function toNotification(r: Row): AppNotification {
  return {
    id: r.id,
    kind: r.kind as AppNotification['kind'],
    level: r.level as AppNotification['level'],
    title: r.title,
    body: r.body,
    href: r.href,
    createdAt: r.createdAt.getTime(),
    readAt: r.readAt ? r.readAt.getTime() : null,
  };
}

export interface NotificationHooks {
  /** Push to the renderer. */
  onCreated?: (n: AppNotification) => void;
  /** Raise an OS notification (Electron `Notification`). */
  osNotify?: (n: AppNotification) => void;
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly hooks: NotificationHooks = {},
  ) {}

  async create(input: NotificationInput): Promise<AppNotification> {
    const parsed = notificationInputSchema.parse(input);
    const row = await this.db.notification.create({
      data: {
        kind: parsed.kind,
        level: parsed.level,
        title: parsed.title,
        body: parsed.body ?? null,
        href: parsed.href ?? null,
      },
    });
    const n = toNotification(row);
    this.hooks.onCreated?.(n);
    if (parsed.os) this.hooks.osNotify?.(n);
    return n;
  }

  async list(limit = 50): Promise<{ items: AppNotification[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.db.notification.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
      this.db.notification.count({ where: { readAt: null } }),
    ]);
    return { items: rows.map(toNotification), unread };
  }

  async markRead(ids: string[]): Promise<void> {
    await this.db.notification.updateMany({
      where: { id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(): Promise<void> {
    await this.db.notification.updateMany({
      where: { readAt: null },
      data: { readAt: new Date() },
    });
  }

  async clear(): Promise<void> {
    await this.db.notification.deleteMany();
  }
}
