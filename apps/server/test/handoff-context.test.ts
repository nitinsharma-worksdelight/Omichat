import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchesHandoffKeyword } from '../src/modules/ai/orchestrator';
import { createOrg, createTestEnv, text, type TestEnv } from './helpers';

/** F6b: staff pick up a handoff with what they need, the right person gets it, and each reads their own alerts. */

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(env: TestEnv, org: Org, content: string, visitor = 'visitor') {
  const r = await env.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await env.c.queue.drain();
  return r;
}

async function member(t: TestEnv, org: Org, name: string, role: 'agent' | 'viewer' = 'agent') {
  return t.c.tenancy.addMember(org.orgId, { email: `${name.toLowerCase()}-${Date.now()}@example.com`, role, name, password: 'password-123' });
}

async function ownerOf(t: TestEnv, org: Org) {
  return (await t.c.tenancy.listMembers(org.orgId)).find((m) => m.role === 'owner')!;
}

describe('the handoff alert carries a brief', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it("includes the customer's own words, even on their first message", async () => {
    const org = await createOrg(t.c, 'Brief Co');
    const r = await send(t, org, 'You charged me twice, I want to talk to a human');
    await t.c.automation.dispatchPending();
    const [alert] = (await t.c.automation.listNotifications(org.scope, null)).filter((n) => n.type === 'conversation.handoff_requested');
    expect(alert!.body).toContain('Customer asked for a person');
    expect(alert!.body).toContain('Last message: “You charged me twice, I want to talk to a human”');
    const [event] = (await t.c.automation.listEvents(org.scope, {})).filter((e) => e.type === 'conversation.handoff_requested' && e.conversationId === r.conversationId);
    expect((event!.payload as { brief: { lastMessage: string } }).brief.lastMessage).toMatch(/charged me twice/);
  });
});

describe('assignment', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it("a handoff goes to the customer's owner, who is told personally", async () => {
    const org = await createOrg(t.c, 'Owner Co');
    const maya = await member(t, org, 'Maya');
    t.llm.setScript([text('Hello!')]);
    const r = await send(t, org, 'Hi there');
    const conv = await t.c.conversations.get(org.scope, r.conversationId);
    await t.c.contacts.update(org.scope, conv.contactId, { ownerUserId: maya.userId });
    await send(t, org, 'talk to a human');

    const after = await t.c.conversations.get(org.scope, r.conversationId);
    expect(after.assignee).toEqual({ id: maya.userId, name: 'Maya' });
    await t.c.automation.dispatchPending();
    const mine = await t.c.automation.listNotifications(org.scope, maya.userId);
    expect(mine.map((n) => n.type).sort()).toEqual(['conversation.assigned', 'conversation.handoff_requested']);
    // The personal note isn't shown to anyone else.
    const owner = await ownerOf(t, org);
    expect((await t.c.automation.listNotifications(org.scope, owner.userId)).map((n) => n.type)).toEqual(['conversation.handoff_requested']);
  });

  it('staff assign, filter by "mine" and "unassigned", and the assignee clears when the AI takes it back', async () => {
    const org = await createOrg(t.c, 'Assign Co');
    const owner = await ownerOf(t, org);
    const sam = await member(t, org, 'Sam');
    const viewer = await member(t, org, 'Val', 'viewer');
    const a = await send(t, org, 'talk to a human', 'a');
    const b = await send(t, org, 'talk to a human', 'b');
    expect((await t.c.conversations.get(org.scope, a.conversationId)).assignee).toBeNull();

    await t.c.conversations.assign(org.scope, a.conversationId, sam.userId, owner.userId);
    const list = (f: object, user: string | null = owner.userId) =>
      t.c.conversations.list(org.scope, { sort: 'recent', limit: 30, offset: 0, ...f }, user).then((items) => items.map((i) => i.id));
    expect(await list({ assignee: 'me' }, sam.userId)).toEqual([a.conversationId]);
    expect(await list({ assignee: 'unassigned' })).toEqual([b.conversationId]);
    await expect(t.c.conversations.assign(org.scope, a.conversationId, '00000000-0000-4000-8000-000000000000', owner.userId)).rejects.toMatchObject({ statusCode: 400 });
    void viewer;

    await t.c.conversations.setStatus(org.scope, a.conversationId, 'ai_active', { actor: 'user', actorUserId: owner.userId });
    expect((await t.c.conversations.get(org.scope, a.conversationId)).assignee).toBeNull();
  });

  it('taking over assigns it to whoever took it over, without a note to themselves', async () => {
    const org = await createOrg(t.c, 'Takeover Co');
    const owner = await ownerOf(t, org);
    t.llm.setScript([text('Hi!')]);
    const r = await send(t, org, 'Hello');
    await t.c.conversations.setStatus(org.scope, r.conversationId, 'human_active', { actor: 'user', actorUserId: owner.userId, reason: 'Taken over by staff' });
    expect((await t.c.conversations.get(org.scope, r.conversationId)).assignee?.id).toBe(owner.userId);
    await t.c.automation.dispatchPending();
    expect(await t.c.automation.listNotifications(org.scope, owner.userId)).toEqual([]);
  });

  it('"waiting longest" puts unanswered handoffs first, oldest first', async () => {
    const org = await createOrg(t.c, 'Sort Co');
    t.llm.setScript([text('Hi!')]);
    const chatting = await send(t, org, 'Hello', 'x');
    const first = await send(t, org, 'talk to a human', 'y');
    const second = await send(t, org, 'talk to a human', 'z');
    const items = await t.c.conversations.list(org.scope, { sort: 'waiting', limit: 30, offset: 0 });
    expect(items.map((i) => i.id)).toEqual([first.conversationId, second.conversationId, chatting.conversationId]);
  });
});

describe('notifications are read per member', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it("one member reading an alert doesn't mark it read for the others", async () => {
    const org = await createOrg(t.c, 'Reads Co');
    const owner = await ownerOf(t, org);
    const sam = await member(t, org, 'Sam');
    await send(t, org, 'talk to a human');
    await t.c.automation.dispatchPending();
    const [alert] = await t.c.automation.listNotifications(org.scope, owner.userId);
    await t.c.automation.markNotificationsRead(org.scope, owner.userId, [alert!.id]);

    expect((await t.c.automation.listNotifications(org.scope, owner.userId))[0]!.readAt).not.toBeNull();
    expect((await t.c.automation.listNotifications(org.scope, sam.userId))[0]!.readAt).toBeNull();
    expect(await t.c.automation.listNotifications(org.scope, owner.userId, { unreadOnly: true })).toEqual([]);
    await t.c.automation.markNotificationsRead(org.scope, sam.userId, 'all');
    expect(await t.c.automation.listNotifications(org.scope, sam.userId, { unreadOnly: true })).toEqual([]);
  });
});

describe('handoff phrases', () => {
  it('match within one message, not across two', () => {
    const keywords = ['customer service'];
    const burst = ['I am a loyal customer', 'service was slow though'];
    expect(matchesHandoffKeyword(burst.join('\n'), keywords)).toBe(true); // what the joined burst used to do
    expect(burst.some((m) => matchesHandoffKeyword(m, keywords))).toBe(false);
  });
});
