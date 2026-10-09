import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { CustomApiSchema } from '../src/modules/bots/config';
import { buildRequest, checkInputs } from '../src/modules/tools/custom-api';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * The "API Call" action: a custom HTTP API the assistant may call. Its credential is write-only (sealed at rest, never
 * returned), the request is built from the collected values and the contact on record, the team can be asked first,
 * and the Test tab sends a draft with sample values.
 */

let t: TestEnv;
let receiver: Server;
let base: string;
const received: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  t = await createTestEnv();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.url?.startsWith('/fail')) return void res.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ order: 'A-17', status: 'shipped' }));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
  await t.close();
});

type Org = Awaited<ReturnType<typeof createOrg>>;

const orderApi = (over: Record<string, unknown> = {}) => ({
  key: 'order_status',
  name: 'Order status',
  description: 'Look up where an order is when the customer asks.',
  method: 'POST',
  url: `${base}/orders/{{order_id}}`,
  headers: [{ name: 'X-Source', value: 'omni' }],
  query: [{ name: 'email', value: '{{contact.email}}' }],
  params: [
    { name: 'order_id', description: 'The order number', required: true },
    { name: 'note', required: false },
  ],
  auth: { type: 'bearer', secret: 'tok_live_123' },
  ...over,
});

const patchBot = (org: Org, body: Record<string, unknown>) =>
  t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: authHeaders(org.token), payload: body });
const setApis = (org: Org, customApis: unknown[]) => patchBot(org, { config: { actions: { ...org.bot.config.actions, customApis } } });
const storedConfig = async (botId: string) => (await t.c.db.select().from(schema.bots).where(eq(schema.bots.id, botId)))[0]!.config;

async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('ok')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

describe('building the request', () => {
  const api = CustomApiSchema.parse({
    key: 'crm',
    name: 'CRM',
    description: 'x',
    method: 'POST',
    url: 'https://api.example.com/people/{{id}}',
    query: [{ name: 'src', value: '{{conversation.id}}' }],
    headers: [{ name: 'X-Who', value: '{{contact.name}}' }],
    params: [{ name: 'id' }, { name: 'plan' }, { name: 'seats', type: 'number' }],
    auth: { type: 'api_key', headerName: 'X-Key' },
  });
  const values = { inputs: { id: 'a/b c', plan: 'pro', seats: 3 }, builtins: { 'conversation.id': 'conv-1', 'contact.name': 'Ana\r\nX-Evil: 1' } };

  it('fills placeholders safely and sends unplaced inputs as the JSON body', () => {
    const req = buildRequest(api, 'k-1', values);
    expect(req.url).toBe('https://api.example.com/people/a%2Fb%20c?src=conv-1');
    expect(req.headers).toMatchObject({ 'x-key': 'k-1', 'x-who': 'Ana X-Evil: 1', 'content-type': 'application/json' });
    expect(JSON.parse(req.body!)).toEqual({ plan: 'pro', seats: 3 });
  });

  it('puts inputs in the query for GET, escapes a raw JSON body, and refuses a missing credential', () => {
    expect(buildRequest({ ...api, method: 'GET' }, 'k', values)).toMatchObject({ url: 'https://api.example.com/people/a%2Fb%20c?src=conv-1&plan=pro&seats=3', body: undefined });
    const raw = { ...api, rawBody: true, body: '{"name": "{{contact.name}}", "seats": {{seats}}}' };
    expect(JSON.parse(buildRequest(raw, 'k', values).body!)).toEqual({ name: 'Ana\r\nX-Evil: 1', seats: 3 });
    expect(() => buildRequest({ ...raw, body: '{"seats": {{plan}}}' }, 'k', values)).toThrow(/valid JSON/);
    expect(() => buildRequest(api, null, values)).toThrow(/needs its API key/);
  });

  it('checks the collected values', () => {
    expect(checkInputs(api, { id: 'x', plan: 'p', seats: 'two' })).toEqual({ ok: false, problems: ['"seats" must be a number'] });
    expect(checkInputs(api, { plan: 'p', seats: '2' })).toEqual({ ok: false, problems: ['missing "id"'] });
    expect(checkInputs(api, { id: 'x', plan: 'p', seats: '2' })).toEqual({ ok: true, inputs: { id: 'x', plan: 'p', seats: 2 } });
  });
});

describe('saving an API on a bot', () => {
  it('seals the credential, never returns it, keeps it across edits and drops it with auth off', async () => {
    const org = await createOrg(t.c, 'Api Secret Co');
    const res = await setApis(org, [orderApi()]);
    expect(res.statusCode, res.body).toBe(200);
    const saved = res.json().config.actions.customApis[0];
    expect(saved).toMatchObject({ key: 'order_status', auth: { type: 'bearer', hasSecret: true } });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).not.toContain('tok_live_123');
    expect(res.body).not.toContain('secretEnc');
    const stored = JSON.stringify(await storedConfig(org.bot.id));
    expect(stored).not.toContain('tok_live_123');
    expect(stored).toContain('secretEnc');
    expect((await t.app.inject({ method: 'GET', url: `/v1/bots`, headers: authHeaders(org.token) })).body).not.toContain('secretEnc');

    // Sent back as the dashboard has it (no secret): the stored one stays. An edit to another section keeps it too.
    expect((await setApis(org, [{ ...saved, name: 'Order lookup' }])).statusCode).toBe(200);
    expect((await patchBot(org, { config: { persona: { ...org.bot.config.persona, assistantName: 'Zed' } } })).statusCode).toBe(200);
    expect((await t.c.bots.customApi(org.scope, org.bot.id, saved.id))!.secret).toBe('tok_live_123');
    expect((await setApis(org, [{ ...saved, auth: { type: 'none' } }])).json().config.actions.customApis[0].auth.hasSecret).toBe(false);
    expect(JSON.stringify(await storedConfig(org.bot.id))).not.toContain('secretEnc');
  });

  it('rejects APIs that would fail: no credential, an unknown placeholder, duplicate names, a bad URL', async () => {
    const org = await createOrg(t.c, 'Api Invalid Co');
    const noSecret = await setApis(org, [orderApi({ auth: { type: 'bearer' } })]);
    expect(noSecret.statusCode).toBe(400);
    expect(noSecret.body).toContain('needs its token');
    const unknown = await setApis(org, [orderApi({ url: `${base}/x/{{orderId}}`, auth: { type: 'none' } })]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toContain('{{orderId}}');
    const twice = await setApis(org, [orderApi({ auth: { type: 'none' } }), orderApi({ auth: { type: 'none' } })]);
    expect(twice.statusCode).toBe(400);
    expect((await setApis(org, [orderApi({ url: 'ftp://x' })])).statusCode).toBe(400);
  });

  it('duplicating a bot copies its APIs with their credentials, switched off', async () => {
    const org = await createOrg(t.c, 'Api Copy Co');
    const saved = (await setApis(org, [orderApi()])).json();
    const res = await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/duplicate`, headers: authHeaders(org.token) });
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json();
    expect(copy).toMatchObject({ name: `${saved.name} (copy)`, isActive: false, knowledgeBaseIds: saved.knowledgeBaseIds });
    expect(copy.id).not.toBe(org.bot.id);
    const api = copy.config.actions.customApis[0];
    expect((await t.c.bots.customApi(org.scope, copy.id, api.id))!.secret).toBe('tok_live_123');
    const agent = await createOrg(t.c, 'Api Copy Other');
    expect((await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/duplicate`, headers: authHeaders(agent.token) })).statusCode).toBe(404);
  });
});

describe('the assistant calling an API', () => {
  it('calls it with the collected values, the contact on record and the credential, and reads the answer', async () => {
    const org = await createOrg(t.c, 'Api Call Co');
    expect((await setApis(org, [orderApi()])).statusCode).toBe(200);
    const preview = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json();
    const tool = preview.tools.find((x: { name: string }) => x.name === 'call_api');
    expect(tool.description).toContain('order_status: Order status');
    expect(tool.description).toContain('order_id: The order number');

    const r = await say(org, 'api-1', 'Where is my order 17?', tools({ name: 'save_contact_details', input: { email: 'ana@example.com' } }), tools({ name: 'call_api', input: { api: 'order_status', inputs: { order_id: '17' } } }), text('It shipped.'));
    const [result] = lastToolResults(t.llm);
    expect(result).toMatchObject({ isError: false, content: { status: 200, response: { order: 'A-17', status: 'shipped' } } });
    const call = received.at(-1)!;
    expect(call).toMatchObject({ method: 'POST', url: '/orders/17?email=ana%40example.com' });
    expect(call.headers).toMatchObject({ authorization: 'Bearer tok_live_123', 'x-source': 'omni' });
    expect(call.body).toBe('');
    const audit = (await t.c.conversations.toolInvocations(org.scope, r.conversationId)).find((i) => i.toolName === 'call_api');
    expect(audit).toMatchObject({ status: 'success' });
    expect(JSON.stringify(audit)).not.toContain('tok_live_123');
  });

  it('tells the assistant what is missing, and that a failed call did not work', async () => {
    const org = await createOrg(t.c, 'Api Fail Co');
    expect((await setApis(org, [orderApi({ auth: { type: 'none' } }), orderApi({ key: 'broken', name: 'Broken', url: `${base}/fail`, auth: { type: 'none' }, params: [] })])).statusCode).toBe(200);
    await say(org, 'api-2', 'Where is my order?', tools({ name: 'call_api', input: { api: 'order_status' } }), text('Which order?'));
    expect(lastToolResults(t.llm)[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(lastToolResults(t.llm)[0]!.content)).toContain('missing \\"order_id\\"');
    await say(org, 'api-2', 'Try the other thing', tools({ name: 'call_api', input: { api: 'broken' } }), text('Sorry.'));
    expect(JSON.stringify(lastToolResults(t.llm)[0]!.content)).toContain('HTTP 500');
  });

  it('a switched-off API is not offered; one set to ask first waits for the team, then runs once approved', async () => {
    const org = await createOrg(t.c, 'Api Ask Co');
    expect((await setApis(org, [orderApi({ enabled: false })])).statusCode).toBe(200);
    const preview = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json();
    expect(preview.tools.some((x: { name: string }) => x.name === 'call_api')).toBe(false);

    const saved = (await setApis(org, [orderApi({ askFirst: true })])).json().config.actions.customApis[0];
    expect(saved.askFirst).toBe(true);
    const before = received.length;
    await say(org, 'api-3', 'Order 99?', tools({ name: 'call_api', input: { api: 'order_status', inputs: { order_id: '99' } } }), text('Asked the team.'));
    expect(lastToolResults(t.llm)[0]!.content).toMatchObject({ waiting_for_team: true });
    expect(received.length).toBe(before);
    const [request] = (await t.app.inject({ method: 'GET', url: '/v1/approvals', headers: authHeaders(org.token) })).json();
    expect(request).toMatchObject({ tool: 'call_api', summary: 'Call the “order_status” API (order_id: 99)' });
    const res = await t.app.inject({ method: 'POST', url: `/v1/approvals/${request.id}/approve`, headers: authHeaders(org.token), payload: { message: 'On its way.' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(received.length).toBe(before + 1);
    expect(received.at(-1)!.url).toMatch(/^\/orders\/99\?/);
  });
});

describe('the Test tab', () => {
  it('sends a draft with sample values, using the stored credential when no new one is given', async () => {
    const org = await createOrg(t.c, 'Api Test Co');
    const saved = (await setApis(org, [orderApi()])).json().config.actions.customApis[0];
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/bots/${org.bot.id}/custom-apis/test`,
      headers: authHeaders(org.token),
      payload: { api: { ...saved, url: `${base}/orders/{{order_id}}/draft` }, inputs: { order_id: '5' }, builtins: { 'contact.email': 'test@example.com' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 200, response: { order: 'A-17' }, request: { method: 'POST', url: `${base}/orders/5/draft` } });
    expect(received.at(-1)!.headers.authorization).toBe('Bearer tok_live_123');

    const missing = await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/custom-apis/test`, headers: authHeaders(org.token), payload: { api: saved, inputs: {} } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain('missing "order_id"');
  });
});

describe('the AI Agents dashboard', () => {
  it('counts contacts the AI replied to once, its actions, bookings and the time saved, per bot and channel', async () => {
    const org = await createOrg(t.c, 'Dashboard Co');
    await say(org, 'dash-1', 'Hi', text('Hello!'));
    await say(org, 'dash-1', 'Note this', tools({ name: 'add_note', input: { note: 'Likes mornings' } }), text('Noted.'));
    await say(org, 'dash-2', 'Hello', text('Hi there!'));
    // The database stamps rows with the real time: ask about the days around it.
    const today = DateTime.now().setZone('America/Toronto');
    const range = `from=${today.minus({ days: 1 }).toISODate()}&to=${today.plus({ days: 1 }).toISODate()}`;
    const res = await t.app.inject({ method: 'GET', url: `/v1/analytics/agents?${range}`, headers: authHeaders(org.token) });
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d).toMatchObject({ uniqueContacts: 2, actionsTriggered: 1, appointmentsBooked: 0, interval: 'day', minutesPerReply: 2 });
    expect(d.aiReplies).toBeGreaterThanOrEqual(3);
    expect(d.timeSavedMinutes).toBe(d.aiReplies * 2);
    expect(d.series).toHaveLength(3);
    expect(d.series.reduce((n: number, b: { contacts: number }) => n + b.contacts, 0)).toBe(2);

    const other = await t.app.inject({ method: 'GET', url: `/v1/analytics/agents?${range}&botId=${crypto.randomUUID()}`, headers: authHeaders(org.token) });
    expect(other.json()).toMatchObject({ uniqueContacts: 0, actionsTriggered: 0 });
    const own = await t.app.inject({ method: 'GET', url: `/v1/analytics/agents?${range}&botId=${org.bot.id}&channel=webchat`, headers: authHeaders(org.token) });
    expect(own.json()).toMatchObject({ uniqueContacts: 2, actionsTriggered: 1 });
    expect((await t.app.inject({ method: 'GET', url: `/v1/analytics/agents?${range}&channel=api`, headers: authHeaders(org.token) })).json().uniqueContacts).toBe(0);
  });
});

describe('custom values in the prompt', () => {
  it('fills {business_name} and friends from the bot, and an unset one reads "not set"', async () => {
    const org = await createOrg(t.c, 'Values Co');
    const res = await patchBot(org, {
      config: {
        instructions: 'You work for {business_name} as {agent_name}. Hours: {business_hours}. Site: {business_website}. Keep {unknown} as is.',
        persona: { ...org.bot.config.persona, companyName: 'Bright Smile Dental', assistantName: 'Ava' },
        business: { ...org.bot.config.business, website: 'https://brightsmile.example', hours: '' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const preview = (await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json();
    expect(preview.system).toContain('You work for Bright Smile Dental as Ava. Hours: not set. Site: https://brightsmile.example. Keep {unknown} as is.');
  });
});
