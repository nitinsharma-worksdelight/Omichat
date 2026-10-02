import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announcesHandoff, headerLine } from '../../widget/src/handoff';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

/**
 * Q5 — handoff gaps: the visitor sees they're waiting for a person, whoever answers a chat nobody looks after gets it,
 * and staff can reopen a closed chat without it counting as a handoff.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

type Org = Awaited<ReturnType<typeof createOrg>>;

async function send(org: Org, content: string, visitor = 'visitor') {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}
async function member(org: Org, name: string, role: 'agent' | 'viewer' = 'agent') {
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`;
  const m = await t.c.tenancy.addMember(org.orgId, { email, role, name, password: 'password-123' });
  return { ...m, token: (await t.c.auth.login({ email, password: 'password-123' })).token };
}
const eventsOf = async (org: Org, conversationId: string, type: string) =>
  t.c.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.organizationId, org.orgId), eq(schema.events.conversationId, conversationId), eq(schema.events.type, type)));
const statusCall = (token: string, orgId: string, id: string, action: string) =>
  t.app.inject({ method: 'POST', url: `/v1/conversations/${id}/status`, headers: authHeaders(token, orgId), payload: { action } });

describe('whoever replies gets the chat (BUG-13.2)', () => {
  it('after an AI handoff nobody looks after, a staff reply assigns the replier, without a note to themselves', async () => {
    const org = await createOrg(t.c, 'Reply Assign Co');
    const sam = await member(org, 'Sam');
    const r = await send(org, 'talk to a human');
    expect((await t.c.conversations.get(org.scope, r.conversationId)).assignee).toBeNull();

    await t.c.conversations.humanReply(org.scope, r.conversationId, sam.userId, 'Hi, Sam here.');
    expect((await t.c.conversations.get(org.scope, r.conversationId)).assignee).toEqual({ id: sam.userId, name: 'Sam' });
    expect(await eventsOf(org, r.conversationId, 'conversation.assigned')).toHaveLength(1);
    // Everyone gets the handoff alert as before; no note tells Sam he was given the chat he answered himself.
    await t.c.automation.dispatchPending();
    expect((await t.c.automation.listNotifications(org.scope, sam.userId)).map((n) => n.type)).toEqual(['conversation.handoff_requested']);

    // A second reply changes nothing.
    await t.c.conversations.humanReply(org.scope, r.conversationId, sam.userId, 'Still here.');
    expect(await eventsOf(org, r.conversationId, 'conversation.assigned')).toHaveLength(1);
  });

  it("never takes a chat from the teammate it's assigned to", async () => {
    const org = await createOrg(t.c, 'Keep Assign Co');
    const maya = await member(org, 'Maya');
    const sam = await member(org, 'Sam');
    const r = await send(org, 'talk to a human');
    await t.c.conversations.assign(org.scope, r.conversationId, maya.userId, maya.userId);
    await t.c.conversations.humanReply(org.scope, r.conversationId, sam.userId, 'Sam jumping in.');
    expect((await t.c.conversations.get(org.scope, r.conversationId)).assignee?.id).toBe(maya.userId);
  });

  it('two replies at once give one assignee and one event', async () => {
    const org = await createOrg(t.c, 'Race Assign Co');
    const maya = await member(org, 'Maya');
    const sam = await member(org, 'Sam');
    const r = await send(org, 'talk to a human');
    await Promise.all([
      t.c.conversations.humanReply(org.scope, r.conversationId, maya.userId, 'Maya here.'),
      t.c.conversations.humanReply(org.scope, r.conversationId, sam.userId, 'Sam here.'),
    ]);
    const assignee = (await t.c.conversations.get(org.scope, r.conversationId)).assignee?.id;
    expect([maya.userId, sam.userId]).toContain(assignee);
    expect(await eventsOf(org, r.conversationId, 'conversation.assigned')).toHaveLength(1);
  });
});

describe('reopening a closed chat (BUG-13.3)', () => {
  it('hands it back to whoever reopened it, as its own event, not a handoff', async () => {
    const org = await createOrg(t.c, 'Reopen Co');
    const sam = await member(org, 'Sam');
    t.llm.setScript([text('Hi!')]);
    const r = await send(org, 'Hello');
    await t.c.conversations.setStatus(org.scope, r.conversationId, 'closed', { actor: 'user', actorUserId: sam.userId });
    const handoffsBefore = (await eventsOf(org, r.conversationId, 'conversation.handoff_requested')).length;
    const summariesBefore = t.llm.requests.length;

    const res = await statusCall(sam.token, org.orgId, r.conversationId, 'reopen');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'human_active', assignedUserId: sam.userId, handedOffAt: null });
    const [reopened] = await eventsOf(org, r.conversationId, 'conversation.reopened');
    expect(reopened).toMatchObject({ actor: 'user', actorUserId: sam.userId, payload: { previousStatus: 'closed', reason: 'Reopened by staff' } });
    // Not counted as a handoff (analytics counts handoff events), and no second recap of a chat just recapped.
    expect(await eventsOf(org, r.conversationId, 'conversation.handoff_requested')).toHaveLength(handoffsBefore);
    await t.c.queue.drain();
    expect(t.llm.requests.length).toBe(summariesBefore);

    // The visitor's next message lands in the reopened chat.
    const next = await send(org, 'Thanks for getting back to me');
    expect(next.conversationId).toBe(r.conversationId);
  });

  it('is refused for a chat that is not closed, and names a newer open conversation', async () => {
    const org = await createOrg(t.c, 'Reopen Refused Co');
    const sam = await member(org, 'Sam');
    t.llm.setScript([text('Hi!')]);
    const first = await send(org, 'Hello');
    expect((await statusCall(sam.token, org.orgId, first.conversationId, 'reopen')).statusCode).toBe(409);

    await t.c.conversations.setStatus(org.scope, first.conversationId, 'closed', { actor: 'user', actorUserId: sam.userId });
    t.llm.setScript([text('Hi again!')]);
    const newer = await send(org, 'Hello again');
    expect(newer.conversationId).not.toBe(first.conversationId);
    const res = await statusCall(sam.token, org.orgId, first.conversationId, 'reopen');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      message: 'This customer already has a newer open conversation',
      details: [{ path: 'openConversationId', message: newer.conversationId }],
    });
  });

  it('needs an agent or above', async () => {
    const org = await createOrg(t.c, 'Reopen Viewer Co');
    const val = await member(org, 'Val', 'viewer');
    t.llm.setScript([text('Hi!')]);
    const r = await send(org, 'Hello');
    await t.c.conversations.setStatus(org.scope, r.conversationId, 'closed', { actor: 'system' });
    expect((await statusCall(val.token, org.orgId, r.conversationId, 'reopen')).statusCode).toBe(403);
  });
});

describe('the widget while the team has the chat (BUG-13.1)', () => {
  it("announces a brand-new visitor's first handoff, and never twice", () => {
    expect(announcesHandoff(null, 'human_active', true)).toBe(true); // the bug: a new visitor's first handoff
    expect(announcesHandoff('ai_active', 'human_active', true)).toBe(true);
    expect(announcesHandoff('closed', 'human_active', true)).toBe(true); // reopened by the team
    expect(announcesHandoff('human_active', 'human_active', true)).toBe(false);
    expect(announcesHandoff(null, 'human_active', false)).toBe(false); // while loading: the history says it once
    expect(announcesHandoff('human_active', 'ai_active', true)).toBe(false);
  });

  it('says where things stand in the header', () => {
    expect(headerLine('human_active', false, 'Maya · usually replies instantly')).toBe('Waiting for a team member…');
    expect(headerLine('human_active', true, 'Maya · usually replies instantly')).toBe('A team member is replying');
    expect(headerLine('ai_active', true, 'Maya · usually replies instantly')).toBe('Maya · usually replies instantly');
    expect(headerLine(null, false, 'Maya · usually replies instantly')).toBe('Maya · usually replies instantly');
  });
});
