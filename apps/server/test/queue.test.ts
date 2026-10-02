import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { InlineQueueDriver } from '../src/infra/queue';
import { createLogger } from '../src/lib/logger';
import { recordEvent } from '../src/modules/automation/events';
import { createOrg, createTestEnv, type TestEnv } from './helpers';

const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

/** A handler that blocks until released, to add jobs while one is running. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  return { open, opened, started, running };
}

describe('in-process queue follows BullMQ job-id rules', () => {
  it('a job id is taken while the job waits', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 0.01 });
    const runs: string[] = [];
    q.process<string>('summary', async (data) => void runs.push(data));
    await q.add('summary', 'first', { jobId: 'same', delayMs: 100 });
    await q.add('summary', 'second', { jobId: 'same', delayMs: 100 });
    await q.drain();
    expect(runs).toEqual(['first']);
  });

  it('a job id is taken while the job runs, and free once it completed', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 0.01 });
    const runs: string[] = [];
    const g = gate();
    q.process<string>('summary', async (data) => {
      runs.push(data);
      if (data === 'first') {
        g.started();
        await g.opened;
      }
    });
    await q.add('summary', 'first', { jobId: 'same' });
    await g.running;
    await q.add('summary', 'during', { jobId: 'same' });
    g.open();
    await q.drain();
    await q.add('summary', 'after', { jobId: 'same' });
    await q.drain();
    expect(runs).toEqual(['first', 'after']);
  });

  it('a failed job keeps its id taken unless removeOnFail', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 0.01 });
    const runs: string[] = [];
    q.process<string>('summary', async (data) => {
      runs.push(data);
      if (data.startsWith('fail')) throw new Error('boom');
    });
    await q.add('summary', 'fail-kept', { jobId: 'kept', attempts: 2, backoffMs: 1 });
    await q.add('summary', 'fail-removed', { jobId: 'removed', attempts: 1, removeOnFail: true });
    await q.drain();
    await q.add('summary', 'again-kept', { jobId: 'kept' });
    await q.add('summary', 'again-removed', { jobId: 'removed' });
    await q.drain();
    expect(runs).toEqual(['fail-kept', 'fail-removed', 'fail-kept', 'again-removed']);
  });

  it('a job id is taken while the job waits to be retried', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 1 });
    const runs: string[] = [];
    q.process<string>('summary', async (data) => {
      runs.push(data);
      if (runs.length === 1) throw new Error('boom');
    });
    await q.add('summary', 'first', { jobId: 'same', attempts: 2, backoffMs: 50 });
    await new Promise((r) => setTimeout(r, 10)); // first attempt failed; the retry is waiting
    await q.add('summary', 'during-backoff', { jobId: 'same' });
    await q.drain();
    expect(runs).toEqual(['first', 'first']);
  });

  it('coalesced nudges merge while waiting and queue one more run when added during a run', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 0.01 });
    let runs = 0;
    const g = gate();
    q.process('events', async () => {
      runs++;
      if (runs === 1) {
        g.started();
        await g.opened;
      }
    });
    await q.add('events', {}, { jobId: 'dispatch', delayMs: 50, coalesce: true });
    await q.add('events', {}, { jobId: 'dispatch', delayMs: 50, coalesce: true });
    await g.running;
    await q.add('events', {}, { jobId: 'dispatch', coalesce: true });
    await q.add('events', {}, { jobId: 'dispatch', coalesce: true });
    g.open();
    await q.drain();
    expect(runs).toBe(2);
  });

  it('a failed coalesced nudge never blocks the next one', async () => {
    const q = new InlineQueueDriver(logger, { timeScale: 0.01 });
    let runs = 0;
    q.process('events', async () => {
      runs++;
      if (runs === 1) throw new Error('database blip');
    });
    await q.add('events', {}, { jobId: 'dispatch', attempts: 1, coalesce: true });
    await q.drain();
    await q.add('events', {}, { jobId: 'dispatch', attempts: 1, coalesce: true });
    await q.drain();
    expect(runs).toBe(2);
  });

  it('a coalesced job needs a job id', async () => {
    const q = new InlineQueueDriver(logger);
    await expect(q.add('events', {}, { coalesce: true })).rejects.toThrow(/jobId/);
  });
});

describe('outbox dispatch', () => {
  let t: TestEnv;
  afterEach(async () => t?.close());

  it('still dispatches events after a failed dispatch run', async () => {
    t = await createTestEnv();
    const org = await createOrg(t.c);
    await t.c.queue.drain();
    const automation = t.c.automation;
    const original = automation.dispatchPending.bind(automation);
    let calls = 0;
    automation.dispatchPending = async (limit?: number) => {
      calls++;
      if (calls === 1) throw new Error('database blip');
      return original(limit);
    };

    const eventId = await t.c.tenantDb.run(org.orgId, (tx) => recordEvent(tx, { orgId: org.orgId, type: 'task.created', actor: 'system' }));
    await automation.kick();
    await t.c.queue.drain();
    const undelivered = await t.c.db.select({ at: schema.events.dispatchedAt }).from(schema.events).where(eq(schema.events.id, eventId));
    expect(undelivered[0]!.at).toBeNull();

    // Before the fix, this nudge (and every later one, the timer's included) hit the failed job's id and did nothing.
    await automation.kick();
    await t.c.queue.drain();
    const [row] = await t.c.db.select({ at: schema.events.dispatchedAt }).from(schema.events).where(eq(schema.events.id, eventId));
    expect(row!.at).not.toBeNull();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
