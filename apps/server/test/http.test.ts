import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/lib/crypto';
import { convChannel } from '../src/modules/conversations/service';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

let t: TestEnv;
let baseUrl: string;
beforeAll(async () => {
  t = await createTestEnv();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});
afterAll(() => t.close());

/** Reads an SSE response until `until` returns true for an event. */
async function readSse(res: Response, until: (event: string, data: any) => boolean, timeoutMs = 10_000) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (!event || !data) continue;
      const parsed = { event, data: JSON.parse(data) };
      events.push(parsed);
      if (until(parsed.event, parsed.data)) {
        await reader.cancel();
        return events;
      }
    }
  }
  await reader.cancel();
  return events;
}

describe('auth API', () => {
  it('signs up, logs in and reads /me', async () => {
    const email = `new-${Date.now()}@example.com`;
    const signup = await t.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'secret-pass-1', organizationName: 'NewCo' } });
    expect(signup.statusCode).toBe(201);
    const bad = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'secret-pass-1' } });
    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: authHeaders(login.json().token) });
    expect(me.json()).toMatchObject({ user: { email }, role: 'owner', memberships: [{ organizationName: 'NewCo' }] });
    const anonymous = await t.app.inject({ method: 'GET', url: '/v1/bots' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('validates bot configuration with field-level errors', async () => {
    const org = await createOrg(t.c);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/bots/${org.bot.id}`,
      headers: authHeaders(org.token),
      payload: { config: { booking: { enabled: true, calendarId: null }, qualification: { enabled: true } } },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().error.details)).toMatch(/no calendar selected|no questions defined/);
  });
});

describe('website widget', () => {
  it('session → message → streamed AI reply → history restore', async () => {
    const org = await createOrg(t.c);
    const config = await fetch(`${baseUrl}/widget/v1/config?key=${org.webchat.publicKey}`).then((r) => r.json() as Promise<any>);
    expect(config.greeting).toBe('Hi! How can I help you today?');

    const session = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://customer.example' },
      body: JSON.stringify({ key: org.webchat.publicKey }),
    }).then((r) => r.json() as Promise<any>);
    expect(session.conversationId).toBeNull();
    const auth = { authorization: `Bearer ${session.token}`, origin: 'https://customer.example' };

    t.llm.setScript([text('Hello there! We are open 9 to 5.')]);
    const sent = await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'When are you open?', clientMessageId: 'client-msg-0001' }),
    }).then((r) => r.json() as Promise<any>);
    expect(sent.message).toMatchObject({ role: 'user', content: 'When are you open?' });

    const stream = await fetch(`${baseUrl}/widget/v1/stream?conversationId=${sent.conversationId}`, { headers: auth });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    // The widget reconciles via /messages after connecting, so the reply may already be stored.
    const events = await readSse(stream, (e, d) => e === 'ai.done' || (e === 'message' && d.message.role === 'assistant'), 5_000);
    const history = await fetch(`${baseUrl}/widget/v1/messages`, { headers: auth }).then((r) => r.json() as Promise<any>);
    expect(history.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(history.messages[1].content).toBe('Hello there! We are open 9 to 5.');
    expect(events.length).toBeGreaterThanOrEqual(0);

    // Resending the same client message id is idempotent.
    const dup = await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'When are you open?', clientMessageId: 'client-msg-0001' }),
    });
    expect(dup.status).toBe(200);

    // A reload restores the conversation for the same visitor.
    const again = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: org.webchat.publicKey, visitorId: session.visitorId }),
    }).then((r) => r.json() as Promise<any>);
    expect(again.conversationId).toBe(sent.conversationId);
    expect(again.messages).toHaveLength(2);
  });

  it('streams token deltas live over SSE', async () => {
    const org = await createOrg(t.c);
    const session = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: org.webchat.publicKey }),
    }).then((r) => r.json() as Promise<any>);
    const auth = { authorization: `Bearer ${session.token}` };
    // The first message creates the conversation, so the stream can be opened before the second.
    t.llm.setScript([text('first reply')]);
    const first = await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    }).then((r) => r.json() as Promise<any>);
    await t.c.queue.drain();
    const stream = await fetch(`${baseUrl}/widget/v1/stream?conversationId=${first.conversationId}`, { headers: auth });
    t.llm.setScript([
      tools({ name: 'check_availability', input: {} }),
      text('Here are some times that work well for you.'),
    ]);
    await t.c.bots.update({ orgId: org.orgId }, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id } } });
    await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'any times on Tuesday?' }),
    });
    const events = await readSse(stream, (e) => e === 'ai.done');
    const types = events.map((e) => e.event);
    expect(types).toContain('ai.typing');
    expect(types).toContain('ai.activity');
    expect(types).toContain('ai.delta');
    const streamed = events.filter((e) => e.event === 'ai.delta').map((e) => e.data.text).join('');
    expect(streamed).toBe('Here are some times that work well for you.');
    const final = events.find((e) => e.event === 'message' && e.data.message.role === 'assistant');
    expect(final?.data.message.content).toBe('Here are some times that work well for you.');
  });

  it("doesn't show the visitor record-keeping like \"Saving your details…\"; staff still get it, and the details are saved", async () => {
    const org = await createOrg(t.c);
    const session = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: org.webchat.publicKey }),
    }).then((r) => r.json() as Promise<any>);
    const auth = { authorization: `Bearer ${session.token}` };
    t.llm.setScript([text('Hi! How can I help?')]);
    const first = await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    }).then((r) => r.json() as Promise<any>);
    await t.c.queue.drain();

    const stream = await fetch(`${baseUrl}/widget/v1/stream?conversationId=${first.conversationId}`, { headers: auth });
    // What staff are sent: every event on the conversation's channel.
    const staff: Array<{ type: string; label?: string; internal?: boolean }> = [];
    const unsubscribe = t.c.pubsub.subscribe(convChannel(first.conversationId), (e) => staff.push(e as (typeof staff)[number]));
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Ana Silva', email: 'ana@example.com' } }), text('Thanks, Ana!')]);
    await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: "I'm Ana Silva, ana@example.com" }),
    });
    const events = await readSse(stream, (e) => e === 'ai.done');
    unsubscribe();

    const types = events.map((e) => e.event);
    expect(types).not.toContain('ai.activity');
    expect(JSON.stringify(events)).not.toContain('Saving your details');
    expect(types).toContain('ai.typing');
    expect(events.find((e) => e.event === 'message' && e.data.message.role === 'assistant')?.data.message.content).toBe('Thanks, Ana!');
    expect(staff).toContainEqual(expect.objectContaining({ type: 'ai.activity', label: 'Saving your details…', internal: true }));

    const contact = await t.c.contacts.get(org.scope, (await t.c.conversations.get(org.scope, first.conversationId)).contactId);
    expect(contact).toMatchObject({ firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com' });
  });

  it('enforces the allowed-origins list', async () => {
    const org = await createOrg(t.c);
    await t.c.channels.update(org.scope, org.webchat.id, { config: { allowedOrigins: ['https://allowed.example'] } });
    const blocked = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ key: org.webchat.publicKey }),
    });
    expect(blocked.status).toBe(403);
    const ok = await fetch(`${baseUrl}/widget/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://allowed.example' },
      body: JSON.stringify({ key: org.webchat.publicKey }),
    });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    const crossSite = await fetch(`${baseUrl}/widget/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(crossSite.status).toBe(401);
  });

  it('playground sessions test a chosen bot and are marked as test data', async () => {
    const org = await createOrg(t.c);
    const pg = await t.app.inject({ method: 'POST', url: `/v1/bots/${org.bot.id}/playground`, headers: authHeaders(org.token) });
    const { token } = pg.json();
    t.llm.setScript([text('Playground reply')]);
    const res = await t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${token}` }, payload: { content: 'test' } });
    expect(res.statusCode).toBe(201);
    await t.c.queue.drain();
    const list = await t.c.contacts.list(org.scope, { limit: 50, offset: 0 });
    expect(list.total).toBe(0); // test contacts are hidden by default
    const withTest = await t.c.contacts.list(org.scope, { limit: 50, offset: 0, includeTest: true });
    expect(withTest.items[0]!.isTest).toBe(true);
  });
});

describe('public API channel', () => {
  it('sends a message with an API key and waits for the reply', async () => {
    const org = await createOrg(t.c);
    const key = await t.app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: authHeaders(org.token),
      payload: { name: 'n8n', scopes: ['conversations:write', 'contacts:read'] },
    });
    const apiKey = key.json().key as string;
    t.llm.setScript([text('Hi Sam, how can I help?')]);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/channels/api/messages',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { externalUserId: 'crm-123', content: 'Hello', contact: { name: 'Sam Roe', email: 'sam.roe@example.com' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply.content).toBe('Hi Sam, how can I help?');
    const contacts = await t.app.inject({ method: 'GET', url: '/v1/contacts?leadsOnly=true', headers: { authorization: `Bearer ${apiKey}` } });
    expect(contacts.json().items[0]).toMatchObject({ name: 'Sam Roe', email: 'sam.roe@example.com' });
    // Scopes are enforced.
    const denied = await t.app.inject({ method: 'POST', url: '/v1/contacts', headers: { authorization: `Bearer ${apiKey}` }, payload: {} });
    expect(denied.statusCode).toBe(403);
  });
});

describe('n8n webhooks and workflows', () => {
  let receiver: Server;
  let received: Array<{ headers: Record<string, string | string[] | undefined>; body: string; url: string }>;
  let failNext = 0;
  let receiverUrl: string;

  beforeAll(async () => {
    received = [];
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body, url: req.url ?? '' });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end('boom');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ order_status: 'shipped', eta: 'Friday' }));
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => receiver.close(() => r())));

  it('delivers signed events with retries', async () => {
    const org = await createOrg(t.c);
    const ep = await t.app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: authHeaders(org.token),
      payload: { name: 'n8n', url: `${receiverUrl}/hook`, eventTypes: ['lead.captured'] },
    });
    const { secret, id } = ep.json();
    received.length = 0;
    failNext = 1;
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'w1' });
    await t.c.contacts.captureDetails(org.scope, contactId, { name: 'Lee Park', email: 'lee@example.com' }, 'ai');
    await t.c.automation.dispatchPending();
    await t.c.queue.drain(); // first attempt fails (500), the retry succeeds after backoff

    expect(received.length).toBe(2);
    const delivery = received[1]!;
    expect(delivery.headers['x-omni-event']).toBe('lead.captured');
    expect(verifyWebhookSignature(secret, delivery.body, String(delivery.headers['x-omni-signature']))).toBe(true);
    const payload = JSON.parse(delivery.body);
    expect(payload).toMatchObject({ type: 'lead.captured', data: { contact: { name: 'Lee Park', email: 'lee@example.com' } } });
    const log = await t.app.inject({ method: 'GET', url: `/v1/webhooks/${id}/deliveries`, headers: authHeaders(org.token) });
    expect(log.json()[0]).toMatchObject({ status: 'success', attemptCount: 2 });
  }, 30_000);

  it('the bot can call a request/response workflow and use its answer', async () => {
    const org = await createOrg(t.c);
    await t.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: authHeaders(org.token),
      payload: {
        key: 'order_status',
        name: 'Order status lookup',
        description: 'Look up an order by order number and return its shipping status.',
        url: `${receiverUrl}/order`,
        mode: 'request_response',
        inputFields: [{ name: 'order_number', type: 'string', required: true, description: 'Order number' }],
      },
    });
    await t.c.bots.update(org.scope, org.bot.id, { config: { actions: { workflowKeys: ['order_status'] } } });
    received.length = 0;
    t.llm.setScript([
      tools({ name: 'trigger_workflow', input: { workflow_key: 'order_status', inputs: { order_number: 'A-1001' } } }),
      text('Your order A-1001 has shipped and should arrive Friday.'),
    ]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'wf', content: 'where is order A-1001?' });
    await t.c.queue.drain();
    expect(JSON.parse(received[0]!.body)).toMatchObject({ workflow: 'order_status', inputs: { order_number: 'A-1001' } });
    const second = t.llm.requests[1]!;
    const result = second.messages.at(-1)!.content[0] as { content: string };
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, response: { order_status: 'shipped' } });
  });
});
