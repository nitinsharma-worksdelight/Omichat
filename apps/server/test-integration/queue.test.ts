import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { BullQueueDriver } from '../src/infra/queue';
import { createLogger } from '../src/lib/logger';
import { recordEvent } from '../src/modules/automation/events';
import { createOrg } from '../test/helpers';
import { createIntegrationEnv, enabled, eventually, flushRedis, REDIS_URL, type IntegrationEnv } from './helpers';

const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A handler that blocks until released, to add jobs while one is running. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  return { open, opened, started, running };
}

describe.skipIf(!enabled)('BullMQ job ids (real Redis)', () => {
  let q: BullQueueDriver;
  beforeAll(flushRedis);
  afterEach(async () => q?.close());

  const driver = () => (q = new BullQueueDriver(REDIS_URL!, logger, `it${Math.random().toString(36).slice(2, 8)}`));

  it('a job id is taken while the job runs, and free once it completed', async () => {
    driver();
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
    await eventually(() => expect(runs).toEqual(['first']));
    await sleep(300);
    await q.add('summary', 'after', { jobId: 'same' });
    await eventually(() => expect(runs).toEqual(['first', 'after']));
  });

  it('a failed job keeps its id taken unless removeOnFail', async () => {
    driver();
    const runs: string[] = [];
    q.process<string>('summary', async (data) => {
      runs.push(data);
      if (data.startsWith('fail')) throw new Error('boom');
    });
    await q.add('summary', 'fail-kept', { jobId: 'kept', attempts: 1 });
    await q.add('summary', 'fail-removed', { jobId: 'removed', attempts: 1, removeOnFail: true });
    await eventually(() => expect(runs.sort()).toEqual(['fail-kept', 'fail-removed']));
    await sleep(300);
    await q.add('summary', 'again-kept', { jobId: 'kept' });
    await q.add('summary', 'again-removed', { jobId: 'removed' });
    await eventually(() => expect(runs).toContain('again-removed'));
    await sleep(500);
    expect(runs).not.toContain('again-kept');
  });

  it('coalesced nudges merge while waiting and queue one more run when added during a run', async () => {
    driver();
    let runs = 0;
    const g = gate();
    q.process('events', async () => {
      runs++;
      if (runs === 1) {
        g.started();
        await g.opened;
      }
    });
    await q.add('events', {}, { jobId: 'dispatch', delayMs: 300, coalesce: true });
    await q.add('events', {}, { jobId: 'dispatch', delayMs: 300, coalesce: true });
    await g.running;
    await q.add('events', {}, { jobId: 'dispatch', coalesce: true });
    await q.add('events', {}, { jobId: 'dispatch', coalesce: true });
    g.open();
    await eventually(() => expect(runs).toBe(2));
    await sleep(700);
    expect(runs).toBe(2);
  });

  it('a failed coalesced nudge never blocks the next one', async () => {
    driver();
    let runs = 0;
    q.process('events', async () => {
      runs++;
      if (runs === 1) throw new Error('database blip');
    });
    await q.add('events', {}, { jobId: 'dispatch', attempts: 1, coalesce: true });
    await eventually(() => expect(runs).toBe(1));
    await sleep(300);
    await q.add('events', {}, { jobId: 'dispatch', attempts: 1, coalesce: true });
    await eventually(() => expect(runs).toBe(2));
  });
});

describe.skipIf(!enabled)('outbox dispatch (real Postgres + Redis)', () => {
  let t: IntegrationEnv;
  beforeAll(async () => {
    await flushRedis();
    t = await createIntegrationEnv();
  });
  afterAll(async () => t?.close());

  it('still dispatches events after a failed dispatch run', async () => {
    const org = await createOrg(t.c);
    const automation = t.c.automation;
    const original = automation.dispatchPending.bind(automation);
    let calls = 0;
    automation.dispatchPending = async (limit?: number) => {
      calls++;
      if (calls === 1) throw new Error('database blip');
      return original(limit);
    };
    const dispatchedAt = async (id: string) =>
      (await t.c.db.select({ at: schema.events.dispatchedAt }).from(schema.events).where(eq(schema.events.id, id)))[0]!.at;

    const eventId = await t.c.tenantDb.run(org.orgId, (tx) => recordEvent(tx, { orgId: org.orgId, type: 'task.created', actor: 'system' }));
    await automation.kick();
    await eventually(() => expect(calls).toBe(1));
    await sleep(300);
    expect(await dispatchedAt(eventId)).toBeNull();

    // With a fixed job id the failed job stayed in Redis and every later nudge was ignored.
    await automation.kick();
    await eventually(async () => expect(await dispatchedAt(eventId)).not.toBeNull());
  });
});
