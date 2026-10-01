import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/** F9b: how fast the team answers handoffs, who does the work, where leads come from, what the AI did, and CSV export. */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(t: TestEnv, org: Org, content: string, visitor: string) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

const at = (iso: string, plusMinutes = 0) => new Date(new Date(iso).getTime() + plusMinutes * 60_000);

/** Puts every event and message of a conversation at `start`, then (optionally) one staff reply `replyAfter` minutes later. */
async function stage(t: TestEnv, org: Org, conversationId: string, start: string, reply?: { userId: string; after: number }) {
  await t.c.tenantDb.run(org.orgId, async (tx) => {
    await tx.update(schema.conversations).set({ createdAt: at(start) }).where(eq(schema.conversations.id, conversationId));
    await tx.update(schema.events).set({ createdAt: at(start) }).where(eq(schema.events.conversationId, conversationId));
    await tx.update(schema.messages).set({ createdAt: at(start) }).where(eq(schema.messages.conversationId, conversationId));
    await tx.update(schema.aiRuns).set({ createdAt: at(start) }).where(eq(schema.aiRuns.conversationId, conversationId));
    await tx.update(schema.toolInvocations).set({ createdAt: at(start) }).where(eq(schema.toolInvocations.conversationId, conversationId));
  });
  if (reply) {
    const m = await t.c.conversations.humanReply(org.scope, conversationId, reply.userId, 'Hi, this is the team.');
    await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.update(schema.messages).set({ createdAt: at(start, reply.after) }).where(eq(schema.messages.id, m.id)),
    );
  }
}

async function lead(t: TestEnv, org: Org, contactId: string, firstTouch: Record<string, string> | null) {
  await t.c.tenantDb.run(org.orgId, (tx) =>
    tx
      .update(schema.contacts)
      .set({ leadCapturedAt: at('2026-09-15T15:00:00Z'), firstTouch: firstTouch ?? undefined })
      .where(eq(schema.contacts.id, contactId)),
  );
}

const SEPT = { from: '2026-09-01', to: '2026-09-30' };

describe('analytics performance', () => {
  let t: TestEnv;
  let org: Org;
  let owner: { userId: string };
  let sam: { userId: string };
  beforeAll(async () => {
    t = await createTestEnv({ now: new Date('2026-09-30T16:00:00Z') });
    org = await createOrg(t.c, 'Perf Co');
    owner = (await t.c.tenancy.listMembers(org.orgId)).find((m) => m.role === 'owner')!;
    sam = await t.c.tenancy.addMember(org.orgId, { email: `sam-${Date.now()}@example.com`, role: 'agent', name: 'Sam', password: 'password-123' });

    // Three AI handoffs: answered after 10 and 30 minutes, and one never answered; plus a staff takeover.
    const a = await send(t, org, 'talk to a human', 'a');
    await stage(t, org, a.conversationId, '2026-09-10T15:00:00Z', { userId: sam.userId, after: 10 });
    const b = await send(t, org, 'talk to a human', 'b');
    await stage(t, org, b.conversationId, '2026-09-11T15:00:00Z', { userId: owner.userId, after: 30 });
    const cc = await send(t, org, 'talk to a human', 'c');
    await stage(t, org, cc.conversationId, '2026-09-12T15:00:00Z');
    t.llm.setScript([tools({ name: 'add_note', input: { note: 'Prefers mornings' } }), text('Noted!')]);
    const d = await send(t, org, 'I prefer mornings', 'd');
    await t.c.conversations.setStatus(org.scope, d.conversationId, 'human_active', { actor: 'user', actorUserId: owner.userId, reason: '=HYPERLINK("x")' });
    await stage(t, org, d.conversationId, '2026-09-13T15:00:00Z');

    await lead(t, org, a.contactId, { utmSource: 'Newsletter', utmCampaign: 'fall' });
    await lead(t, org, b.contactId, { gclid: 'abc' });
    await lead(t, org, cc.contactId, { referrer: 'https://www.example.org/blog' });
    await lead(t, org, d.contactId, null);
  });
  afterAll(() => t.close());

  const perf = (q: object = {}, includeCost = true) => t.c.analytics.performance(org.orgId, 'America/Toronto', { ...SEPT, ...q }, { includeCost });

  it('times the first reply to AI handoffs; takeovers count apart', async () => {
    const p = await perf();
    expect(p.handoffs).toMatchObject({ total: 4, byAi: 3, takenOverByStaff: 1, answered: 2, unanswered: 1 });
    expect(p.handoffs.firstReplySeconds).toEqual({ median: 1200, p90: 1680 });
    expect(p.handoffs.reasons[0]).toEqual({ reason: 'Customer asked for a person', count: 3 });
    expect(p.handoffRate).toBe(1);
  });

  it("each member's replies and median first reply", async () => {
    const p = await perf();
    const samRow = p.team.find((m) => m.userId === sam.userId)!;
    expect(samRow).toMatchObject({ name: 'Sam', replies: 1, conversations: 1, firstReplyMedianSeconds: 600 });
    const ownerRow = p.team.find((m) => m.userId === owner.userId)!;
    expect(ownerRow).toMatchObject({ replies: 1, firstReplyMedianSeconds: 1800 });
  });

  it('lead sources, the funnel and what the AI did', async () => {
    const p = await perf();
    expect(p.sources.map((s) => s.source).sort()).toEqual(['direct', 'example.org', 'google ads', 'newsletter']);
    expect(p.sources.find((s) => s.source === 'newsletter')?.campaign).toBe('fall');
    expect(p.funnel.map((s) => s.count)).toEqual([4, 4, 0, 0, 0]);
    expect(p.actions).toEqual([{ tool: 'add_note', calls: 1, failed: 0, askedTeam: 0 }]);
    expect(p.approvals).toEqual({ approved: 0, declined: 0, waiting: 0, expired: 0 });
    expect((await perf({}, false)).cost).toBeNull();
    expect((await perf()).cost?.perConversationUsd).toBeGreaterThan(0);
  });

  it('CSV export is for admins and safe to open in a spreadsheet', async () => {
    const url = '/v1/analytics/export?report=handoffs&from=2026-09-01&to=2026-09-30';
    const res = await t.app.inject({ method: 'GET', url, headers: authHeaders(org.token, org.orgId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('handoffs-2026-09-01-to-2026-09-30.csv');
    expect(res.body.split('\r\n')[0]).toBe('reason,handoffs');
    // A reason starting with "=" is never read as a formula.
    expect(res.body).toContain(`"'=HYPERLINK(""x"")",1`);

    const login = await t.c.auth.login({ email: (await t.c.tenancy.listMembers(org.orgId)).find((m) => m.userId === sam.userId)!.email, password: 'password-123' });
    const asAgent = await t.app.inject({ method: 'GET', url, headers: authHeaders(login.token, org.orgId) });
    expect(asAgent.statusCode).toBe(403);
    const daily = await t.app.inject({ method: 'GET', url: '/v1/analytics/export?report=daily&from=2026-09-01&to=2026-09-03', headers: authHeaders(org.token, org.orgId) });
    expect(daily.body.trim().split('\r\n')).toHaveLength(4);
  });

  it('staff can read the performance report', async () => {
    const login = await t.c.auth.login({ email: (await t.c.tenancy.listMembers(org.orgId)).find((m) => m.userId === sam.userId)!.email, password: 'password-123' });
    const res = await t.app.inject({ method: 'GET', url: '/v1/analytics/performance?from=2026-09-01&to=2026-09-30', headers: authHeaders(login.token, org.orgId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().cost).toBeNull();
  });
});
