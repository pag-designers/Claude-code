import { afterEach, describe, expect, it } from 'vitest';
import type { JobView } from '@shared/domain';
import { makeServices } from './helpers';

const waitFor = async (fn: () => Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
};

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup(emit?: (j: JobView) => void) {
  const m = await makeServices({ emit: emit ? { job: emit } : {} });
  cleanups.push(m.cleanup);
  return m.svc;
}

describe('JobQueue', () => {
  it('runs a job, reports progress and stores the result', async () => {
    const seen: JobView[] = [];
    const svc = await setup((j) => seen.push(j));
    svc.queue.register('t.ok', async (ctx) => {
      await ctx.progress(0.5, 'half');
      return { answer: 42 };
    });
    await svc.queue.start();
    const job = await svc.queue.enqueue({ kind: 't.ok' });
    await waitFor(async () => (await svc.queue.get(job.id))?.status === 'succeeded');
    const done = await svc.queue.get(job.id);
    expect(done?.progress).toBe(1);
    expect(seen.some((j) => j.stage === 'half' && j.progress === 0.5)).toBe(true);
    const row = await svc.dbHandle.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(JSON.parse(row.result!)).toEqual({ answer: 42 });
  });

  it('retries with backoff then fails after maxAttempts', async () => {
    const svc = await setup();
    let calls = 0;
    svc.queue.register('t.flaky', async () => {
      calls++;
      throw new Error('boom');
    });
    await svc.queue.start();
    const job = await svc.queue.enqueue({ kind: 't.flaky', maxAttempts: 2 });
    await waitFor(async () => (await svc.queue.get(job.id))?.status === 'failed', 15000);
    expect(calls).toBe(2);
    expect((await svc.queue.get(job.id))?.error).toBe('boom');
  });

  it('survives a restart: jobs left running are re-queued and completed', async () => {
    const svc = await setup();
    const row = await svc.dbHandle.prisma.job.create({
      data: { kind: 't.resume', status: 'running', startedAt: new Date(), attempts: 1 },
    });
    let ran = false;
    svc.queue.register('t.resume', async () => {
      ran = true;
    });
    const { recovered } = await svc.queue.start();
    expect(recovered).toBe(1);
    await waitFor(async () => (await svc.queue.get(row.id))?.status === 'succeeded');
    expect(ran).toBe(true);
  });

  it('respects priority and per-kind concurrency', async () => {
    const svc = await setup();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    svc.queue.register(
      't.serial',
      async (ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(String((ctx.payload as { n: number }).n));
        await new Promise((r) => setTimeout(r, 40));
        active--;
      },
      { concurrency: 1 },
    );
    await svc.queue.enqueue({ kind: 't.serial', payload: { n: 1 }, priority: 0 });
    await svc.queue.enqueue({ kind: 't.serial', payload: { n: 2 }, priority: 10 });
    await svc.queue.enqueue({ kind: 't.serial', payload: { n: 3 }, priority: 5 });
    await svc.queue.start();
    await waitFor(async () => order.length === 3 && active === 0);
    expect(order).toEqual(['2', '3', '1']);
    expect(maxActive).toBe(1);
  });

  it('cancels a running job via its AbortSignal', async () => {
    const svc = await setup();
    let aborted = false;
    svc.queue.register('t.long', async (ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        setTimeout(resolve, 10_000);
      });
    });
    await svc.queue.start();
    const job = await svc.queue.enqueue({ kind: 't.long' });
    await waitFor(async () => (await svc.queue.get(job.id))?.status === 'running');
    await svc.queue.cancel(job.id);
    await waitFor(async () => aborted);
    expect((await svc.queue.get(job.id))?.status).toBe('canceled');
    await svc.queue.retry(job.id);
    expect(['queued', 'running']).toContain((await svc.queue.get(job.id))?.status);
  });

  it('leaves jobs of an unregistered kind queued (never claimed, never lost)', async () => {
    const svc = await setup();
    svc.queue.register('t.other', async () => {});
    await svc.queue.start();
    const job = await svc.queue.enqueue({ kind: 'nobody.handles.this', maxAttempts: 1 });
    // no handler registered for this kind, so it must not be claimed
    await new Promise((r) => setTimeout(r, 300));
    expect((await svc.queue.get(job.id))?.status).toBe('queued');
  });
});
