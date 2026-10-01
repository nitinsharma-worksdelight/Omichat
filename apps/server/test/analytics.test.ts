import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * F9a: reports count each thing once, in the organization's timezone, without Test chats or merged duplicates.
 * Rows are stamped by the database clock, so each test moves them to the dates it needs.
 */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(t: TestEnv, org: Org, content: string, visitor: string, opts: { isTest?: boolean } = {}) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content, ...opts });
  await t.c.queue.drain();
  return r;
}

/** Moves a conversation, its messages, runs and events to `at`. */
async function moveTo(t: TestEnv, org: Org, conversationId: string, at: string) {
  const when = new Date(at);
  await t.c.tenantDb.run(org.orgId, async (tx) => {
    await tx.update(schema.conversations).set({ createdAt: when }).where(eq(schema.conversations.id, conversationId));
    await tx.update(schema.messages).set({ createdAt: when }).where(eq(schema.messages.conversationId, conversationId));
    await tx.update(schema.aiRuns).set({ createdAt: when }).where(eq(schema.aiRuns.conversationId, conversationId));
    await tx.update(schema.events).set({ createdAt: when }).where(eq(schema.events.conversationId, conversationId));
  });
}

async function qualifiedEvent(t: TestEnv, org: Org, contactId: string, conversationId: string, at: string) {
  await t.c.tenantDb.run(org.orgId, (tx) =>
    tx.insert(schema.events).values({
      organizationId: org.orgId,
      type: 'lead.qualified',
      actor: 'ai',
      contactId,
      conversationId,
      payload: { score: 80, tier: 'hot' },
      createdAt: new Date(at),
      dispatchedAt: new Date(at),
    }),
  );
}

async function captureLead(t: TestEnv, org: Org, contactId: string, at: string) {
  await t.c.tenantDb.run(org.orgId, (tx) => tx.update(schema.contacts).set({ leadCapturedAt: new Date(at) }).where(eq(schema.contacts.id, contactId)));
}

const SEPT = { from: '2026-09-01', to: '2026-09-30' };

describe('analytics report', () => {
  let t: TestEnv;
  let org: Org;
  beforeAll(async () => {
    t = await createTestEnv({ now: new Date('2026-09-30T16:00:00Z') });
    org = await createOrg(t.c, 'Report Co'); // America/Toronto
    t.llm.setScript(Array.from({ length: 10 }, () => text('Hello!')));

    // 1 Sept 01:00 in Toronto (counts) and 31 Aug 23:00 in Toronto (doesn't), though both are 1 Sept in UTC.
    const inside = await send(t, org, 'Hi', 'a');
    await moveTo(t, org, inside.conversationId, '2026-09-01T05:00:00Z');
    const outside = await send(t, org, 'Hi', 'b');
    await moveTo(t, org, outside.conversationId, '2026-09-01T03:00:00Z');

    // A handoff on 10 Sept, and a Test chat that never counts.
    const handoff = await send(t, org, 'talk to a human', 'c');
    await moveTo(t, org, handoff.conversationId, '2026-09-10T15:00:00Z');
    const test = await send(t, org, 'talk to a human', 'tester', { isTest: true });
    await moveTo(t, org, test.conversationId, '2026-09-10T15:00:00Z');

    // Leads: one real, one merged duplicate of it (counts once), qualified twice (counts once).
    await captureLead(t, org, inside.contactId, '2026-09-02T15:00:00Z');
    await captureLead(t, org, handoff.contactId, '2026-09-11T15:00:00Z');
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.update(schema.contacts).set({ mergedIntoId: inside.contactId }).where(eq(schema.contacts.id, handoff.contactId)),
    );
    await qualifiedEvent(t, org, inside.contactId, inside.conversationId, '2026-09-03T15:00:00Z');
    await qualifiedEvent(t, org, handoff.contactId, handoff.conversationId, '2026-09-12T15:00:00Z');
    await qualifiedEvent(t, org, test.contactId, test.conversationId, '2026-09-12T15:00:00Z');
  });
  afterAll(() => t.close());

  const report = (q: object = {}, includeCost = true) => t.c.analytics.report(org.orgId, 'America/Toronto', { ...SEPT, ...q }, { includeCost });

  it("counts by the organization's days, without Test chats, merged duplicates or repeats", async () => {
    const r = await report();
    expect(r.totals).toMatchObject({ conversations: 2, leads: 1, qualified: 1, handoffs: 1 });
    // AI replies: the greeting on 1 Sept (the 31 Aug one is last month in Toronto; handoffs aren't replies).
    expect(r.totals.aiReplies).toBe(1);
    expect(r.series).toHaveLength(30);
    expect(r.series[0]).toMatchObject({ date: '2026-09-01', conversations: 1 });
    expect(r.series.find((d) => d.date === '2026-09-10')).toMatchObject({ handoffs: 1, conversations: 1 });
    expect(r.interval).toBe('day');
  });

  it('compares with the period just before', async () => {
    const r = await report();
    // 31 Aug in Toronto is in the previous 30 days.
    expect(r.previous.conversations).toBe(1);
  });

  it('filters by channel and bot', async () => {
    expect((await report({ channel: 'whatsapp' })).totals.conversations).toBe(0);
    expect((await report({ botId: org.bot.id })).totals).toMatchObject({ conversations: 2, handoffs: 1, qualified: 1 });
    expect((await report({ botId: '00000000-0000-4000-8000-000000000000' })).totals.conversations).toBe(0);
  });

  it('weeks for long ranges, refuses ranges over a year or backwards', async () => {
    expect((await report({ from: '2026-06-01', to: '2026-09-30' })).interval).toBe('week');
    await expect(report({ from: '2025-01-01', to: '2026-09-30' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(report({ from: '2026-09-30', to: '2026-09-01' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('AI cost only for admins; the Overview counts this month in Toronto', async () => {
    expect((await report({}, false)).aiCostUsd).toBeNull();
    expect((await report()).aiCostUsd).toBeGreaterThan(0);

    const viewer = await t.c.tenancy.addMember(org.orgId, { email: `viewer-${Date.now()}@example.com`, role: 'viewer', password: 'password-123' });
    const login = await t.c.auth.login({ email: viewer.email, password: 'password-123' });
    const asViewer = await t.app.inject({ method: 'GET', url: '/v1/usage', headers: authHeaders(login.token, org.orgId) });
    const usage = asViewer.json();
    expect(usage.ai).toBeNull();
    expect(usage).toMatchObject({ conversations: { total: 2, handedOff: 1 }, leads: { captured: 1, qualified: 1 } });
    const asOwner = await t.app.inject({ method: 'GET', url: '/v1/usage', headers: authHeaders(org.token, org.orgId) });
    // The budget's view: everything spent this month (Test chats included), for admins.
    expect(asOwner.json().ai.costUsd).toBeGreaterThan(0);
    expect(asOwner.json().ai.runs).toBeGreaterThanOrEqual(usage.aiReplies);

    const analytics = await t.app.inject({ method: 'GET', url: '/v1/analytics?from=2026-09-01&to=2026-09-30', headers: authHeaders(login.token, org.orgId) });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json().aiCostUsd).toBeNull();
  });

  it('the activity feed leaves out Test chats', async () => {
    const events = await t.c.automation.listEvents(org.scope, {});
    const testConversations = await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.select({ id: schema.conversations.id }).from(schema.conversations).where(sql`${schema.conversations.isTest}`),
    );
    const ids = new Set(testConversations.map((c) => c.id));
    expect(events.some((e) => e.conversationId && ids.has(e.conversationId))).toBe(false);
  });
});
