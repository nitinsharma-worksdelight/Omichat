import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalStart } from '../src/modules/scheduling/availability';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

async function setup() {
  const org = await createOrg(t.c);
  const contact = await t.c.contacts.create(org.scope, { firstName: 'Pat', email: `pat${Math.random()}@example.com` });
  return { org, contact };
}

describe('appointment booking', () => {
  it('books an open slot and moves the lead to "booked"', async () => {
    const { org, contact } = await setup();
    const start = parseLocalStart('2026-09-29T10:00', 'America/Toronto')!;
    const { appointment } = await t.c.scheduling.book(org.scope, {
      calendarId: org.calendar.id,
      contactId: contact.id,
      start,
      title: 'Consultation',
      createdBy: 'ai',
    });
    expect(appointment).toMatchObject({ localStart: '2026-09-29T10:00', status: 'booked', timezone: 'America/Toronto' });
    expect((await t.c.contacts.get(org.scope, contact.id)).lifecycleStage).toBe('booked');
    const { slots } = await t.c.scheduling.availability(org.scope, org.calendar.id, { from: '2026-09-29', to: '2026-09-29' });
    expect(slots.map((s) => s.local)).not.toContain('2026-09-29T10:00');
  });

  it('never double-books under concurrent requests', async () => {
    const { org } = await setup();
    const people = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => t.c.contacts.create(org.scope, { firstName: `P${i}`, email: `p${i}-${Math.random()}@example.com` })),
    );
    const start = parseLocalStart('2026-09-30T14:00', 'America/Toronto')!;
    const results = await Promise.allSettled(
      people.map((p) => t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: p.id, start, title: 'Consult', createdBy: 'ai' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409, code: 'slot_unavailable' });
    }
  });

  it('the same contact asking again for a slot they hold gets that booking back', async () => {
    const { org, contact } = await setup();
    const start = parseLocalStart('2026-10-01T09:30', 'America/Toronto')!;
    const input = { calendarId: org.calendar.id, contactId: contact.id, start, title: 'Consult', createdBy: 'ai' as const };
    const a = await t.c.scheduling.book(org.scope, input);
    const b = await t.c.scheduling.book(org.scope, input);
    expect(a.duplicate).toBe(false);
    expect(b).toMatchObject({ duplicate: true, appointment: { id: a.appointment.id, status: 'booked' } });
    // Anyone else still can't have it.
    const other = await t.c.contacts.create(org.scope, { firstName: 'Other' });
    await expect(t.c.scheduling.book(org.scope, { ...input, contactId: other.id })).rejects.toMatchObject({ code: 'slot_unavailable' });
    const events = await t.c.automation.listEvents(org.scope, { contactId: contact.id });
    expect(events.filter((e) => e.type === 'appointment.booked')).toHaveLength(1);
  });

  it('cancelling twice, or rescheduling to the same time, are harmless repeats', async () => {
    const { org, contact } = await setup();
    const book = (local: string) =>
      t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: contact.id, start: parseLocalStart(local, 'America/Toronto')!, title: 'Consult', createdBy: 'ai' });
    const { appointment: toCancel } = await book('2026-10-05T10:00');
    await t.c.scheduling.cancel(org.scope, toCancel.id, { actor: 'ai', contactId: contact.id });
    const again = await t.c.scheduling.cancel(org.scope, toCancel.id, { actor: 'ai', contactId: contact.id });
    expect(again.status).toBe('cancelled');

    const { appointment: toKeep } = await book('2026-10-06T10:00');
    const same = await t.c.scheduling.reschedule(org.scope, toKeep.id, parseLocalStart('2026-10-06T10:00', 'America/Toronto')!, {
      actor: 'ai',
      contactId: contact.id,
    });
    expect(same).toMatchObject({ id: toKeep.id, localStart: '2026-10-06T10:00', status: 'booked' });

    const types = (await t.c.automation.listEvents(org.scope, { contactId: contact.id })).map((e) => e.type);
    expect(types.filter((type) => type === 'appointment.cancelled')).toHaveLength(1);
    expect(types).not.toContain('appointment.rescheduled');
  });

  it('staff booking the same contact into the same slot twice get the existing appointment', async () => {
    const { org, contact } = await setup();
    const payload = { calendarId: org.calendar.id, contactId: contact.id, start: '2026-10-07T10:00' };
    const first = await t.app.inject({ method: 'POST', url: '/v1/appointments', headers: authHeaders(org.token), payload });
    const second = await t.app.inject({ method: 'POST', url: '/v1/appointments', headers: authHeaders(org.token), payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('reschedules and cancels, scoped to the contact', async () => {
    const { org, contact } = await setup();
    const other = await t.c.contacts.create(org.scope, { firstName: 'Other' });
    const { appointment } = await t.c.scheduling.book(org.scope, {
      calendarId: org.calendar.id,
      contactId: contact.id,
      start: parseLocalStart('2026-10-02T11:00', 'America/Toronto')!,
      title: 'Consult',
      createdBy: 'ai',
    });
    // Another customer's AI session can't touch it.
    await expect(
      t.c.scheduling.cancel(org.scope, appointment.id, { actor: 'ai', contactId: other.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const moved = await t.c.scheduling.reschedule(org.scope, appointment.id, parseLocalStart('2026-10-02T11:30', 'America/Toronto')!, {
      actor: 'ai',
      contactId: contact.id,
    });
    expect(moved.localStart).toBe('2026-10-02T11:30');
    const cancelled = await t.c.scheduling.cancel(org.scope, appointment.id, { actor: 'ai', contactId: contact.id, reason: 'sick' });
    expect(cancelled.status).toBe('cancelled');
    // The slot is free again.
    const { slots } = await t.c.scheduling.availability(org.scope, org.calendar.id, { from: '2026-10-02', to: '2026-10-02' });
    expect(slots.map((s) => s.local)).toContain('2026-10-02T11:30');
  });

  it('rejects times outside hours or too soon', async () => {
    const { org, contact } = await setup();
    await expect(
      t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: contact.id, start: parseLocalStart('2026-10-03T12:00', 'America/Toronto')!, title: 'x', createdBy: 'ai' }),
    ).rejects.toMatchObject({ code: 'slot_unavailable' }); // Saturday: closed by default
    await expect(
      t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId: contact.id, start: parseLocalStart('2026-09-28T09:30', 'America/Toronto')!, title: 'x', createdBy: 'ai' }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/too soon/) });
  });
});

describe('booking through the AI', () => {
  async function aiSetup() {
    const org = await createOrg(t.c, 'Booking Co');
    await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id, requiredFields: ['name'] } } });
    return org;
  }

  async function say(org: { orgId: string; webchat: { id: string } }, content: string) {
    const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'booker', content });
    await t.c.queue.drain();
    return r;
  }

  const bookAt = (start: string) => ({ name: 'book_appointment', input: { start, customer_confirmed: true } });
  const idOf = (result: { content: unknown } | undefined) => (result!.content as { appointment_id: string }).appointment_id;

  it('cancel, then book the same slot again: a new live booking, and no confirmation claim', async () => {
    const org = await aiSetup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Robin Lee' } }, bookAt('2026-09-29T10:00')), text('Booked!')]);
    const r = await say(org, 'Robin Lee here, Tuesday 10am please');
    const [, booked] = lastToolResults(t.llm);
    expect(booked).toMatchObject({ isError: false, content: { booked: true, customer_confirmation_sent: false } });
    expect(booked!.content).not.toHaveProperty('confirmation_sent_to');
    expect(t.llm.requests[0]!.system).toMatch(/never say a confirmation/i);
    const firstId = idOf(booked);

    t.llm.setScript([tools({ name: 'cancel_appointment', input: { appointment_id: firstId, customer_confirmed: true } }), text('Cancelled.')]);
    await say(org, 'Please cancel it');
    t.llm.setScript([tools(bookAt('2026-09-29T10:00')), text('Booked again!')]);
    await say(org, 'Sorry, book Tuesday 10am after all');
    const [rebooked] = lastToolResults(t.llm);
    expect(rebooked).toMatchObject({ isError: false, content: { booked: true } });
    expect(rebooked!.content).not.toHaveProperty('already_booked');
    expect(idOf(rebooked)).not.toBe(firstId);
    const appts = await t.c.scheduling.listForContact(org.scope, r.contactId);
    expect(appts.map((a) => `${a.localStart} ${a.status}`).sort()).toEqual(['2026-09-29T10:00 booked', '2026-09-29T10:00 cancelled']);
  });

  it('reschedule, then book the original time again: two live bookings', async () => {
    const org = await aiSetup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Sky Park' } }, bookAt('2026-09-29T10:00')), text('Booked!')]);
    const r = await say(org, 'Sky Park, Tuesday 10am');
    const id = idOf(lastToolResults(t.llm)[1]);

    t.llm.setScript([
      tools({ name: 'reschedule_appointment', input: { appointment_id: id, new_start: '2026-09-29T11:00', customer_confirmed: true } }),
      text('Moved to 11.'),
    ]);
    await say(org, 'Move it to 11am');
    t.llm.setScript([tools(bookAt('2026-09-29T10:00')), text('Booked 10am as well.')]);
    await say(org, 'And book 10am too, for my partner');
    const [again] = lastToolResults(t.llm);
    expect(again).toMatchObject({ isError: false, content: { booked: true, when: expect.stringContaining('10:00 AM') } });
    const live = (await t.c.scheduling.listForContact(org.scope, r.contactId)).filter((a) => a.status === 'booked').map((a) => a.localStart);
    expect(live.sort()).toEqual(['2026-09-29T10:00', '2026-09-29T11:00']);
  });

  it('asking again for a slot the customer already holds returns that booking', async () => {
    const org = await aiSetup();
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Dee Ray' } }, bookAt('2026-09-29T10:00')), text('Booked!')]);
    const r = await say(org, 'Dee Ray, Tuesday 10am');
    const firstId = idOf(lastToolResults(t.llm)[1]);

    t.llm.setScript([tools(bookAt('2026-09-29T10:00')), text('You already have that time.')]);
    await say(org, 'Can you book Tuesday 10am for me?');
    const [second] = lastToolResults(t.llm);
    expect(second).toMatchObject({ isError: false, content: { booked: true, already_booked: true } });
    expect(idOf(second)).toBe(firstId);
    expect(await t.c.scheduling.listForContact(org.scope, r.contactId)).toHaveLength(1);
  });
});
