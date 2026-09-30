import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { createOrg, createTestEnv, text, type TestEnv } from './helpers';

/** A customer handed to the team is never left waiting in silence. */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(env: TestEnv, org: Org, content: string, visitor = 'visitor') {
  const r = await env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await env.c.queue.drain();
  return r;
}

const status = async (t: TestEnv, org: Org, id: string) => (await t.c.conversations.get(org.scope, id)).status;

/** The handoff clock runs on the database's timestamps; move it back so the test clock sees it as old. */
async function ageHandoff(t: TestEnv, org: Org, id: string, minutes: number) {
  await t.c.tenantDb.run(org.orgId, (tx) =>
    tx
      .update(schema.conversations)
      .set({ handedOffAt: new Date(t.now.value.getTime() - minutes * 60_000) })
      .where(eq(schema.conversations.id, id)),
  );
}

async function eventsOf(t: TestEnv, org: Org, type: string) {
  return (await t.c.automation.listEvents(org.scope, {})).filter((e) => e.type === type);
}

describe('waiting past the limit', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  async function handedOff(name: string, handoff: Record<string, unknown>) {
    const org = await createOrg(t.c, name);
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, ...handoff } } });
    const r = await send(t, org, 'I want to talk to a human');
    expect(await status(t, org, r.conversationId)).toBe('human_active');
    return { org, id: r.conversationId };
  }

  it('does nothing when the limit is off (the default)', async () => {
    const { org, id } = await handedOff('Off Co', {});
    await ageHandoff(t, org, id, 600);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(0);
    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(0);
  });

  it('alerts the team once and leaves the chat with them (keep waiting)', async () => {
    const { org, id } = await handedOff('Wait Co', { waitMinutes: 15 });
    await ageHandoff(t, org, id, 10);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(0);
    await ageHandoff(t, org, id, 16);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(1);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(0);

    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(1);
    expect(await status(t, org, id)).toBe('human_active');
    await t.c.automation.dispatchPending();
    const alerts = (await t.c.automation.listNotifications(org.scope, null)).filter((n) => n.type === 'conversation.handoff_overdue');
    expect(alerts.map((n) => n.link)).toEqual([`/conversations/${id}`]);
  });

  it('a staff reply stops the clock', async () => {
    const { org, id } = await handedOff('Reply Co', { waitMinutes: 15 });
    const [user] = await t.c.db.select().from(schema.users).limit(1);
    await t.c.conversations.humanReply(org.scope, id, user!.id, 'Hi, this is Sam.');
    await ageHandoff(t, org, id, 60);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(0);
  });

  it('"take back" tells the customer and returns the chat to the assistant', async () => {
    const { org, id } = await handedOff('Resume Co', { waitMinutes: 15, fallback: 'ask_contact_details' });
    await ageHandoff(t, org, id, 20);
    await t.c.handoffWatcher.escalateOverdue();
    expect(await status(t, org, id)).toBe('ai_active');
    const thread = await t.c.conversations.messages(org.scope, id, {});
    expect(thread.at(-1)?.content).toMatch(/email or phone/);

    // The assistant answers the customer's next message again.
    t.llm.setScript([text('Happy to help.')]);
    await send(t, org, 'Still there?');
    expect((await t.c.conversations.messages(org.scope, id, {})).at(-1)?.content).toBe('Happy to help.');
  });

  it('a handoff after a resume starts a new clock', async () => {
    const { org, id } = await handedOff('Again Co', { waitMinutes: 15, fallback: 'resume_ai' });
    await ageHandoff(t, org, id, 20);
    await t.c.handoffWatcher.escalateOverdue();
    await send(t, org, 'I really want a real person');
    expect(await status(t, org, id)).toBe('human_active');
    await ageHandoff(t, org, id, 20);
    expect(await t.c.handoffWatcher.escalateOverdue()).toBe(1);
    expect(await eventsOf(t, org, 'conversation.handoff_overdue')).toHaveLength(2);
  });
});

describe('team hours', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv(); // Monday 09:00 in Toronto (the org's timezone)
  });
  afterAll(() => t.close());

  const away = 'We are away until later.';
  async function lastMessage(org: Org, id: string) {
    return (await t.c.conversations.messages(org.scope, id, {})).at(-1)?.content;
  }

  it('says the team is away outside its hours, and gives the normal message inside them', async () => {
    const org = await createOrg(t.c, 'Hours Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, respectTeamHours: true, awayMessage: away, message: 'Connecting you.' } } });
    await t.c.tenancy.updateOrganization(org.orgId, { settings: { teamHours: { enabled: true, weekly: { mon: [{ start: '13:00', end: '17:00' }] } } } });

    const closed = await send(t, org, 'talk to a human', 'v1');
    expect(await lastMessage(org, closed.conversationId)).toBe(away);

    t.now.value = new Date('2026-09-28T18:00:00Z'); // 14:00 in Toronto
    const open = await send(t, org, 'talk to a human', 'v2');
    expect(await lastMessage(org, open.conversationId)).toBe('Connecting you.');
    t.now.value = new Date('2026-09-28T13:00:00Z');
  });

  it('is ignored when the bot does not ask for it, or the organization set no hours', async () => {
    const org = await createOrg(t.c, 'No Hours Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: true, respectTeamHours: true, awayMessage: away, message: 'Connecting you.' } } });
    const r = await send(t, org, 'talk to a human');
    expect(await lastMessage(org, r.conversationId)).toBe('Connecting you.');
  });
});

describe('guards', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('the reply cap does not hand off when handoff is switched off', async () => {
    const org = await createOrg(t.c, 'Cap Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { handoff: { enabled: false }, guardrails: { maxAiRepliesPerConversation: 1 } } });
    t.llm.setScript([text('One.'), text('Two.')]);
    const first = await send(t, org, 'Hello');
    await send(t, org, 'And another question');
    expect(await status(t, org, first.conversationId)).toBe('ai_active');
    expect((await t.c.conversations.messages(org.scope, first.conversationId, {})).at(-1)?.content).toBe('Two.');
  });

  it('staff are told once an hour when customers write and nobody can answer', async () => {
    const org = await createOrg(t.c, 'Silent Co');
    await t.c.tenancy.updateOrganization(org.orgId, { aiEnabled: false });
    await send(t, org, 'Hello?', 'a');
    await send(t, org, 'Anyone there?', 'b');
    expect(await eventsOf(t, org, 'conversation.unanswered')).toHaveLength(1);
    await t.c.automation.dispatchPending();
    const alerts = (await t.c.automation.listNotifications(org.scope, null)).filter((n) => n.type === 'conversation.unanswered');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toMatch(/switched off/);
  });

  it('a closed chat cannot be reopened beside a newer open one', async () => {
    const org = await createOrg(t.c, 'Reopen Co');
    t.llm.setScript([text('Hi.')]);
    const old = await send(t, org, 'Hello', 'same');
    await t.c.conversations.setStatus(org.scope, old.conversationId, 'closed', { actor: 'system' });
    t.llm.setScript([text('Hi again.')]);
    const fresh = await send(t, org, 'Hello again', 'same');
    expect(fresh.conversationId).not.toBe(old.conversationId);
    await expect(t.c.conversations.setStatus(org.scope, old.conversationId, 'ai_active', { actor: 'user' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
