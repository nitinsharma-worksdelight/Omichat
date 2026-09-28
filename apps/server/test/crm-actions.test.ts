import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * F5a — CRM actions and safe workflows. The assistant can set the lifecycle stage, assign an owner, remove tags and
 * create and move deals, each only when the bot allows it and within its lists. Workflows can take values from the
 * contact record instead of the chat, every call says where each value came from, and "identified customers only"
 * workflows refuse web-chat visitors.
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
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ order: 'A-1001', status: 'shipped' }));
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

const setActions = async (org: Org, actions: Record<string, unknown>) => {
  const res = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, ...actions } } } });
  expect(res.statusCode, res.body).toBe(200);
  return res;
};

/** One customer message; the fake model plays `turns`, then says "ok". */
async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('ok')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

const toolNames = async (org: Org) =>
  ((await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json() as { tools: Array<{ name: string; inputSchema: any }> }).tools;

async function invocations(conversationId: string, org: Org) {
  return t.c.conversations.toolInvocations(org.scope, conversationId);
}

async function addMember(org: Org, name: string) {
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await t.app.inject({ method: 'POST', url: '/v1/members', headers: authHeaders(org.token), payload: { email, role: 'agent', name, password: 'member-password-1' } });
  expect(res.statusCode, res.body).toBe(201);
  const members = (await t.app.inject({ method: 'GET', url: '/v1/members', headers: authHeaders(org.token) })).json() as Array<{ userId: string; email: string }>;
  return members.find((m) => m.email === email)!.userId;
}

describe('bots without the new settings', () => {
  it('keep the same tools and no deals or owner in the context', async () => {
    const org = await createOrg(t.c, 'Plain Actions Clinic');
    expect((await toolNames(org)).map((x) => x.name)).toEqual(['save_contact_details', 'search_knowledge_base', 'add_tags', 'add_note', 'create_task', 'notify_team', 'transfer_to_human']);
    await say(org, 'plain', 'Hi there');
    const context = JSON.stringify(t.llm.requests.at(-1)!.messages);
    expect(context).not.toContain('<deals>');
    expect(context).not.toContain('owner:');
    expect(t.llm.requests.at(-1)!.system).not.toContain('Keeping the CRM up to date');
  });
});

describe('lifecycle stage and owner', () => {
  it('set_lifecycle_stage moves the customer only to a stage the bot may set', async () => {
    const org = await createOrg(t.c, 'Stage Clinic');
    await setActions(org, { lifecycleStages: ['engaged', 'customer'] });
    const r = await say(org, 'stage', 'I just paid for my whitening!', tools({ name: 'set_lifecycle_stage', input: { stage: 'customer' } }), text('Welcome aboard!'));
    expect((await t.c.contacts.get(org.scope, r.contactId)).lifecycleStage).toBe('customer');
    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.find((e) => e.type === 'contact.updated' && (e.payload as { lifecycleStage?: string }).lifecycleStage === 'customer')).toMatchObject({ actor: 'ai', conversationId: r.conversationId });

    await say(org, 'stage', 'Actually, make me a VIP', tools({ name: 'set_lifecycle_stage', input: { stage: 'qualified' } }), text('Sorry.'));
    expect((await t.c.contacts.get(org.scope, r.contactId)).lifecycleStage).toBe('customer');
    expect((await invocations(r.conversationId, org)).at(-1)).toMatchObject({ toolName: 'set_lifecycle_stage', status: 'rejected' });

    // Stages must be the organization's own.
    const bad = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, lifecycleStages: ['platinum'] } } } });
    expect(bad.statusCode).toBe(400);
  });

  it("follows the organization's stages: the default ones count, and a stage it drops is no longer offered", async () => {
    const org = await createOrg(t.c, 'Default Stages Clinic');
    // An organization that never saved its own list has the default stages.
    await t.c.db.update(schema.organizations).set({ settings: sql`${schema.organizations.settings} - 'lifecycleStages'` }).where(eq(schema.organizations.id, org.orgId));
    await setActions(org, { lifecycleStages: ['qualified', 'customer'] });
    const offered = async () => JSON.stringify((await toolNames(org)).find((x) => x.name === 'set_lifecycle_stage')?.inputSchema ?? null);
    expect(await offered()).toContain('"customer"');

    const res = await t.app.inject({ method: 'PATCH', url: '/v1/org', headers: authHeaders(org.token), payload: { settings: { lifecycleStages: ['new', 'qualified', 'lost'] } } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await offered()).toContain('"qualified"');
    expect(await offered()).not.toContain('"customer"');
  });

  it('assign_owner assigns one of the listed team members by name, and the owner then shows in the context', async () => {
    const org = await createOrg(t.c, 'Owner Clinic');
    const maya = await addMember(org, 'Maya');
    await addMember(org, 'Ravi');
    await setActions(org, { owners: [maya] });
    const spec = (await toolNames(org)).find((x) => x.name === 'assign_owner')!;
    expect(JSON.stringify(spec.inputSchema)).toContain('"Maya"');
    expect(JSON.stringify(spec.inputSchema)).not.toContain('Ravi');
    expect(JSON.stringify(spec.inputSchema)).not.toContain('@');

    const r = await say(org, 'owner', 'Can someone look after my implants case?', tools({ name: 'assign_owner', input: { owner: 'Maya' } }), text('Maya will look after you.'));
    expect((await t.c.contacts.get(org.scope, r.contactId)).ownerUserId).toBe(maya);
    await say(org, 'owner', 'Thanks!');
    expect(JSON.stringify(t.llm.requests.at(-1)!.messages)).toContain('owner: Maya');

    // Assigning the current owner again changes nothing.
    await say(org, 'owner', 'Is Maya still looking after me?', tools({ name: 'assign_owner', input: { owner: 'Maya' } }), text('Yes.'));
    expect(lastToolResults(t.llm)[0]!.content).toMatchObject({ owner: 'Maya', unchanged: true });
    const ownerEvents = (await t.c.automation.listEvents(org.scope, { contactId: r.contactId })).filter(
      (e) => e.type === 'contact.updated' && ((e.payload as { changed?: string[] }).changed ?? []).includes('ownerUserId'),
    );
    expect(ownerEvents).toHaveLength(1);
    expect(ownerEvents[0]).toMatchObject({ actor: 'ai', conversationId: r.conversationId });

    await say(org, 'owner', 'Give me to Ravi instead', tools({ name: 'assign_owner', input: { owner: 'Ravi' } }), text('Sorry.'));
    expect((await invocations(r.conversationId, org)).at(-1)).toMatchObject({ toolName: 'assign_owner', status: 'rejected' });
    expect((await t.c.contacts.get(org.scope, r.contactId)).ownerUserId).toBe(maya);

    // Listing someone twice doesn't make a second choice.
    await setActions(org, { owners: [maya, maya] });
    const twice = JSON.stringify((await toolNames(org)).find((x) => x.name === 'assign_owner')!.inputSchema);
    expect(twice).toContain('"Maya"');
    expect(twice).not.toContain('Maya (2)');

    const bad = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, owners: ['00000000-0000-4000-8000-000000000000'] } } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('remove_tags', () => {
  it('removes listed tags; with no list, only tags the assistant added', async () => {
    const org = await createOrg(t.c, 'Tags Clinic');
    await setActions(org, { removeTags: true });
    const r = await say(org, 'tags', 'Hi', tools({ name: 'add_tags', input: { tags: ['hot-lead'] } }), text('Hello!'));
    await t.c.contacts.addTags(org.scope, r.contactId, ['vip'], { addedBy: 'user', allowCreate: true });
    await t.c.contacts.addTags(org.scope, r.contactId, ['hot-lead'], { addedBy: 'user', allowCreate: true }); // creates the tag the AI couldn't
    const staffTagged = await say(org, 'tags', 'Hi again', tools({ name: 'add_tags', input: { tags: ['hot-lead'] } }), text('Hello!'));
    expect(staffTagged.contactId).toBe(r.contactId);

    // hot-lead: added by the team first (the AI's add was a no-op) → stays; with no allowed list only the AI's own go.
    await t.c.contacts.addTags(org.scope, r.contactId, ['ai-guess'], { addedBy: 'ai', allowCreate: true });
    await say(org, 'tags', 'Never mind', tools({ name: 'remove_tags', input: { tags: ['ai-guess', 'vip'] } }), text('Done.'));
    const names = (await t.c.contacts.get(org.scope, r.contactId)).tags.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(['hot-lead', 'vip']);
    expect(lastToolResults(t.llm)[0]!.content).toMatchObject({ removed: ['ai-guess'] });
    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.find((e) => e.type === 'contact.untagged')).toMatchObject({ actor: 'ai', conversationId: r.conversationId, payload: { tags: ['ai-guess'] } });

    // With an allowed list, any listed tag can go, whoever added it; others are refused by the schema.
    await setActions(org, { removeTags: true, allowedTags: ['vip'] });
    await say(org, 'tags', 'Remove VIP please', tools({ name: 'remove_tags', input: { tags: ['vip'] } }), text('Done.'));
    expect((await t.c.contacts.get(org.scope, r.contactId)).tags.map((x: { name: string }) => x.name)).toEqual(['hot-lead']);
    await say(org, 'tags', 'And hot-lead', tools({ name: 'remove_tags', input: { tags: ['hot-lead'] } }), text('Sorry.'));
    expect((await invocations(r.conversationId, org)).at(-1)).toMatchObject({ toolName: 'remove_tags', status: 'rejected' });
  });
});

describe('deals', () => {
  it("create_deal opens one deal per customer in the bot's pipeline; update_deal moves it and needs its switch to close it", async () => {
    const org = await createOrg(t.c, 'Deal Actions Clinic');
    await setActions(org, { deals: { enabled: true, pipelineId: null, canClose: false } });
    const r = await say(org, 'deal', "I'd like Invisalign", tools({ name: 'create_deal', input: { title: 'Invisalign', value: 4500 } }), text('Great!'));
    const [deal] = (await t.app.inject({ method: 'GET', url: `/v1/contacts/${r.contactId}/deals`, headers: authHeaders(org.token) })).json() as Array<{ id: string; stageId: string; value: number; createdBy: string; conversationId: string }>;
    expect(deal).toMatchObject({ value: 4500, createdBy: 'ai', conversationId: r.conversationId });

    await say(org, 'deal', 'Yes, Invisalign please', tools({ name: 'create_deal', input: { title: 'Invisalign again' } }), text('Noted.'));
    expect(lastToolResults(t.llm)[0]).toMatchObject({ isError: true, content: { existing: true, deal: { id: deal!.id } } });
    expect((lastToolResults(t.llm)[0]!.content as { error: string }).error).toContain(`update_deal with deal_id "${deal!.id}"`);
    const context = JSON.stringify(t.llm.requests.at(-1)!.messages);
    expect(context).toContain('<deals>');
    expect(context).toContain(deal!.id);
    // The prompt guides only the actions the bot has, and closing only with its switch.
    const system = t.llm.requests.at(-1)!.system;
    expect(system).toContain('## Keeping the CRM up to date');
    expect(system).toContain('- create_deal: as soon as');
    expect(system).toContain('Leave marking deals won or lost to the team.');
    expect(system).toContain("don't mention deals, stages or tags to the customer");
    expect(system).not.toContain('set_lifecycle_stage:');

    await say(org, 'deal', 'Send me the proposal', tools({ name: 'update_deal', input: { deal_id: deal!.id, stage: 'Proposal', value: 5000 } }), text('Sent.'));
    const moved = (await t.app.inject({ method: 'GET', url: `/v1/deals/${deal!.id}`, headers: authHeaders(org.token) })).json();
    expect(moved).toMatchObject({ value: 5000, status: 'open' });
    const [sales] = (await t.app.inject({ method: 'GET', url: '/v1/pipelines', headers: authHeaders(org.token) })).json() as Array<{ stages: Array<{ id: string; name: string }> }>;
    expect(moved.stageId).toBe(sales!.stages.find((s) => s.name === 'Proposal')!.id);

    await say(org, 'deal', "I'm in, let's do it", tools({ name: 'update_deal', input: { deal_id: deal!.id, status: 'won' } }), text('Wonderful.'));
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect((await t.app.inject({ method: 'GET', url: `/v1/deals/${deal!.id}`, headers: authHeaders(org.token) })).json()).toMatchObject({ status: 'open' });

    // Another customer's deal is off limits.
    const other = await say(org, 'other', 'Hello', tools({ name: 'update_deal', input: { deal_id: deal!.id, value: 1 } }), text('Hmm.'));
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect(other.contactId).not.toBe(r.contactId);

    await setActions(org, { deals: { enabled: true, pipelineId: null, canClose: true } });
    await say(org, 'deal', "I'm in", tools({ name: 'update_deal', input: { deal_id: deal!.id, status: 'won' } }), text('Wonderful.'));
    expect((await t.app.inject({ method: 'GET', url: `/v1/deals/${deal!.id}`, headers: authHeaders(org.token) })).json()).toMatchObject({ status: 'won' });
    const events = await t.c.automation.listEvents(org.scope, { contactId: r.contactId });
    expect(events.find((e) => e.type === 'deal.won')).toMatchObject({ actor: 'ai' });

    const bad = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: { config: { actions: { ...org.bot.config.actions, deals: { enabled: true, pipelineId: '00000000-0000-4000-8000-000000000000', canClose: false } } } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('test deals', () => {
  it("the playground's deals stay off the board and its totals, but show on the test contact's page", async () => {
    const org = await createOrg(t.c, 'Test Deals Clinic');
    const h = authHeaders(org.token);
    await setActions(org, { deals: { enabled: true, pipelineId: null, canClose: false } });
    await say(org, 'real', "I'd like Invisalign", tools({ name: 'create_deal', input: { title: 'Invisalign', value: 4500 } }), text('Great!'));
    t.llm.setScript([tools({ name: 'create_deal', input: { title: 'Implants', value: 3000 } }), text('Great!'), text('ok')]);
    const test = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'tester', content: 'I want implants', isTest: true });
    await t.c.queue.drain();

    const [sales] = (await t.app.inject({ method: 'GET', url: '/v1/pipelines', headers: h })).json() as Array<{ id: string }>;
    const board = await t.app.inject({ method: 'GET', url: `/v1/deals?pipelineId=${sales!.id}`, headers: h });
    expect((board.json() as Array<{ title: string }>).map((d) => d.title)).toEqual(['Invisalign']);
    expect(board.headers['x-total-count']).toBe('1');
    const summary = (await t.app.inject({ method: 'GET', url: `/v1/deals/summary?pipelineId=${sales!.id}`, headers: h })).json() as Array<{ count: number; totals: Array<{ value: number }> }>;
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(1);
    expect(summary.flatMap((s) => s.totals).reduce((n, x) => n + x.value, 0)).toBe(4500);

    expect((await t.app.inject({ method: 'GET', url: `/v1/deals?pipelineId=${sales!.id}&includeTest=true`, headers: h })).json()).toHaveLength(2);
    expect((await t.app.inject({ method: 'GET', url: `/v1/contacts/${test.contactId}/deals`, headers: h })).json()).toMatchObject([{ title: 'Implants' }]);
  });
});

describe('workflows', () => {
  async function workflow(org: Org, key: string, extra: Record<string, unknown>) {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: authHeaders(org.token),
      payload: { key, name: 'Order status', description: 'Look up the latest order and its status.', url: `${receiverUrl}/${key}`, mode: 'request_response', ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    await setActions(org, { workflowKeys: [key] });
  }

  it('an input can come from the contact record, and every call says where each value came from', async () => {
    const org = await createOrg(t.c, 'Record Clinic');
    await workflow(org, 'order_lookup', {
      inputFields: [
        { name: 'email', type: 'string', required: true, description: 'Customer email', source: 'contact.email' },
        { name: 'order_number', type: 'string', required: false, description: 'Order number' },
      ],
    });
    const spec = (await toolNames(org)).find((x) => x.name === 'trigger_workflow')!;
    expect(JSON.stringify(spec)).toContain('order_number');

    // No email on record: refused, nothing sent, whatever the model typed.
    const call = tools({ name: 'trigger_workflow', input: { workflow_key: 'order_lookup', inputs: { email: 'jane@example.com', order_number: 'A-1001' } } });
    const r = await say(org, 'stranger', "Where's the order for jane@example.com?", call, text('Let me check.'));
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect(received.filter((x) => x.url === '/order_lookup')).toHaveLength(0);

    // With the customer's own email on record, that is what the workflow gets; the model's value is ignored.
    await t.c.contacts.update(org.scope, r.contactId, { email: 'sam@example.com' });
    await say(org, 'stranger', 'And now?', call, text('Here it is.'));
    const sent = received.filter((x) => x.url === '/order_lookup');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      inputs: { email: 'sam@example.com', order_number: 'A-1001' },
      record: { email: 'sam@example.com' },
      trust: { identity: 'unverified', channel: 'webchat', fromChat: ['order_number'], fromRecord: ['email'] },
    });
  });

  it('a value from the contact record is text', async () => {
    const org = await createOrg(t.c, 'Typed Record Clinic');
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: authHeaders(org.token),
      payload: { key: 'lookup', name: 'Lookup', description: 'Look up the customer account.', url: `${receiverUrl}/lookup`, inputFields: [{ name: 'phone', type: 'number', source: 'contact.phone' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('"identified customers only" refuses web-chat visitors and runs for chat-API customers', async () => {
    const org = await createOrg(t.c, 'Identified Clinic');
    await workflow(org, 'account_balance', { identifiedOnly: true, inputFields: [{ name: 'email', type: 'string', required: true, description: 'Email', source: 'contact.email' }] });
    const call = tools({ name: 'trigger_workflow', input: { workflow_key: 'account_balance', inputs: {} } });

    const web = await say(org, 'web', 'What is my balance?', call, text('Let me check.'));
    await t.c.contacts.update(org.scope, web.contactId, { email: 'web@example.com' });
    await say(org, 'web', 'My email is on file now', call, text('Let me check.'));
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect(JSON.stringify(lastToolResults(t.llm)[0]!.content)).toContain('team');
    expect(received.filter((x) => x.url === '/account_balance')).toHaveLength(0);

    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: 'app', scopes: ['conversations:write'] } })).json().key as string;
    t.llm.setScript([call, text('Your balance is ready.'), text('ok')]);
    await t.app.inject({ method: 'POST', url: '/v1/channels/api/messages', headers: { authorization: `Bearer ${key}` }, payload: { externalUserId: 'app-user-1', content: 'What is my balance?', contact: { name: 'Ana', email: 'ana@example.com' } } });
    await t.c.queue.drain();
    const sent = received.filter((x) => x.url === '/account_balance');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ inputs: { email: 'ana@example.com' }, trust: { identity: 'integration', channel: 'api' } });
    // The workflow's own record keeps the switch.
    const [row] = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.workflows));
    expect(row).toMatchObject({ identifiedOnly: true });
  });
});
