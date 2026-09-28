import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../src/lib/crypto';
import { authHeaders, createOrg, createTestEnv, text, tools, type TestEnv } from './helpers';

/**
 * F4a — Integrations. Every message meant for a customer of the chat API reaches the integration (a webhook, the
 * waiting request, polling), and API keys reach notes, tasks, tags, field definitions, conversations and
 * appointments with the matching scopes. Staff-only actions stay staff-only.
 */

let t: TestEnv;
let receiver: Server;
let receiverUrl: string;
const received: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  t = await createTestEnv();
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200).end('ok');
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
const OPT_IN = 'Can we email you occasional offers? Reply yes or no.';
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function newKey(org: Org, scopes: string[]) {
  const res = await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: authHeaders(org.token), payload: { name: `key-${scopes.join('+')}`, scopes } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; key: string };
}

/** A clinic whose bot asks the marketing opt-in question, with a webhook endpoint for `message.outbound`. */
async function clinic(name: string) {
  const org = await createOrg(t.c, name);
  await t.c.bots.update(org.scope, org.bot.id, {
    config: { leadCapture: { enabled: true, fields: [{ field: 'email', required: true, timing: 'early' }], consentNotice: '', marketingOptIn: OPT_IN } },
  });
  const path = `/${name.toLowerCase().replace(/\W+/g, '-')}`;
  const ep = await t.app.inject({ method: 'POST', url: '/v1/webhooks', headers: authHeaders(org.token), payload: { name: 'crm', url: `${receiverUrl}${path}`, eventTypes: ['message.outbound'] } });
  expect(ep.statusCode).toBe(201);
  return { org, secret: (ep.json() as { secret: string }).secret, path };
}

async function deliveriesTo(path: string) {
  await t.c.automation.dispatchPending();
  await t.c.queue.drain();
  return received.filter((r) => r.url === path);
}

const askAndReply = () => t.llm.setScript([tools({ name: 'ask_marketing_consent', input: {} }), text('Thanks, Sam! Whitening is $450.')]);

async function chat(key: string, externalUserId: string, content: string, extra: Record<string, unknown> = {}) {
  const res = await t.app.inject({ method: 'POST', url: '/v1/channels/api/messages', headers: bearer(key), payload: { externalUserId, content, ...extra } });
  await t.c.queue.drain();
  return res;
}

describe('messages to chat-API customers', () => {
  it('each one goes out as a signed message.outbound with the customer ID: the reply, the opt-in question and a staff reply', async () => {
    const { org, secret, path } = await clinic('Outbound Clinic');
    const { key } = await newKey(org, ['conversations:write']);
    askAndReply();
    const first = await chat(key, 'crm-42', 'How much is whitening?', { contact: { name: 'Sam Roe', email: 'sam@example.com' } });
    const { conversationId } = first.json() as { conversationId: string };
    await t.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers: authHeaders(org.token), payload: { content: 'Hi Sam, Maya from the front desk here.' } });

    const deliveries = await deliveriesTo(path);
    expect(deliveries).toHaveLength(3);
    for (const d of deliveries) {
      expect(d.headers['x-omni-event']).toBe('message.outbound');
      expect(verifyWebhookSignature(secret, d.body, String(d.headers['x-omni-signature']))).toBe(true);
    }
    const payloads = deliveries.map((d) => JSON.parse(d.body).data as { message: { content: string; senderType: string }; externalUserId: string; conversation_id: string });
    expect(payloads.map((p) => p.message.content).sort()).toEqual(['Hi Sam, Maya from the front desk here.', OPT_IN, 'Thanks, Sam! Whitening is $450.'].sort());
    expect(payloads.find((p) => p.message.content.startsWith('Hi Sam'))!.message.senderType).toBe('human');
    for (const p of payloads) {
      expect(p.externalUserId).toBe('crm-42');
      expect(p.conversation_id).toBe(conversationId);
    }

    // They're for webhooks: the conversation's timeline and the activity feed don't repeat every message.
    const timeline = await t.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/timeline`, headers: authHeaders(org.token) });
    expect(timeline.json().events.map((e: { type: string }) => e.type)).not.toContain('message.outbound');
    const activity = await t.app.inject({ method: 'GET', url: '/v1/events', headers: authHeaders(org.token) });
    expect(activity.json().map((e: { type: string }) => e.type)).not.toContain('message.outbound');

    // The widget shows its own messages: web chat sends none.
    t.llm.setScript([text('Hello!')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'web-visitor', content: 'Hi' });
    await t.c.queue.drain();
    expect(await deliveriesTo(path)).toHaveLength(3);
  });

  it('the waiting request returns every message of the turn, and a handoff returns straight away', async () => {
    const { org } = await clinic('Waiting Clinic');
    const { key } = await newKey(org, ['conversations:write']);
    askAndReply();
    const res = await chat(key, 'crm-7', 'How much is whitening?', { contact: { name: 'Sam Roe', email: 'sam7@example.com' } });
    const body = res.json() as { reply: { content: string }; replies: Array<{ content: string }> };
    expect(body.reply.content).toBe('Thanks, Sam! Whitening is $450.');
    expect(body.replies.map((m) => m.content)).toEqual(['Thanks, Sam! Whitening is $450.', OPT_IN]);

    const started = Date.now();
    const handoff = await chat(key, 'crm-8', 'Can I talk to a human please?');
    expect(Date.now() - started).toBeLessThan(2500);
    expect((handoff.json() as { replies: Array<{ content: string }> }).replies.map((m) => m.content)).toEqual([
      "I'm connecting you with a member of our team. They'll reply here as soon as possible.",
    ]);
  });

  it("polling returns the customer's messages after a given one, and never someone else's", async () => {
    const { org } = await clinic('Polling Clinic');
    const { key } = await newKey(org, ['conversations:write']);
    askAndReply();
    const first = await chat(key, 'crm-42', 'How much is whitening?', { contact: { name: 'Sam Roe', email: 'sam@example.com' } });
    const { conversationId, message } = first.json() as { conversationId: string; message: { id: string } };
    await t.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers: authHeaders(org.token), payload: { content: 'Hi Sam, Maya here.' } });

    const poll = (k: string, externalUserId: string, after?: string) =>
      t.app.inject({ method: 'GET', url: `/v1/channels/api/messages?externalUserId=${externalUserId}${after ? `&after=${after}` : ''}`, headers: bearer(k) });
    const res = await poll(key, 'crm-42', message.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversationId: string; status: string; messages: Array<{ id: string; content: string; direction: string; senderType: string }> };
    expect(body).toMatchObject({ conversationId, status: 'human_active' });
    expect(body.messages.map((m) => [m.direction, m.senderType, m.content])).toEqual([
      ['outbound', 'ai', 'Thanks, Sam! Whitening is $450.'],
      ['outbound', 'ai', OPT_IN],
      ['outbound', 'human', 'Hi Sam, Maya here.'],
    ]);
    // Nothing newer after the last one, and a closed conversation can still be read.
    await t.app.inject({ method: 'POST', url: `/v1/conversations/${conversationId}/status`, headers: authHeaders(org.token), payload: { action: 'close' } });
    const after = await poll(key, 'crm-42', body.messages.at(-1)!.id);
    expect(after.json()).toMatchObject({ conversationId, status: 'closed', messages: [] });

    // Another customer, another organization, a key without the chat scope.
    expect((await poll(key, 'crm-unknown')).json()).toEqual({ conversationId: null, status: null, messages: [] });
    const other = await clinic('Other Polling Clinic');
    const otherKey = await newKey(other.org, ['conversations:write']);
    expect((await poll(otherKey.key, 'crm-42')).json()).toMatchObject({ conversationId: null, messages: [] });
    const readOnly = await newKey(org, ['contacts:read']);
    expect((await poll(readOnly.key, 'crm-42')).statusCode).toBe(403);
  });
});

describe('API access', () => {
  it('the contact scopes reach notes, tasks, tags and custom-field definitions; changing definitions stays with staff', async () => {
    const org = await createOrg(t.c, 'Records Clinic');
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'api', externalId: 'crm-records' });
    const read = (await newKey(org, ['contacts:read'])).key;
    const write = (await newKey(org, ['contacts:read', 'contacts:write'])).key;
    for (const url of ['/v1/tags', `/v1/contacts/${contactId}/notes`, `/v1/tasks?contactId=${contactId}`, '/v1/custom-fields']) {
      expect((await t.app.inject({ method: 'GET', url, headers: bearer(read) })).statusCode, url).toBe(200);
    }
    expect((await t.app.inject({ method: 'POST', url: `/v1/contacts/${contactId}/notes`, headers: bearer(read), payload: { body: 'x' } })).statusCode).toBe(403);

    const note = await t.app.inject({ method: 'POST', url: `/v1/contacts/${contactId}/notes`, headers: bearer(write), payload: { body: 'Prefers morning calls.', shareWithAssistant: true } });
    expect(note.statusCode).toBe(201);
    expect((await t.c.contacts.get(org.scope, contactId)).memory.map((f: { text: string; source: string }) => [f.text, f.source])).toEqual([['Prefers morning calls.', 'user']]);
    const task = await t.app.inject({ method: 'POST', url: '/v1/tasks', headers: bearer(write), payload: { title: 'Call back', contactId } });
    expect(task.statusCode).toBe(201);
    const done = await t.app.inject({ method: 'PATCH', url: `/v1/tasks/${task.json().id}`, headers: bearer(write), payload: { status: 'done' } });
    expect(done.json()).toMatchObject({ status: 'done' });

    const field = await t.app.inject({ method: 'POST', url: '/v1/custom-fields', headers: bearer(write), payload: { key: 'budget', label: 'Budget', type: 'number', description: 'Their budget in dollars' } });
    expect(field.statusCode).toBe(401);
  });

  it('conversations:read reads conversations with their summary, messages, timeline and a contact’s conversations', async () => {
    const org = await createOrg(t.c, 'Reader Clinic');
    t.llm.setScript([text('Sure.')]);
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'reader', content: 'Do you do whitening?' });
    await t.c.queue.drain();
    const reader = (await newKey(org, ['conversations:read'])).key;
    const other = (await newKey(org, ['contacts:read'])).key;
    const urls = ['/v1/conversations', `/v1/conversations/${r.conversationId}`, `/v1/conversations/${r.conversationId}/messages`, `/v1/conversations/${r.conversationId}/timeline`, `/v1/contacts/${r.contactId}/conversations`];
    for (const url of urls) {
      expect((await t.app.inject({ method: 'GET', url, headers: bearer(reader) })).statusCode, url).toBe(200);
      expect((await t.app.inject({ method: 'GET', url, headers: bearer(other) })).statusCode, url).toBe(403);
    }
    expect((await t.app.inject({ method: 'GET', url: `/v1/conversations/${r.conversationId}`, headers: bearer(reader) })).json()).toHaveProperty('summaryDetails');
    // Replying as the team and the AI's run log stay with staff.
    expect((await t.app.inject({ method: 'POST', url: `/v1/conversations/${r.conversationId}/messages`, headers: bearer(reader), payload: { content: 'hi' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: `/v1/conversations/${r.conversationId}/ai-runs`, headers: bearer(reader) })).statusCode).toBe(401);
  });

  it('appointments:read and appointments:write read availability and book, move and cancel like staff', async () => {
    const org = await createOrg(t.c, 'Booking Clinic');
    const { contactId } = await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'api', externalId: 'crm-booker' });
    await t.c.contacts.update(org.scope, contactId, { firstName: 'Ana', email: 'ana@example.com' });
    const read = (await newKey(org, ['appointments:read'])).key;
    const write = (await newKey(org, ['appointments:read', 'appointments:write'])).key;

    const availability = `/v1/calendars/${org.calendar.id}/availability?from=2026-09-29&to=2026-09-30`;
    const viaKey = await t.app.inject({ method: 'GET', url: availability, headers: bearer(read) });
    const viaStaff = await t.app.inject({ method: 'GET', url: availability, headers: authHeaders(org.token) });
    expect(viaKey.statusCode).toBe(200);
    expect(viaKey.json()).toEqual(viaStaff.json());
    expect((await t.app.inject({ method: 'GET', url: '/v1/calendars', headers: bearer(read) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/v1/appointments', headers: bearer(read), payload: { calendarId: org.calendar.id, contactId, start: '2026-09-29T10:00' } })).statusCode).toBe(403);

    const booked = await t.app.inject({ method: 'POST', url: '/v1/appointments', headers: bearer(write), payload: { calendarId: org.calendar.id, contactId, start: '2026-09-29T10:00', title: 'Cleaning' } });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().customerEmail).toMatchObject({ queued: true, to: 'ana@example.com' });
    const id = booked.json().id as string;
    const moved = await t.app.inject({ method: 'POST', url: `/v1/appointments/${id}/reschedule`, headers: bearer(write), payload: { start: '2026-09-29T11:00' } });
    expect(moved.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/v1/appointments', headers: bearer(read) })).json().map((a: { id: string }) => a.id)).toContain(id);
    expect((await t.app.inject({ method: 'GET', url: `/v1/appointments/${id}/notifications`, headers: bearer(read) })).statusCode).toBe(200);
    const cancelled = await t.app.inject({ method: 'POST', url: `/v1/appointments/${id}/cancel`, headers: bearer(write), payload: { reason: 'Customer called' } });
    expect(cancelled.json()).toMatchObject({ id, status: 'cancelled', customerEmail: { queued: true } });

    // Calendars themselves stay with staff.
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/calendars/${org.calendar.id}`, headers: bearer(write), payload: { name: 'X' } })).statusCode).toBe(401);
  });

  it("admins can change a key's scopes; it applies on the next request", async () => {
    const org = await createOrg(t.c, 'Scopes Clinic');
    const { id, key } = await newKey(org, ['contacts:read']);
    expect((await t.app.inject({ method: 'GET', url: '/v1/conversations', headers: bearer(key) })).statusCode).toBe(403);
    const changed = await t.app.inject({ method: 'PATCH', url: `/v1/api-keys/${id}`, headers: authHeaders(org.token), payload: { scopes: ['contacts:read', 'conversations:read'] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ id, scopes: ['contacts:read', 'conversations:read'] });
    expect(changed.json()).not.toHaveProperty('key');
    expect((await t.app.inject({ method: 'GET', url: '/v1/conversations', headers: bearer(key) })).statusCode).toBe(200);

    expect((await t.app.inject({ method: 'PATCH', url: `/v1/api-keys/${id}`, headers: authHeaders(org.token), payload: { scopes: ['everything'] } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/api-keys/${id}`, headers: authHeaders(org.token), payload: {} })).statusCode).toBe(400);
    const email = `agent-${Date.now()}@example.com`;
    await t.app.inject({ method: 'POST', url: '/v1/members', headers: authHeaders(org.token), payload: { email, role: 'agent', password: 'member-password-1' } });
    const agent = (await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } })).json().token as string;
    expect((await t.app.inject({ method: 'PATCH', url: `/v1/api-keys/${id}`, headers: authHeaders(agent), payload: { scopes: ['contacts:read'] } })).statusCode).toBe(403);
  });
});
