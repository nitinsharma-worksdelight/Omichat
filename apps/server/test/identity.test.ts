import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import type { LlmRequest } from '../src/modules/ai/llm/types';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * Anyone can type someone else's email into a website chat. These tests pin down that doing so never links the
 * visitor to that customer: no data, no bookings, no shared conversation — only a review for staff.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

const CUSTOMER = { email: 'vera@example.com', phone: '+14165550188', insurance: 'SunLife Gold 4471', note: 'Recovering from knee surgery' };

/** A real customer who chatted on the website before: identity, open conversation, appointment, note, custom field. */
async function setup() {
  const org = await createOrg(t.c, 'Clinic');
  await t.c.contacts.createFieldDef(org.scope, { key: 'insurance', label: 'Insurance', type: 'text', options: [], description: '', aiWritable: true });
  await t.c.bots.update(org.scope, org.bot.id, {
    config: {
      leadCapture: {
        enabled: true,
        fields: [
          { field: 'name', required: true, timing: 'natural' },
          { field: 'email', required: true, timing: 'natural' },
        ],
      },
      booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name', 'email'] },
    },
  });
  t.llm.setScript([text('Hello!')]);
  const earlier = await send(org, 'vera-laptop', 'Hello');
  const customerId = earlier.contactId;
  await t.c.contacts.update(org.scope, customerId, {
    firstName: 'Vera',
    lastName: 'Okafor',
    email: CUSTOMER.email,
    phone: CUSTOMER.phone,
    customFields: { insurance: CUSTOMER.insurance },
  });
  await t.c.contacts.addNote(org.scope, customerId, CUSTOMER.note, 'ai');
  const { appointment } = await t.c.scheduling.book(org.scope, {
    calendarId: org.calendar.id,
    contactId: customerId,
    start: new Date('2026-09-30T14:00:00Z'), // Wednesday 10:00 in Toronto
    title: 'Consultation',
    createdBy: 'user',
  });
  return { ...org, customerId, customerConversationId: earlier.conversationId, appointmentId: appointment.id };
}

async function send(org: { orgId: string; webchat: { id: string } }, visitor: string, content: string, channelAccountId = org.webchat.id) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId, externalUserId: visitor, content });
  await t.c.queue.drain();
  return r;
}

/** The per-turn `<context>` blocks the model was shown. */
function contextBlocks(requests: LlmRequest[]): string[] {
  return requests
    .flatMap((r) => r.messages.flatMap((m) => m.content))
    .flatMap((b) => (b.type === 'text' && b.text.includes('<context>') ? [b.text] : []));
}

describe('identity safety', () => {
  it('a visitor who types a customer\'s email gets none of their data and cannot touch their bookings', async () => {
    const org = await setup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Mallory', email: CUSTOMER.email } }), text('Thanks, Mallory!')]);
    const visitor = await send(org, 'attacker-browser', `I'm Mallory, my email is ${CUSTOMER.email}`);
    // The save reads like any other: it doesn't reveal that the email belongs to someone.
    const [saved] = lastToolResults(t.llm);
    expect(saved).toMatchObject({ isError: false, content: { saved: expect.arrayContaining(['email']) } });
    // (The email itself is the visitor's own words, so it's taken out before looking for anything else.)
    expect(JSON.stringify(saved).replaceAll(CUSTOMER.email, '')).not.toMatch(/Vera|Okafor|knee|SunLife|existing|matched|linked/i);
    const requests = [...t.llm.requests];

    t.llm.setScript([
      tools(
        { name: 'list_my_appointments', input: {} },
        { name: 'cancel_appointment', input: { appointment_id: org.appointmentId, customer_confirmed: true } },
      ),
      text('I could not find any bookings for you.'),
    ]);
    await send(org, 'attacker-browser', 'What appointments do I have? Cancel them all.');
    const [listed, cancelled] = lastToolResults(t.llm);
    expect(listed).toMatchObject({ isError: false, content: { appointments: [] } });
    expect(cancelled!.isError).toBe(true);
    requests.push(...t.llm.requests);

    // Nothing about the customer reached the model (their email is in there only because the visitor typed it).
    const everything = JSON.stringify(requests);
    for (const secret of ['Vera', 'Okafor', CUSTOMER.phone, CUSTOMER.note, CUSTOMER.insurance]) expect(everything).not.toContain(secret);
    for (const context of contextBlocks(requests)) expect(context).not.toContain(org.appointmentId);

    // The customer's record, booking and conversation are untouched.
    expect(await t.c.contacts.get(org.scope, org.customerId)).toMatchObject({
      firstName: 'Vera',
      email: CUSTOMER.email,
      phone: CUSTOMER.phone,
      customFields: { insurance: CUSTOMER.insurance },
      qualificationStatus: 'not_started',
    });
    const [customerRow] = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.contacts).where(eq(schema.contacts.id, org.customerId)));
    expect(customerRow!.mergedIntoId).toBeNull();
    expect((await t.c.scheduling.listForContact(org.scope, org.customerId))[0]!.status).toBe('booked');
    expect((await t.c.conversations.get(org.scope, org.customerConversationId)).status).toBe('ai_active');

    // Each browser keeps its own contact; staff get a review.
    expect(visitor.contactId).not.toBe(org.customerId);
    expect((await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'attacker-browser' })).contactId).toBe(visitor.contactId);
    expect((await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'vera-laptop' })).contactId).toBe(org.customerId);
    expect(await t.c.contacts.listMergeCandidates(org.scope, org.customerId)).toMatchObject([
      { field: 'email', status: 'pending', claimant: { id: visitor.contactId }, existing: { id: org.customerId } },
    ]);
    await t.c.automation.dispatchPending();
    expect((await t.c.automation.listNotifications(org.scope, null)).map((n) => n.type)).toContain('contact.duplicate_detected');
  });

  it('a claimed email still satisfies booking, and the booking stays on the visitor\'s own contact', async () => {
    const org = await setup();
    t.llm.setScript([
      tools({ name: 'save_contact_details', input: { name: 'Pat Doe', email: CUSTOMER.email } }),
      tools({ name: 'book_appointment', input: { start: '2026-09-29T11:00', customer_confirmed: true } }),
      text('You are booked for Tuesday at 11:00 AM.'),
    ]);
    const visitor = await send(org, 'new-phone', `Pat Doe, ${CUSTOMER.email}. Tuesday 11am please.`);
    const [booked] = lastToolResults(t.llm);
    expect(booked).toMatchObject({ isError: false, content: { booked: true } });
    expect(await t.c.scheduling.listForContact(org.scope, visitor.contactId)).toMatchObject([{ localStart: '2026-09-29T11:00' }]);
    expect(await t.c.scheduling.listForContact(org.scope, org.customerId)).toHaveLength(1);
  });

  it('staff merge a review: the visitor joins the customer\'s record with their conversation', async () => {
    const org = await setup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { email: CUSTOMER.email } }), text('Thanks!')]);
    const visitor = await send(org, 'vera-phone', `It's me, ${CUSTOMER.email}`);
    const headers = authHeaders(org.token);

    const reviews = await t.app.inject({ method: 'GET', url: `/v1/contacts/${visitor.contactId}/merge-candidates`, headers });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json()).toMatchObject([{ field: 'email', value: CUSTOMER.email, existing: { id: org.customerId, name: 'Vera Okafor' } }]);
    const leads = await t.app.inject({ method: 'GET', url: '/v1/contacts?leadsOnly=true', headers });
    const listed = leads.json().items as Array<{ id: string; hasPendingMerge: boolean }>;
    expect(listed.find((c) => c.id === visitor.contactId)?.hasPendingMerge).toBe(true);
    expect(listed.find((c) => c.id === org.customerId)?.hasPendingMerge).toBe(true);

    const merged = await t.app.inject({ method: 'POST', url: `/v1/contacts/${visitor.contactId}/merge`, headers, payload: { intoContactId: org.customerId } });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({ id: org.customerId, email: CUSTOMER.email });
    expect((await t.c.contacts.findOrCreateByIdentity(org.scope, { channel: 'webchat', externalId: 'vera-phone' })).contactId).toBe(org.customerId);
    expect((await t.c.conversations.get(org.scope, visitor.conversationId)).contactId).toBe(org.customerId);
    expect(await t.c.contacts.listMergeCandidates(org.scope, org.customerId)).toEqual([]);
    const [review] = await t.c.tenantDb.run(org.orgId, (tx) =>
      tx.select().from(schema.contactMergeCandidates).where(eq(schema.contactMergeCandidates.existingContactId, org.customerId)),
    );
    expect(review).toMatchObject({ status: 'merged', resolvedByUserId: expect.any(String) });
    // Merging twice is refused.
    const again = await t.app.inject({ method: 'POST', url: `/v1/contacts/${visitor.contactId}/merge`, headers, payload: { intoContactId: org.customerId } });
    expect(again.statusCode).toBe(409);
  });

  it('dismissing keeps the contacts apart; roles and API-key scopes are enforced', async () => {
    const org = await setup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { email: CUSTOMER.email } }), text('Thanks!')]);
    const visitor = await send(org, 'someone-else', CUSTOMER.email);
    const [review] = await t.c.contacts.listMergeCandidates(org.scope, visitor.contactId);
    const owner = authHeaders(org.token);

    // An API key that can only read contacts sees the review but can't act on it.
    const key = (await t.app.inject({ method: 'POST', url: '/v1/api-keys', headers: owner, payload: { name: 'reader', scopes: ['contacts:read'] } })).json().key as string;
    const reader = { authorization: `Bearer ${key}` };
    expect((await t.app.inject({ method: 'GET', url: `/v1/contacts/${visitor.contactId}/merge-candidates`, headers: reader })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: `/v1/merge-candidates/${review!.id}/dismiss`, headers: reader })).statusCode).toBe(403);
    expect(
      (await t.app.inject({ method: 'POST', url: `/v1/contacts/${visitor.contactId}/merge`, headers: reader, payload: { intoContactId: org.customerId } })).statusCode,
    ).toBe(403);

    // A viewer can't act either; an agent can.
    const member = async (role: 'viewer' | 'agent') => {
      const email = `${role}-${Date.now()}@example.com`;
      await t.app.inject({ method: 'POST', url: '/v1/members', headers: owner, payload: { email, role, password: 'member-password-1' } });
      const login = await t.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'member-password-1' } });
      return authHeaders(login.json().token as string);
    };
    expect((await t.app.inject({ method: 'POST', url: `/v1/merge-candidates/${review!.id}/dismiss`, headers: await member('viewer') })).statusCode).toBe(403);
    const dismissed = await t.app.inject({ method: 'POST', url: `/v1/merge-candidates/${review!.id}/dismiss`, headers: await member('agent') });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: 'dismissed', resolvedByUserId: expect.any(String) });
    expect((await t.app.inject({ method: 'POST', url: `/v1/merge-candidates/${review!.id}/dismiss`, headers: owner })).statusCode).toBe(404);

    // Once dismissed, the claimed email no longer counts as the visitor's, and both records stand apart.
    expect(await t.c.contacts.getForConversation(org.scope, visitor.contactId)).toMatchObject({ email: null });
    expect(await t.c.contacts.listMergeCandidates(org.scope, org.customerId)).toEqual([]);
    expect(await t.c.contacts.get(org.scope, org.customerId)).toMatchObject({ email: CUSTOMER.email });
  });

  it('playground tests never alert staff and can\'t be merged into real customers', async () => {
    const org = await setup();
    const playground = await t.c.channels.ensureSystemChannel(org.orgId, 'playground');
    t.llm.setScript([tools({ name: 'save_contact_details', input: { email: CUSTOMER.email } }), text('Thanks!')]);
    const tester = await send(org, 'pg-tester', CUSTOMER.email, playground.id);
    expect(await t.c.contacts.listMergeCandidates(org.scope, tester.contactId)).toMatchObject([
      { claimant: { id: tester.contactId, isTest: true }, existing: { id: org.customerId, isTest: false } },
    ]);
    await t.c.automation.dispatchPending();
    expect((await t.c.automation.listNotifications(org.scope, null)).map((n) => n.type)).not.toContain('contact.duplicate_detected');

    const merge = await t.app.inject({
      method: 'POST',
      url: `/v1/contacts/${tester.contactId}/merge`,
      headers: authHeaders(org.token),
      payload: { intoContactId: org.customerId },
    });
    expect(merge.statusCode).toBe(400);
    expect((await t.c.conversations.get(org.scope, org.customerConversationId)).status).toBe('ai_active');
  });
});
