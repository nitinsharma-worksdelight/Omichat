import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { LockTimeoutError, RedisLockService } from '../src/infra/lock';
import { parseLocalStart } from '../src/modules/scheduling/availability';
import { createOrg } from '../test/helpers';
import { createIntegrationEnv, enabled, flushRedis, redisClient, type IntegrationEnv } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('booking under real concurrency (Postgres)', () => {
  let t: IntegrationEnv;
  beforeAll(async () => {
    await flushRedis();
    t = await createIntegrationEnv({ workers: false });
  });
  afterAll(async () => t?.close());

  it('never double-books when many people ask for one slot at once', async () => {
    const org = await createOrg(t.c);
    const people = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => t.c.contacts.create(org.scope, { firstName: `P${i}`, email: `p${i}-${Math.random()}@example.com` })),
    );
    const start = parseLocalStart('2026-09-30T14:00', 'America/Toronto')!;
    const results = await Promise.allSettled(
      people.map((p) => t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: p.id, start, title: 'Consult', createdBy: 'ai' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: 'slot_unavailable' });
    }
  });

  it('the database itself refuses overlapping bookings on one calendar', async () => {
    const org = await createOrg(t.c);
    const [a, b] = await Promise.all(['A', 'B'].map((n) => t.c.contacts.create(org.scope, { firstName: n })));
    const insert = (contactId: string, from: string, to: string) =>
      t.c.db.insert(schema.appointments).values({
        organizationId: org.orgId,
        calendarId: org.calendar.id,
        contactId,
        title: 'Direct insert',
        startsAt: new Date(from),
        endsAt: new Date(to),
        timezone: 'America/Toronto',
        status: 'booked',
      });
    await insert(a!.id, '2026-10-01T14:00:00Z', '2026-10-01T14:30:00Z');
    await expect(insert(b!.id, '2026-10-01T14:15:00Z', '2026-10-01T14:45:00Z')).rejects.toMatchObject({ cause: { code: '23P01' } });
  });

  it('runs tenant queries under row-level security', async () => {
    const first = await createOrg(t.c);
    const second = await createOrg(t.c);
    await t.c.contacts.create(second.scope, { firstName: 'Hidden' });
    const seen = await t.c.tenantDb.run(first.orgId, (tx) =>
      tx.execute(sql`select count(*)::int as n from contacts where organization_id = ${second.orgId}`),
    );
    expect((seen as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(0);
  });
});

describe.skipIf(!enabled)('conversation lock across processes (Redis)', () => {
  const clients: Redis[] = [];
  const service = () => {
    const client = redisClient();
    clients.push(client);
    return new RedisLockService(client, `it-lock-${process.pid}:`);
  };
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('lets one holder in at a time and renews past the TTL', async () => {
    const [one, two] = [service(), service()];
    const order: string[] = [];
    const hold = (locks: RedisLockService, name: string) =>
      locks.withLock('conv_shared', { ttlMs: 150, waitMs: 3_000 }, async () => {
        order.push(`${name}:in`);
        await sleep(400); // well past the TTL: renewal keeps it
        order.push(`${name}:out`);
      });
    await Promise.all([hold(one, 'a'), sleep(20).then(() => hold(two, 'b'))]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
  });

  it('gives up waiting after waitMs', async () => {
    const [one, two] = [service(), service()];
    const held = one.withLock('conv_busy', { ttlMs: 1_000, waitMs: 1_000 }, () => sleep(500));
    await sleep(20);
    await expect(two.withLock('conv_busy', { ttlMs: 1_000, waitMs: 100 }, async () => 'never')).rejects.toBeInstanceOf(LockTimeoutError);
    await held;
  });

  it('tells the holder when another process takes the lock', async () => {
    const locks = service();
    const thief = redisClient();
    clients.push(thief);
    const work = locks.withLock('conv_stolen', { ttlMs: 150, waitMs: 1_000 }, async (signal) => {
      await sleep(400);
      return signal.aborted;
    });
    await sleep(20);
    await thief.set(`it-lock-${process.pid}:conv_stolen`, 'someone-else', 'PX', 5_000);
    await expect(work).resolves.toBe(true);
    expect(await thief.get(`it-lock-${process.pid}:conv_stolen`)).toBe('someone-else');
  });
});
