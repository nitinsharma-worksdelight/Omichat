import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { LlmError } from '../src/modules/ai/llm/types';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * F5b — Ask the team first. An action the bot must ask about is saved as a request instead of happening; staff approve
 * it (it runs once, against the current state) or decline it, either with a message to the customer; the assistant's
 * next turn knows the outcome, and a request nobody answers expires after 7 days.
 */

let t: TestEnv;
let receiver: Server;
let receiverUrl: string;
const received: Array<{ url: string; body: Record<string, any> }> = [];

beforeAll(async () => {
  t = await createTestEnv();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ refunded: true }));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
  await t.close();
});

type Org = Awaited<ReturnType<typeof createOrg>>;
type Approval = { id: string; conversationId: string; contact: { isTest: boolean }; tool: string; summary: string; status: string; reason: string | null; result: unknown; input: unknown };

const setActions = async (org: Org, actions: Record<string, unknown>) => {
  const res = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, ...actions } } } });
  expect(res.statusCode, res.body).toBe(200);
};

/** One customer message; the fake model plays `turns`, then says "ok". */
async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('ok')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

const list = async (org: Org, query = '', token = org.token) => {
  const res = await t.app.inject({ method: 'GET', url: `/v1/approvals${query}`, headers: authHeaders(token) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Approval[];
};
const decide = (id: string, action: 'approve' | 'reject', token: string, payload: Record<string, unknown> = {}) =>
  t.app.inject({ method: 'POST', url: `/v1/approvals/${id}/${action}`, headers: authHeaders(token), payload });
const stageOf = async (org: Org, contactId: string) => (await t.c.contacts.get(org.scope, contactId)).lifecycleStage;
const setStage = tools({ name: 'set_lifecycle_stage', input: { stage: 'customer' } });
const lastContext = () => JSON.stringify(t.llm.requests.at(-1)!.messages);

describe('asking the team first', () => {
  it('saves the request, does nothing yet, and tells the team', async () => {
    const org = await createOrg(t.c, 'Ask First Clinic');
    // Only actions can ask first.
    const bad = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, askFirst: ['search_knowledge_base'] } } } });
    expect(bad.statusCode).toBe(400);
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });

    const r = await say(org, 'ask', 'I just paid!', setStage, text('A team member will confirm.'));
    const result = lastToolResults(t.llm)[0]!;
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ waiting_for_team: true });
    expect(await stageOf(org, r.contactId)).toBe('new');
    expect(t.llm.requests.at(-1)!.system).toContain('waiting for the team');

    const [request, ...others] = await list(org);
    expect(others).toHaveLength(0);
    expect(request).toMatchObject({ conversationId: r.conversationId, tool: 'set_lifecycle_stage', status: 'pending', summary: 'Move the customer to the “customer” stage', input: { stage: 'customer' } });
    expect(result.content).toMatchObject({ request_id: request!.id });
    expect((await t.c.conversations.toolInvocations(org.scope, r.conversationId)).at(-1)).toMatchObject({ toolName: 'set_lifecycle_stage', status: 'pending' });
    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.find((e) => e.type === 'action.approval_requested')).toMatchObject({
      actor: 'ai',
      conversationId: r.conversationId,
      payload: { approvalId: request!.id, tool: 'set_lifecycle_stage' },
    });
    const notes = await t.c.db.select().from(schema.notifications).where(eq(schema.notifications.organizationId, org.orgId));
    expect(notes.find((n) => n.type === 'action.approval_requested')).toMatchObject({ link: `/conversations/${r.conversationId}` });

    // Asking again in the same conversation doesn't make a second request, and the model knows it's still waiting.
    await say(org, 'ask', 'So am I a customer now?', setStage, text('Still with the team.'));
    expect(await list(org)).toHaveLength(1);
    expect(lastContext()).toContain('asked the team to approve: Move the customer to the “customer” stage (waiting for their answer)');
  });

  it('approving runs it once, and can message the customer without taking the conversation over', async () => {
    const org = await createOrg(t.c, 'Approve Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    const r = await say(org, 'yes', 'I just paid!', setStage, text('A team member will confirm.'));
    const [request] = await list(org);

    const res = await decide(request!.id, 'approve', org.token, { message: 'Welcome aboard! Your plan is on its way.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', decidedBy: { name: 'Owner' } });
    expect(await stageOf(org, r.contactId)).toBe('customer');
    expect((await decide(request!.id, 'approve', org.token)).statusCode).toBe(409);
    expect((await decide(request!.id, 'reject', org.token)).statusCode).toBe(409);

    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.filter((e) => e.type === 'action.approved')).toHaveLength(1);
    expect(events.find((e) => e.type === 'action.approved')).toMatchObject({ actor: 'user', conversationId: r.conversationId, payload: { approvalId: request!.id } });
    expect(events.filter((e) => e.type === 'contact.updated' && (e.payload as { lifecycleStage?: string }).lifecycleStage === 'customer')).toHaveLength(1);
    const messages = await t.c.conversations.messages(org.scope, r.conversationId);
    expect(messages.at(-1)).toMatchObject({ senderType: 'human', content: 'Welcome aboard! Your plan is on its way.' });
    expect((await t.c.conversations.get(org.scope, r.conversationId)).status).toBe('ai_active');
    expect(await list(org, '?status=approved')).toHaveLength(1);
    expect(await list(org, '?status=pending')).toHaveLength(0);

    await say(org, 'yes', 'Great, thanks!');
    expect(lastContext()).toContain('the team approved: Move the customer to the “customer” stage');
  });

  it('declining runs nothing and the next turn knows why; a request nobody answers expires', async () => {
    const org = await createOrg(t.c, 'Decline Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    const r = await say(org, 'no', 'I just paid!', setStage, text('A team member will confirm.'));
    const [request] = await list(org);

    const res = await decide(request!.id, 'reject', org.token, { reason: 'Payment not received yet', message: "We haven't seen your payment yet; we'll confirm once it arrives." });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'rejected', reason: 'Payment not received yet' });
    expect(await stageOf(org, r.contactId)).toBe('new');
    expect((await decide(request!.id, 'approve', org.token)).statusCode).toBe(409);
    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.find((e) => e.type === 'action.rejected')).toMatchObject({ actor: 'user', payload: { approvalId: request!.id, reason: 'Payment not received yet' } });
    expect((await t.c.conversations.messages(org.scope, r.conversationId)).at(-1)).toMatchObject({ senderType: 'human' });

    await say(org, 'no', 'Any news?');
    expect(lastContext()).toContain('the team declined: Move the customer to the “customer” stage (reason: Payment not received yet)');

    const late = await say(org, 'late', 'I paid as well!', setStage, text('A team member will confirm.'));
    const [waiting] = await list(org, '?status=pending');
    const started = t.now.value;
    t.now.value = new Date(started.getTime() + 8 * 86_400_000);
    try {
      expect((await decide(waiting!.id, 'approve', org.token)).statusCode).toBe(409);
      expect(await list(org, '?status=pending')).toHaveLength(0);
      expect((await list(org, '?status=expired')).map((a) => a.id)).toEqual([waiting!.id]);
      expect(await stageOf(org, late.contactId)).toBe('new');
    } finally {
      t.now.value = started;
    }
  });

  it("a retried turn doesn't ask twice", async () => {
    const org = await createOrg(t.c, 'Retry Ask Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    const temporaryFailure = (): never => {
      throw new LlmError('unavailable', true, 'Provider overloaded', 'mock');
    };
    t.llm.setScript([setStage, temporaryFailure, setStage, text('A team member will confirm.')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'retry', content: 'I just paid!' });
    await t.c.queue.drain();
    expect(await list(org)).toHaveLength(1);
    const calls = await t.c.conversations.toolInvocations(org.scope, r.conversationId);
    expect(calls.map((c) => `${c.toolName} ${c.status}`)).toEqual(['set_lifecycle_stage pending', 'set_lifecycle_stage replayed']);
  });

  it('only agents decide, and only in their own organization', async () => {
    const org = await createOrg(t.c, 'Roles Ask Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    await say(org, 'roles', 'I just paid!', setStage, text('A team member will confirm.'));
    const [request] = await list(org);
    const member = async (role: 'viewer' | 'agent') => {
      const email = `${role}-${Math.random().toString(36).slice(2)}@example.com`;
      await t.app.inject({ method: 'POST', url: '/v1/members', headers: authHeaders(org.token), payload: { email, role, password: 'member-password-1' } });
      return (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } })).json().token as string;
    };
    const viewer = await member('viewer');
    expect(await list(org, '', viewer)).toHaveLength(1);
    expect((await decide(request!.id, 'approve', viewer)).statusCode).toBe(403);

    const other = await createOrg(t.c, 'Other Clinic');
    expect(await list(other)).toHaveLength(0);
    expect((await decide(request!.id, 'approve', other.token)).statusCode).toBe(404);

    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'crm', scopes: ['conversations:write'] } })).json().key as string;
    expect((await decide(request!.id, 'approve', key)).statusCode).toBe(401);

    expect((await decide(request!.id, 'approve', await member('agent'))).statusCode).toBe(200);
  });

  it('an approval interrupted mid-action can be decided again a few minutes later; playground requests are marked', async () => {
    const org = await createOrg(t.c, 'Stuck Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    t.llm.setScript([setStage, text('A team member will confirm.'), text('ok')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'stuck', content: 'I just paid!', isTest: true });
    await t.c.queue.drain();
    const [request] = await list(org);
    expect(request!.contact.isTest).toBe(true);

    // As if the server stopped while carrying it out.
    const interrupted = (minutesAgo: number) =>
      t.c.db
        .update(schema.actionApprovals)
        .set({ status: 'running', decidedAt: new Date(t.now.value.getTime() - minutesAgo * 60_000) })
        .where(eq(schema.actionApprovals.id, request!.id));
    await interrupted(1);
    expect((await decide(request!.id, 'approve', org.token)).statusCode).toBe(409);
    await interrupted(10);
    expect((await decide(request!.id, 'approve', org.token)).statusCode).toBe(200);
    expect(await stageOf(org, r.contactId)).toBe('customer');
  });

  it("a request that no longer fits the bot's settings isn't run", async () => {
    const org = await createOrg(t.c, 'Changed Clinic');
    await setActions(org, { lifecycleStages: ['customer'], askFirst: ['set_lifecycle_stage'] });
    const r = await say(org, 'changed', 'I just paid!', setStage, text('A team member will confirm.'));
    const [request] = await list(org);
    await setActions(org, { lifecycleStages: [], askFirst: ['set_lifecycle_stage'] });

    const res = await decide(request!.id, 'approve', org.token);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('switched off');
    expect(await stageOf(org, r.contactId)).toBe('new');
    expect((await list(org, '?status=pending')).map((a) => a.id)).toEqual([request!.id]);
    expect((await decide(request!.id, 'reject', org.token)).statusCode).toBe(200);
  });
});

describe('workflows that ask first', () => {
  it('wait for the team, then run with who approved them, even for a web-chat visitor of an identified-only workflow', async () => {
    const org = await createOrg(t.c, 'Refund Clinic');
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: authHeaders(org.token),
      payload: {
        key: 'refund',
        name: 'Refund',
        description: 'Refund an order for the customer.',
        url: `${receiverUrl}/refund`,
        mode: 'request_response',
        identifiedOnly: true,
        askFirst: true,
        inputFields: [{ name: 'order_number', type: 'string', required: true, description: 'Order number' }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ askFirst: true, identifiedOnly: true });
    await setActions(org, { workflowKeys: ['refund'] });

    const call = tools({ name: 'trigger_workflow', input: { workflow_key: 'refund', inputs: { order_number: 'A-1001' } } });
    await say(org, 'web', 'Please refund order A-1001', call, text('A team member will check.'));
    expect(lastToolResults(t.llm)[0]!.content).toMatchObject({ waiting_for_team: true });
    expect(received.filter((x) => x.url === '/refund')).toHaveLength(0);

    const [request] = await list(org);
    expect(request).toMatchObject({ tool: 'trigger_workflow', summary: 'Run the “refund” workflow (order_number: A-1001)' });
    const res = await decide(request!.id, 'approve', org.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', result: { ok: true, response: { refunded: true } } });
    const sent = received.filter((x) => x.url === '/refund');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ inputs: { order_number: 'A-1001' }, trust: { identity: 'unverified', approvedBy: expect.any(String) } });
  });
});
