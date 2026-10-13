import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * Appointment Booking's Advanced Options (GHL): only send the booking link, pause the bot after booking, trigger
 * workflows after booking, and transfer the conversation to a team member after booking. Each follow-up runs once per
 * new booking, never for a slot the customer already held.
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
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
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

const patchBooking = (org: Org, booking: Record<string, unknown>) =>
  t.app.inject({
    method: 'PATCH',
    url: `/v1/bots/${org.bot.id}`,
    headers: authHeaders(org.token),
    payload: { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'], ...booking } } },
  });

async function booker(name: string, booking: Record<string, unknown> = {}) {
  const org = await createOrg(t.c, name);
  const res = await patchBooking(org, booking);
  expect(res.statusCode, res.body).toBe(200);
  return org;
}

async function say(org: Org, visitor: string, content: string, ...turns: Array<ReturnType<typeof tools> | ReturnType<typeof text>>) {
  t.llm.setScript([...turns, text('(unscripted reply)')]);
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

const bookAt = (start: string) => ({ name: 'book_appointment', input: { start, customer_confirmed: true } });
const bookTurn = (name: string, start = '2026-09-29T10:00') => tools({ name: 'save_contact_details', input: { name } }, bookAt(start));
const toolsOf = async (org: Org) =>
  ((await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: authHeaders(org.token) })).json() as { tools: Array<{ name: string }> }).tools.map((x) => x.name);
const conversationRow = async (org: Org, id: string) =>
  (await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, id))))[0]!;

async function addWorkflow(org: Org, key: string, extra: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/workflows',
    headers: authHeaders(org.token),
    payload: { key, name: 'Booking follow-up', description: 'Runs after a booking.', url: `${receiverUrl}/${key}`, mode: 'request_response', ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function addMember(org: Org, name: string) {
  const email = `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`;
  const res = await t.app.inject({ method: 'POST', url: '/v1/members', headers: authHeaders(org.token), payload: { email, role: 'agent', name, password: 'member-password-1' } });
  expect(res.statusCode, res.body).toBe(201);
  const members = (await t.app.inject({ method: 'GET', url: '/v1/members', headers: authHeaders(org.token) })).json() as Array<{ userId: string; email: string }>;
  return members.find((m) => m.email === email)!.userId;
}

describe('saving the advanced options', () => {
  it('are all off for existing bots', async () => {
    const org = await createOrg(t.c, 'Defaults Co');
    expect(org.bot.config.booking).toMatchObject({
      linkOnly: false,
      bookingLink: '',
      pauseAfterBooking: false,
      triggerWorkflows: false,
      workflowKeys: [],
      transferEmployee: false,
      transferUserId: null,
    });
  });

  it('refuses a checked option that is missing what it needs', async () => {
    const org = await createOrg(t.c, 'Validation Co');
    expect((await patchBooking(org, { linkOnly: true })).statusCode).toBe(400);
    expect((await patchBooking(org, { linkOnly: true, bookingLink: 'not a link' })).statusCode).toBe(400);
    expect((await patchBooking(org, { triggerWorkflows: true })).statusCode).toBe(400);
    expect((await patchBooking(org, { triggerWorkflows: true, workflowKeys: ['nope'] })).statusCode).toBe(400);
    expect((await patchBooking(org, { transferEmployee: true })).statusCode).toBe(400);
    expect((await patchBooking(org, { transferEmployee: true, transferUserId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    // Unchecked, a leftover choice is kept and does nothing.
    expect((await patchBooking(org, { linkOnly: false, bookingLink: 'https://example.com/book' })).statusCode).toBe(200);
  });
});

describe("don't book, only send the booking link", () => {
  it('drops the booking tools, keeps changes and cancellations, and gives the assistant the link', async () => {
    const org = await booker('Link Co', { linkOnly: true, bookingLink: 'https://example.com/book-now' });
    const names = await toolsOf(org);
    expect(names).not.toContain('book_appointment');
    expect(names).not.toContain('check_availability');
    expect(names).toEqual(expect.arrayContaining(['list_my_appointments', 'reschedule_appointment', 'cancel_appointment']));

    await say(org, 'link-1', 'I want to book a consultation', text('Here is our booking link: https://example.com/book-now'));
    const system = t.llm.requests[0]!.system;
    expect(system).toContain('send them this booking link so they can pick a time and book: https://example.com/book-now');
    expect(system).toMatch(/never say an appointment is booked/);
    expect(system).not.toMatch(/Call check_availability before proposing/);
  });
});

describe('after the assistant books', () => {
  it('pause bot: the confirmation goes out, then the assistant stays quiet', async () => {
    const org = await booker('Pause Co', { pauseAfterBooking: true });
    const r = await say(org, 'pause-1', 'Robin here, Tuesday 10am please', bookTurn('Robin'), text('Booked for Tuesday at 10:00 AM. See you then!'));
    const booked = lastToolResults(t.llm)[1]!;
    expect(booked).toMatchObject({ isError: false, content: { booked: true, bot_paused: true } });
    const messages = (await t.c.conversations.messages(org.scope, r.conversationId)).map((m) => `${m.senderType}: ${m.content}`);
    expect(messages.at(-1)).toBe('ai: Booked for Tuesday at 10:00 AM. See you then!');
    const row = await conversationRow(org, r.conversationId);
    expect(row.status).toBe('ai_active');
    expect(row.metadata).toMatchObject({ aiStop: { scenarioName: 'Appointment booked', until: null } });

    await say(org, 'pause-1', 'thanks! one more question', text('should not be sent'));
    expect(t.llm.requests).toHaveLength(0);
  });

  it('trigger workflow: runs each chosen workflow once with the appointment, even ones the chat cannot run', async () => {
    const org = await createOrg(t.c, 'Workflow Co');
    await addWorkflow(org, 'booking_followup', {
      inputFields: [
        { name: 'appointment_time', type: 'string', required: true, description: 'When' },
        { name: 'email', type: 'string', required: false, description: 'Email', source: 'contact.email' },
      ],
    });
    expect((await patchBooking(org, { triggerWorkflows: true, workflowKeys: ['booking_followup'] })).statusCode).toBe(200);
    // Not one of the chat's own workflows, so the assistant can't run it itself.
    expect(await toolsOf(org)).not.toContain('trigger_workflow');

    received.length = 0;
    await say(org, 'wf-1', 'Sam, Tuesday 10am', bookTurn('Sam'), text('Booked!'));
    expect(lastToolResults(t.llm)[1]).toMatchObject({ isError: false, content: { booked: true } });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ url: '/booking_followup', body: { workflow: 'booking_followup', inputs: { appointment_time: expect.stringContaining('10:00 AM') } } });

    // The same slot asked for again is the same booking: nothing runs twice.
    await say(org, 'wf-1', 'Book Tuesday 10am for me', tools(bookAt('2026-09-29T10:00')), text('You already have that time.'));
    expect(lastToolResults(t.llm)[0]).toMatchObject({ content: { already_booked: true } });
    expect(received).toHaveLength(1);
  });

  it('transfer employee: the conversation goes to the chosen member, who is told why', async () => {
    const org = await createOrg(t.c, 'Transfer Co');
    const jo = await addMember(org, 'Jo');
    expect((await patchBooking(org, { transferEmployee: true, transferUserId: jo })).statusCode).toBe(200);

    const r = await say(org, 'tr-1', 'Kim, Tuesday 10am', bookTurn('Kim'), text('Booked!'));
    expect(lastToolResults(t.llm)[1]).toMatchObject({ isError: false, content: { booked: true } });
    const row = await conversationRow(org, r.conversationId);
    // The assistant keeps the conversation; it now has an owner on the team.
    expect(row).toMatchObject({ assignedUserId: jo, status: 'ai_active' });
    const assigned = (await t.c.automation.listEvents(org.scope, { contactId: r.contactId })).find((e) => e.type === 'conversation.assigned')!;
    expect(assigned).toMatchObject({ actor: 'ai', payload: { assignedUserId: jo, reason: 'appointment_booked' } });
  });

  it('none of it happens with the options off', async () => {
    const org = await booker('Plain Co');
    received.length = 0;
    const r = await say(org, 'plain-1', 'Lee, Tuesday 10am', bookTurn('Lee'), text('Booked!'));
    const booked = lastToolResults(t.llm)[1]!;
    expect(booked.content).not.toHaveProperty('bot_paused');
    const row = await conversationRow(org, r.conversationId);
    expect(row.assignedUserId).toBeNull();
    expect(row.metadata).not.toHaveProperty('aiStop');
    expect(received).toHaveLength(0);
  });
});
