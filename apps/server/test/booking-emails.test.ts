import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { EmailSendError, type EmailMessage, type LogEmailSender } from '../src/infra/email';
import { parseLocalStart } from '../src/modules/scheduling/availability';
import { authHeaders, createOrg, createTestEnv, lastToolResults, text, tools, type TestEnv } from './helpers';

/**
 * Booking completeness: emails to the customer (confirmation with a calendar file, update, cancellation notice,
 * reminders), sent once and only to a stored address; a cancellation policy per calendar; the customer's timezone.
 */

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
});
afterAll(() => t.close());

const START = new Date('2026-09-28T13:00:00Z'); // Monday 09:00 in Toronto
const TZ = 'America/Toronto';
afterEach(() => {
  t.now.value = START;
});

type Org = Awaited<ReturnType<typeof createOrg>>;

const emailsTo = (address: string) => (t.c.email as LogEmailSender).sent.filter((m) => m.to.includes(address));
const kindOf = (m: EmailMessage) => m.subject.split(':')[0];
const calendarFile = (m: EmailMessage) => Buffer.from(m.attachments![0]!.content, 'base64').toString('utf8');

async function clinic(name: string, calendar: Parameters<TestEnv['c']['scheduling']['updateCalendar']>[2] = {}) {
  const org = await createOrg(t.c, name);
  await t.c.bots.update(org.scope, org.bot.id, { config: { booking: { enabled: true, calendarId: org.calendar.id } } });
  if (Object.keys(calendar).length) await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, calendar);
  return org;
}

async function say(org: Org, visitor: string, content: string, extra: { isTest?: boolean } = {}) {
  const r = await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: visitor, content, ...extra });
  await t.c.queue.drain();
  return r;
}

async function customer(org: Org, visitor: string, details: { name: string; email?: string }, extra: { isTest?: boolean } = {}) {
  t.llm.setScript([text('Hello!')]);
  const r = await say(org, visitor, 'hi', extra);
  await t.c.contacts.captureDetails(org.scope, r.contactId, details, 'ai');
  return r;
}

async function book(org: Org, contactId: string, local: string, extra: { createdBy?: 'ai' | 'user'; notifyCustomer?: boolean } = {}) {
  const start = parseLocalStart(local, TZ)!;
  const result = await t.c.scheduling.book(org.scope, { calendarId: org.calendar.id, contactId, start, title: 'Consultation', createdBy: extra.createdBy ?? 'ai', ...extra });
  await t.c.queue.drain();
  return result;
}

const bookTool = (start: string) => ({ name: 'book_appointment', input: { start, customer_confirmed: true } });
const idOf = (result: { content: unknown } | undefined) => (result!.content as { appointment_id: string }).appointment_id;
const logOf = async (org: Org, appointmentId: string) =>
  (await t.c.scheduling.listEmails(org.scope, appointmentId)).map((e) => `${e.kind} ${e.status}${e.reason ? ` ${e.reason}` : ''}`);

describe('emails to the customer', () => {
  it('an AI booking emails one confirmation with a calendar file, and the AI is told so', async () => {
    const org = await clinic('Confirm Clinic');
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Ana Lopez', email: 'ana@confirm.example' } }, bookTool('2026-09-29T10:00')), text('Booked!')]);
    await say(org, 'ana', 'Ana Lopez, ana@confirm.example, Tuesday 10am please');
    const [, booked] = lastToolResults(t.llm);
    expect(booked).toMatchObject({ isError: false, content: { booked: true, customer_confirmation_sent: true, confirmation_email: 'ana@confirm.example' } });
    expect(t.llm.requests.at(-1)!.system).toMatch(/customer_confirmation_sent: true/);

    const [mail, ...more] = emailsTo('ana@confirm.example');
    expect(more).toHaveLength(0);
    expect(mail!.subject).toBe('Confirmed: your appointment with Confirm Clinic on Tue 29 Sep, 10:00 AM');
    expect(mail!.text).toContain('Tuesday 29 September 2026, 10:00 AM');
    const id = idOf(booked);
    const ics = calendarFile(mail!);
    for (const line of ['METHOD:PUBLISH', `UID:${id}@`, 'DTSTART:20260929T140000Z', 'DTEND:20260929T143000Z', 'SEQUENCE:0', 'STATUS:CONFIRMED']) {
      expect(ics).toContain(line);
    }
    const log = await t.c.scheduling.listEmails(org.scope, id);
    expect(log.map((e) => `${e.kind} ${e.status}`)).toEqual(['confirmation sent', 'reminder pending']);
    expect(mail!.idempotencyKey).toBe(log[0]!.id);
    expect(log[0]!.recipient).toBe('ana@confirm.example');
    // 10:00 the day before, in Toronto.
    expect(log[1]!.sendAt).toEqual(new Date('2026-09-28T14:00:00Z'));

    // Asking again for the same slot: the same booking and no second email.
    t.llm.setScript([tools(bookTool('2026-09-29T10:00')), text('You already have it.')]);
    await say(org, 'ana', 'Book Tuesday 10am');
    expect(lastToolResults(t.llm)[0]).toMatchObject({ content: { already_booked: true, customer_confirmation_sent: true } });
    expect(emailsTo('ana@confirm.example')).toHaveLength(1);
  });

  it('never emails a claimed address, a contact without email or a test conversation, and logs why', async () => {
    const org = await clinic('Careful Clinic');
    await customer(org, 'owner', { name: 'Ana', email: 'ana@careful.example' });
    // Someone types Ana's email: they can book, but the email is under review, so nothing is sent.
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Mallory', email: 'ana@careful.example' } }, bookTool('2026-09-29T10:00')), text('Booked!')]);
    await say(org, 'mallory', "I'm Mallory, ana@careful.example, Tuesday 10am");
    const [, booked] = lastToolResults(t.llm);
    expect(booked).toMatchObject({
      isError: false,
      content: { booked: true, customer_confirmation_sent: false, confirmation_not_sent_reason: 'email_under_review' },
    });
    expect(booked!.content).not.toHaveProperty('confirmation_email');
    expect(await logOf(org, idOf(booked))).toEqual(['confirmation skipped email_under_review', 'reminder pending']);

    const noEmail = await customer(org, 'pat', { name: 'Pat' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: authHeaders(org.token),
      payload: { calendarId: org.calendar.id, contactId: noEmail.contactId, start: '2026-09-29T11:00' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().customerEmail).toEqual({ queued: false, to: null, reason: 'no_email' });

    const tester = await customer(org, 'tess', { name: 'Tess', email: 'tess@careful.example' }, { isTest: true });
    expect((await book(org, tester.contactId, '2026-09-29T12:00')).customerEmail).toEqual({ queued: false, to: null, reason: 'test_contact' });

    // Even when their reminders come due, none of them is emailed.
    t.now.value = new Date('2026-09-28T17:00:00Z');
    await t.c.appointmentEmails.sendDue();
    expect(emailsTo('ana@careful.example')).toHaveLength(0);
    expect(emailsTo('tess@careful.example')).toHaveLength(0);
    expect(await logOf(org, idOf(booked))).toEqual(['confirmation skipped email_under_review', 'reminder skipped email_under_review']);
  });

  it('moving a booking sends an update for the same event and replaces its reminders', async () => {
    const org = await clinic('Move Clinic');
    const v = await customer(org, 'mo', { name: 'Mo', email: 'mo@move.example' });
    const { appointment } = await book(org, v.contactId, '2026-09-29T10:00');
    const moved = await t.c.scheduling.reschedule(org.scope, appointment.id, parseLocalStart('2026-09-30T15:00', TZ)!, { actor: 'ai', contactId: v.contactId });
    expect(moved.customerEmail).toEqual({ queued: true, to: 'mo@move.example', reason: null });
    await t.c.queue.drain();

    const mails = emailsTo('mo@move.example');
    expect(mails.map(kindOf)).toEqual(['Confirmed', 'Changed']);
    expect(mails[1]!.text).toContain('Wednesday 30 September 2026, 3:00 PM');
    const ics = calendarFile(mails[1]!);
    for (const line of [`UID:${appointment.id}@`, 'SEQUENCE:1', 'DTSTART:20260930T190000Z', 'METHOD:PUBLISH']) expect(ics).toContain(line);
    expect(await logOf(org, appointment.id)).toEqual(['confirmation sent', 'reminder cancelled appointment_moved', 'update sent', 'reminder pending']);
    const reminder = (await t.c.scheduling.listEmails(org.scope, appointment.id)).at(-1)!;
    expect(reminder.sendAt).toEqual(new Date('2026-09-29T19:00:00Z'));
  });

  it('cancelling sends a cancellation notice and stops the reminders; completed or no-show stops them too', async () => {
    const org = await clinic('Cancel Clinic');
    const v = await customer(org, 'cy', { name: 'Cy', email: 'cy@cancel.example' });
    const first = await book(org, v.contactId, '2026-09-29T10:00');
    const cancelled = await t.c.scheduling.cancel(org.scope, first.appointment.id, { actor: 'ai', contactId: v.contactId });
    expect(cancelled.customerEmail).toMatchObject({ queued: true, to: 'cy@cancel.example' });
    await t.c.queue.drain();
    const notice = emailsTo('cy@cancel.example')[1]!;
    expect(notice.subject).toBe('Cancelled: your appointment with Cancel Clinic on Tue 29 Sep, 10:00 AM');
    const ics = calendarFile(notice);
    for (const line of ['METHOD:CANCEL', 'STATUS:CANCELLED', 'SEQUENCE:1', `UID:${first.appointment.id}@`]) expect(ics).toContain(line);
    expect(await logOf(org, first.appointment.id)).toEqual(['confirmation sent', 'reminder cancelled appointment_cancelled', 'cancellation sent']);

    const second = await book(org, v.contactId, '2026-09-29T11:00');
    await t.c.scheduling.setStatus(org.scope, second.appointment.id, 'completed');
    expect(await logOf(org, second.appointment.id)).toEqual(['confirmation sent', 'reminder cancelled appointment_ended']);
  });

  it('sends each due reminder once, and drops one whose booking changed behind its back', async () => {
    const org = await clinic('Remind Clinic');
    const v = await customer(org, 'rae', { name: 'Rae', email: 'rae@remind.example' });
    await book(org, v.contactId, '2026-09-30T10:00');
    const b = await book(org, v.contactId, '2026-09-30T11:00');
    // Moved outside the booking service (say, a manual fix in the database): the old reminder must not go out.
    await t.c.db
      .update(schema.appointments)
      .set({ startsAt: new Date('2026-09-30T20:00:00Z'), endsAt: new Date('2026-09-30T20:30:00Z') })
      .where(eq(schema.appointments.id, b.appointment.id));

    t.now.value = new Date('2026-09-29T15:30:00Z');
    await Promise.all([t.c.appointmentEmails.sendDue(), t.c.appointmentEmails.sendDue()]);
    await t.c.appointmentEmails.sendDue();
    const reminders = emailsTo('rae@remind.example').filter((m) => kindOf(m) === 'Reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.subject).toBe('Reminder: your appointment with Remind Clinic on Wed 30 Sep, 10:00 AM');
    expect(await logOf(org, b.appointment.id)).toEqual(['confirmation sent', 'reminder cancelled appointment_moved']);
  });

  it('a day-before reminder keeps the local time across the clock change; an hour-based one is exact', async () => {
    const org = await clinic('Sunday Clinic', { reminderMinutes: [1440, 120], maxDaysAhead: 60, weeklyHours: { sun: [{ start: '09:00', end: '17:00' }] } });
    const v = await customer(org, 'sol', { name: 'Sol', email: 'sol@sunday.example' });
    // Sunday 1 November 2026, the day Toronto's clocks go back: 10:00 EST is 15:00 UTC.
    const { appointment } = await book(org, v.contactId, '2026-11-01T10:00');
    const reminders = (await t.c.scheduling.listEmails(org.scope, appointment.id)).filter((e) => e.kind === 'reminder');
    // 10:00 EDT on Saturday (25 hours earlier), and exactly 2 hours before.
    expect(reminders.map((e) => e.sendAt.toISOString())).toEqual(['2026-10-31T14:00:00.000Z', '2026-11-01T13:00:00.000Z']);

    t.now.value = new Date('2026-10-31T14:00:00Z');
    await t.c.appointmentEmails.sendDue();
    const [reminder] = emailsTo('sol@sunday.example').filter((m) => kindOf(m) === 'Reminder');
    expect(reminder!.text).toContain('Sunday 1 November 2026, 10:00 AM');
  });

  it('retries a failing send, then logs it as failed and alerts the team; a refused address is not retried', async () => {
    const org = await clinic('Flaky Clinic');
    const v = await customer(org, 'fay', { name: 'Fay', email: 'fay@flaky.example' });
    const sender = t.c.email as LogEmailSender;
    const send = sender.send;
    const attempts: EmailMessage[] = [];
    sender.send = async (message) => {
      attempts.push(message);
      throw new EmailSendError('Resend failed: 503 unavailable', false);
    };
    try {
      const { appointment } = await book(org, v.contactId, '2026-10-02T10:00');
      for (let i = 0; i < 6; i++) {
        t.now.value = new Date(t.now.value.getTime() + 2 * 3_600_000);
        await t.c.appointmentEmails.sendDue();
      }
      const [confirmation] = await t.c.scheduling.listEmails(org.scope, appointment.id);
      expect(confirmation).toMatchObject({ kind: 'confirmation', status: 'failed', attempts: 5 });
      expect(confirmation!.error).toContain('503');
      // Every try sends the same bytes under the same key, so the provider can recognize a repeat.
      expect(attempts).toHaveLength(5);
      expect(new Set(attempts.map((m) => JSON.stringify(m))).size).toBe(1);
      expect(attempts[0]!.idempotencyKey).toBe(confirmation!.id);
      const alerts = await t.c.automation.listNotifications(org.scope, null);
      expect(alerts.find((n) => n.type === 'appointment.email_failed')).toMatchObject({ title: expect.stringContaining('Fay') });

      sender.send = async () => {
        throw new EmailSendError('Resend failed: 422 invalid recipient', true);
      };
      const second = await book(org, v.contactId, '2026-10-02T11:00');
      expect((await t.c.scheduling.listEmails(org.scope, second.appointment.id))[0]).toMatchObject({ status: 'failed', attempts: 1 });
    } finally {
      sender.send = send;
    }
  });

  it('staff can book without emailing, send the confirmation later, and cancel quietly', async () => {
    const org = await clinic('Quiet Clinic');
    const v = await customer(org, 'quinn', { name: 'Quinn', email: 'quinn@quiet.example' });
    const headers = authHeaders(org.token);
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers,
      payload: { calendarId: org.calendar.id, contactId: v.contactId, start: '2026-09-29T10:00', notifyCustomer: false },
    });
    expect(res.json().customerEmail).toEqual({ queued: false, to: null, reason: 'not_requested' });
    await t.c.queue.drain();
    expect(emailsTo('quinn@quiet.example')).toHaveLength(0);
    const id = res.json().id as string;

    const resent = await t.app.inject({ method: 'POST', url: `/v1/appointments/${id}/resend-confirmation`, headers });
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toEqual({ queued: true, to: 'quinn@quiet.example', reason: null });
    await t.c.queue.drain();
    expect(emailsTo('quinn@quiet.example').map(kindOf)).toEqual(['Confirmed']);

    const cancel = await t.app.inject({ method: 'POST', url: `/v1/appointments/${id}/cancel`, headers, payload: { notifyCustomer: false } });
    expect(cancel.json().customerEmail).toEqual({ queued: false, to: null, reason: 'not_requested' });
    await t.c.queue.drain();
    expect(emailsTo('quinn@quiet.example')).toHaveLength(1);
    const log = await t.app.inject({ method: 'GET', url: `/v1/appointments/${id}/notifications`, headers });
    expect(log.json().map((e: { kind: string; status: string; reason: string | null }) => [e.kind, e.status, e.reason])).toEqual([
      ['confirmation', 'skipped', 'not_requested'],
      ['confirmation', 'sent', null],
      ['reminder', 'cancelled', 'appointment_cancelled'],
      ['cancellation', 'skipped', 'not_requested'],
    ]);
  });

  it('calendar settings are validated, and the email carries the location, instructions, policy and reply-to', async () => {
    const org = await createOrg(t.c, 'Settings Clinic');
    expect(org.calendar).toMatchObject({ sendConfirmations: true, reminderMinutes: [1440], minCancelNoticeMinutes: null, replyToEmail: null });
    const patch = (payload: object) => t.app.inject({ method: 'PATCH', url: `/v1/calendars/${org.calendar.id}`, headers: authHeaders(org.token), payload });
    expect((await patch({ reminderMinutes: [5] })).statusCode).toBe(400);
    expect((await patch({ reminderMinutes: [1440, 120, 60, 30] })).statusCode).toBe(400);
    expect((await patch({ replyToEmail: 'not-an-email' })).statusCode).toBe(400);
    expect((await patch({ minCancelNoticeMinutes: -5 })).statusCode).toBe(400);
    const ok = await patch({
      reminderMinutes: [1440, 120],
      replyToEmail: 'front@settings.example',
      minCancelNoticeMinutes: 1440,
      location: '123 Main St, Toronto',
      customerInstructions: 'Please arrive 10 minutes early.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ reminderMinutes: [1440, 120], replyToEmail: 'front@settings.example', minCancelNoticeMinutes: 1440 });

    const v = await customer(org, 'sam', { name: 'Sam', email: 'sam@settings.example' });
    await book(org, v.contactId, '2026-09-30T10:00');
    const [mail] = emailsTo('sam@settings.example');
    expect(mail!.replyTo).toBe('front@settings.example');
    expect(mail!.fromName).toBe('Settings Clinic');
    for (const part of ['123 Main St, Toronto', 'Please arrive 10 minutes early.', 'until 24 hours before', 'reply to this email']) {
      expect(mail!.text).toContain(part);
    }
    expect(calendarFile(mail!)).toContain('LOCATION:123 Main St\\, Toronto');

    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { sendConfirmations: false, reminderMinutes: [] });
    const quiet = await book(org, v.contactId, '2026-09-30T11:00');
    expect(quiet.customerEmail).toEqual({ queued: false, to: null, reason: 'emails_off' });
    expect(await logOf(org, quiet.appointment.id)).toEqual(['confirmation skipped emails_off']);
  });
});

describe('cancellation policy', () => {
  it('inside the window the AI offers the team instead of changing the booking; staff still can', async () => {
    const org = await clinic('Policy Clinic', { minCancelNoticeMinutes: 1440 });
    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Lee', email: 'lee@policy.example' } }, bookTool('2026-09-30T10:00')), text('Booked!')]);
    await say(org, 'lee', 'Lee, lee@policy.example, Wednesday 10am');
    const [, booked] = lastToolResults(t.llm);
    expect(booked!.content).toMatchObject({ changes_allowed_until: expect.stringContaining('24 hours before') });
    const id = idOf(booked);

    // 20 hours before (Tuesday 14:00 in Toronto).
    t.now.value = new Date('2026-09-29T18:00:00Z');
    t.llm.setScript([tools({ name: 'cancel_appointment', input: { appointment_id: id, customer_confirmed: true } }), text('I can connect you with the team.')]);
    await say(org, 'lee', 'Cancel it please');
    const [refusedCancel] = lastToolResults(t.llm);
    expect(refusedCancel!.isError).toBe(true);
    expect(JSON.stringify(refusedCancel!.content)).toMatch(/24 hours.*transfer_to_human/);
    t.llm.setScript([
      tools({ name: 'reschedule_appointment', input: { appointment_id: id, new_start: '2026-10-01T10:00', customer_confirmed: true } }),
      text('I can connect you with the team.'),
    ]);
    await say(org, 'lee', 'Move it to Thursday then');
    expect(lastToolResults(t.llm)[0]!.isError).toBe(true);
    expect(await t.c.scheduling.getAppointment(org.scope, id)).toMatchObject({ status: 'booked', localStart: '2026-09-30T10:00' });
    expect(t.llm.requests.at(-1)!.system).toMatch(/too close to the appointment.*transfer_to_human/);

    // Staff can always change it.
    const staff = await t.app.inject({ method: 'POST', url: `/v1/appointments/${id}/cancel`, headers: authHeaders(org.token), payload: {} });
    expect(staff.json()).toMatchObject({ status: 'cancelled' });
  });

  it('outside the window the AI can change it; even "anytime" ends when the appointment starts', async () => {
    const org = await clinic('Window Clinic', { minCancelNoticeMinutes: 1440 });
    const v = await customer(org, 'wes', { name: 'Wes', email: 'wes@window.example' });
    const a = await book(org, v.contactId, '2026-09-30T10:00');
    // 30 hours before.
    t.now.value = new Date('2026-09-29T08:00:00Z');
    t.llm.setScript([tools({ name: 'cancel_appointment', input: { appointment_id: a.appointment.id, customer_confirmed: true } }), text('Cancelled.')]);
    await say(org, 'wes', 'Please cancel my Wednesday appointment');
    expect(lastToolResults(t.llm)[0]).toMatchObject({ isError: false, content: { cancelled: true, customer_cancellation_email_sent: true } });
    expect(emailsTo('wes@window.example').map(kindOf)).toEqual(['Confirmed', 'Cancelled']);

    await t.c.scheduling.updateCalendar(org.scope, org.calendar.id, { minCancelNoticeMinutes: null });
    const b = await book(org, v.contactId, '2026-09-30T11:00');
    t.now.value = new Date('2026-09-30T15:10:00Z'); // 11:10 in Toronto, after it started
    await expect(t.c.scheduling.cancel(org.scope, b.appointment.id, { actor: 'ai', contactId: v.contactId })).rejects.toMatchObject({
      code: 'change_window_closed',
    });
  });
});

describe("the customer's timezone", () => {
  const ORIGIN = 'https://zone.example';

  async function widget(org: Org) {
    const session = await t.app.inject({ method: 'POST', url: '/widget/v1/sessions', headers: { origin: ORIGIN }, payload: { key: org.webchat.publicKey } });
    const { token } = session.json() as { token: string };
    return async (body: Record<string, unknown>) => {
      const res = await t.app.inject({ method: 'POST', url: '/widget/v1/messages', headers: { authorization: `Bearer ${token}`, origin: ORIGIN }, payload: body });
      expect(res.statusCode).toBeLessThan(300);
      await t.c.queue.drain();
      const [conv] = await t.c.db.select().from(schema.conversations).where(eq(schema.conversations.id, (res.json() as { conversationId: string }).conversationId));
      return conv!.contactId;
    };
  }

  it("is recorded from the widget once, and times are shown in the customer's zone too", async () => {
    const org = await clinic('Zone Clinic');
    const send = await widget(org);
    t.llm.setScript([text('Hi!')]);
    const contactId = await send({ content: 'Hello', timezone: 'America/Vancouver' });
    expect((await t.c.contacts.get(org.scope, contactId)).timezone).toBe('America/Vancouver');
    t.llm.setScript([text('Hi again!')]);
    await send({ content: 'Still me', timezone: 'Europe/London' });
    expect((await t.c.contacts.get(org.scope, contactId)).timezone).toBe('America/Vancouver');

    t.llm.setScript([tools({ name: 'check_availability', input: { date_from: '2026-09-29', date_to: '2026-09-29' } }), text('Here are some times.')]);
    await send({ content: 'What do you have on Tuesday?' });
    const [slots] = lastToolResults(t.llm);
    const first = (slots!.content as { days: Array<{ times: Array<Record<string, string>> }> }).days[0]!.times[0]!;
    expect(first).toMatchObject({ start: '2026-09-29T09:00', your_time: 'Tue 29 Sep, 6:00 AM (Vancouver)' });
    expect(JSON.stringify(t.llm.requests.at(-1)!.messages)).toContain('timezone: America/Vancouver');
    expect(t.llm.requests.at(-1)!.system).toMatch(/your_time/);

    t.llm.setScript([tools({ name: 'save_contact_details', input: { name: 'Val', email: 'val@zone.example' } }, bookTool('2026-09-29T10:00')), text('Booked!')]);
    await send({ content: 'Val, val@zone.example, 10am Toronto time works' });
    expect(lastToolResults(t.llm)[1]).toMatchObject({ content: { booked: true, your_time: 'Tue 29 Sep, 7:00 AM (Vancouver)' } });
    const [mail] = emailsTo('val@zone.example');
    expect(mail!.text).toContain('Tuesday 29 September 2026, 10:00 AM (Toronto time)');
    expect(mail!.text).toContain('7:00 AM your time (Vancouver)');
  });

  it('ignores an invalid timezone, shows one time when the zones match, and lets the AI save one', async () => {
    const org = await clinic('Local Clinic');
    const send = await widget(org);
    t.llm.setScript([text('Hi!')]);
    const contactId = await send({ content: 'Hello', timezone: 'Mars/Olympus_Mons' });
    expect((await t.c.contacts.get(org.scope, contactId)).timezone).toBeNull();

    t.llm.setScript([tools({ name: 'save_contact_details', input: { timezone: 'America/Toronto' } }, { name: 'check_availability', input: {} }), text('Here you go.')]);
    await send({ content: "I'm in Toronto, what's free?" });
    const [saved, slots] = lastToolResults(t.llm);
    expect(saved!.isError).toBe(false);
    expect((await t.c.contacts.get(org.scope, contactId)).timezone).toBe('America/Toronto');
    const first = (slots!.content as { days: Array<{ times: Array<Record<string, string>> }> }).days[0]!.times[0]!;
    expect(first).not.toHaveProperty('your_time');

    t.llm.setScript([tools({ name: 'save_contact_details', input: { timezone: 'Somewhere/Else' } }), text('Which city?')]);
    await send({ content: 'Actually I moved' });
    expect(JSON.stringify(lastToolResults(t.llm)[0]!.content)).toMatch(/timezone/i);
    expect((await t.c.contacts.get(org.scope, contactId)).timezone).toBe('America/Toronto');
  });
});

describe('staff alerts', () => {
  it('tells the team when a booking moves', async () => {
    const org = await clinic('Alert Clinic');
    const v = await customer(org, 'al', { name: 'Al Moss', email: 'al@alert.example' });
    const { appointment } = await book(org, v.contactId, '2026-09-29T10:00');
    await t.c.scheduling.reschedule(org.scope, appointment.id, parseLocalStart('2026-09-29T14:00', TZ)!, { actor: 'ai', contactId: v.contactId });
    await t.c.automation.dispatchPending();
    const moved = (await t.c.automation.listNotifications(org.scope, null)).find((n) => n.type === 'appointment.rescheduled');
    expect(moved).toMatchObject({ title: 'Booking moved: Al Moss', body: expect.stringMatching(/Tue 29 Sep 2026, 10:00 AM → Tue 29 Sep 2026, 2:00 PM/) });
  });
});
