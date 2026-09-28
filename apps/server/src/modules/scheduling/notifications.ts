import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { rowsOf, schema, type Db } from '../../db/client';
import type { AppointmentEmailKind } from '../../db/schema';
import { EmailSendError, type EmailMessage, type EmailSender } from '../../infra/email';
import type { Logger } from '../../lib/logger';
import { calendarFile } from './ics';

/**
 * Emails to the customer about their appointment: a confirmation, an update when it moves, a cancellation notice and
 * reminders. Planning happens inside the booking transaction (so an email exists only if the change committed);
 * a worker sends due rows. Only the email stored on the contact is used, never a claimed one waiting for review.
 */

type CalendarRow = typeof schema.calendars.$inferSelect;
type AppointmentRow = typeof schema.appointments.$inferSelect;
type NotificationRow = typeof schema.appointmentNotifications.$inferSelect;

export type EmailSkipReason =
  | 'not_requested'
  | 'emails_off'
  | 'test_contact'
  | 'no_email'
  | 'email_under_review'
  | 'never_confirmed'
  | 'send_failed'
  | 'unchanged';

/** What the customer is told by email about a booking change (for the AI's reply and the API's response). */
export interface CustomerEmailOutcome {
  queued: boolean;
  to: string | null;
  reason: EmailSkipReason | null;
}

const queued = (to: string | null): CustomerEmailOutcome => ({ queued: true, to, reason: null });
export const notQueued = (reason: EmailSkipReason): CustomerEmailOutcome => ({ queued: false, to: null, reason });

const n = schema.appointmentNotifications;

// ---------- wording shared with the booking tools ----------

/** "America/Toronto" → "Toronto". */
export function zoneName(timezone: string): string {
  if (timezone === 'UTC' || timezone === 'Etc/UTC') return 'UTC';
  return (timezone.split('/').pop() ?? timezone).replace(/_/g, ' ');
}

/** 1440 → "24 hours", 30 → "30 minutes". */
export function noticeLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

/** "Tue 29 Sep, 7:00 AM (Vancouver)": the customer's own time, when their timezone differs from the calendar's. */
export function customerTime(start: Date, calendarTimezone: string, customerTimezone: string | null | undefined): string | null {
  if (!customerTimezone || customerTimezone === calendarTimezone || !DateTime.local().setZone(customerTimezone).isValid) return null;
  return `${DateTime.fromJSDate(start, { zone: customerTimezone }).setLocale('en-US').toFormat('ccc d LLL, h:mm a')} (${zoneName(customerTimezone)})`;
}

/** For the AI and the email: how late a booking can still be changed without staff. */
export function changePolicy(calendar: Pick<CalendarRow, 'minCancelNoticeMinutes'>): string {
  return calendar.minCancelNoticeMinutes
    ? `${noticeLabel(calendar.minCancelNoticeMinutes)} before the appointment`
    : 'any time before the appointment starts';
}

// ---------- planning (inside the booking transaction) ----------

interface Plan {
  orgId: string;
  appointment: AppointmentRow;
  calendar: CalendarRow;
  now: Date;
  /** This change may email the customer: false when staff untick "Email the customer". */
  notify: boolean;
}

/** Where an email to this contact would go now, or why it can't: only their stored address, never a claimed one. */
export async function recipientFor(db: Db, orgId: string, contactId: string): Promise<{ to: string | null; reason: EmailSkipReason | null }> {
  const [contact] = await db
    .select({ email: schema.contacts.email, isTest: schema.contacts.isTest })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, orgId)));
  if (!contact) return { to: null, reason: 'no_email' };
  if (contact.isTest) return { to: null, reason: 'test_contact' };
  if (contact.email) return { to: contact.email, reason: null };
  const mc = schema.contactMergeCandidates;
  const [claim] = await db
    .select({ id: mc.id })
    .from(mc)
    .where(and(eq(mc.organizationId, orgId), eq(mc.contactId, contactId), eq(mc.field, 'email'), eq(mc.status, 'pending')))
    .limit(1);
  return { to: null, reason: claim ? 'email_under_review' : 'no_email' };
}

/** A confirmation, update or cancellation notice: queued now, or logged as skipped with the reason. */
async function notice(tx: Db, p: Plan, kind: Exclude<AppointmentEmailKind, 'reminder'>): Promise<CustomerEmailOutcome> {
  let to: string | null = null;
  let reason: EmailSkipReason | null = !p.notify || !p.appointment.notifyCustomer ? 'not_requested' : !p.calendar.sendConfirmations ? 'emails_off' : null;
  if (!reason) ({ to, reason } = await recipientFor(tx, p.orgId, p.appointment.contactId));
  await tx.insert(n).values({
    organizationId: p.orgId,
    appointmentId: p.appointment.id,
    kind,
    status: reason ? 'skipped' : 'pending',
    reason,
    sendAt: p.now,
    forStartsAt: p.appointment.startsAt,
    recipient: to,
  });
  return reason ? notQueued(reason) : queued(to);
}

/**
 * When reminders go out: whole days before keep the local time of day (10:00 the day before, even across a
 * daylight-saving change); other offsets are exact. Times already past are dropped.
 */
export function reminderTimes(start: Date, timezone: string, minutes: number[], now: Date): Array<{ minutes: number; sendAt: Date }> {
  const local = DateTime.fromJSDate(start, { zone: timezone });
  return [...new Set(minutes)]
    .sort((a, b) => b - a)
    .map((m) => ({ minutes: m, sendAt: (m % 1440 === 0 ? local.minus({ days: m / 1440 }) : local.minus({ minutes: m })).toJSDate() }))
    .filter((r) => r.sendAt.getTime() > now.getTime());
}

async function planReminders(tx: Db, p: Plan): Promise<void> {
  if (!p.appointment.notifyCustomer || !p.calendar.reminderMinutes.length) return;
  const [contact] = await tx.select({ isTest: schema.contacts.isTest }).from(schema.contacts).where(eq(schema.contacts.id, p.appointment.contactId));
  if (contact?.isTest) return;
  const times = reminderTimes(p.appointment.startsAt, p.appointment.timezone, p.calendar.reminderMinutes, p.now);
  if (!times.length) return;
  await tx.insert(n).values(
    times.map((r) => ({
      organizationId: p.orgId,
      appointmentId: p.appointment.id,
      kind: 'reminder' as const,
      sendAt: r.sendAt,
      forStartsAt: p.appointment.startsAt,
      reminderMinutes: r.minutes,
    })),
  );
}

/** Cancels the booking's emails that haven't started sending. */
export async function cancelPending(tx: Db, appointmentId: string, reason: string): Promise<void> {
  await tx.update(n).set({ status: 'cancelled', reason }).where(and(eq(n.appointmentId, appointmentId), eq(n.status, 'pending')));
}

/** Whether a confirmation or update went out (or is going out right now): the customer knows about the booking. */
async function customerWasTold(tx: Db, appointmentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: n.id })
    .from(n)
    .where(and(eq(n.appointmentId, appointmentId), inArray(n.kind, ['confirmation', 'update']), inArray(n.status, ['sent', 'sending'])))
    .limit(1);
  return Boolean(row);
}

export async function planBooked(tx: Db, p: Plan): Promise<CustomerEmailOutcome> {
  const outcome = await notice(tx, p, 'confirmation');
  await planReminders(tx, p);
  return outcome;
}

/** A moved booking: an update if the customer knew the old time (otherwise a first confirmation), and new reminders. */
export async function planMoved(tx: Db, p: Plan): Promise<CustomerEmailOutcome> {
  const told = await customerWasTold(tx, p.appointment.id);
  await cancelPending(tx, p.appointment.id, 'appointment_moved');
  const outcome = await notice(tx, p, told ? 'update' : 'confirmation');
  await planReminders(tx, p);
  return outcome;
}

/** A cancelled booking: a notice only if the customer had been told about it. */
export async function planCancelled(tx: Db, p: Plan): Promise<CustomerEmailOutcome> {
  const told = await customerWasTold(tx, p.appointment.id);
  await cancelPending(tx, p.appointment.id, 'appointment_cancelled');
  return told ? notice(tx, p, 'cancellation') : notQueued('never_confirmed');
}

/** Staff asked for a (new) confirmation; reminders are planned too if the booking had none. */
export async function planResend(tx: Db, p: Plan): Promise<CustomerEmailOutcome> {
  const [waiting] = await tx
    .select({ recipient: n.recipient })
    .from(n)
    .where(and(eq(n.appointmentId, p.appointment.id), eq(n.kind, 'confirmation'), inArray(n.status, ['pending', 'sending'])))
    .limit(1);
  if (waiting) return queued(waiting.recipient);
  const outcome = await notice(tx, p, 'confirmation');
  const [reminder] = await tx
    .select({ id: n.id })
    .from(n)
    .where(and(eq(n.appointmentId, p.appointment.id), eq(n.kind, 'reminder'), eq(n.status, 'pending')))
    .limit(1);
  if (!reminder) await planReminders(tx, p);
  return outcome;
}

/** For a repeated booking request: what the customer was told about the booking they already hold. */
export async function confirmationState(tx: Db, appointmentId: string): Promise<CustomerEmailOutcome> {
  const [row] = await tx
    .select({ status: n.status, reason: n.reason, recipient: n.recipient })
    .from(n)
    .where(and(eq(n.appointmentId, appointmentId), inArray(n.kind, ['confirmation', 'update'])))
    .orderBy(desc(n.createdAt))
    .limit(1);
  if (!row) return notQueued('never_confirmed');
  if (row.status === 'pending' || row.status === 'sending' || row.status === 'sent') return queued(row.recipient);
  return notQueued(row.status === 'failed' ? 'send_failed' : ((row.reason as EmailSkipReason | null) ?? 'no_email'));
}

// ---------- sending (worker) ----------

const MAX_ATTEMPTS = 5;
/** Minutes to wait after the 1st, 2nd, 3rd and 4th failed attempt. */
const RETRY_MINUTES = [1, 5, 15, 60];
const LEASE_MS = 5 * 60_000;
const BATCH = 50;

interface Loaded {
  row: NotificationRow;
  appointment: AppointmentRow;
  calendar: CalendarRow;
  contact: { firstName: string | null; lastName: string | null; timezone: string | null };
  business: string;
}

export class AppointmentEmailSender {
  constructor(
    private readonly db: Db,
    private readonly email: EmailSender,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Sends every email that's due. System-level (all organizations). Rows are claimed with a lease, so overlapping
   * runs never send the same email; each email's idempotency key is its row ID, so a retry after a crash can't
   * send it twice either.
   */
  async sendDue(): Promise<number> {
    let total = 0;
    for (let round = 0; round < 20; round++) {
      const ids = await this.claim();
      for (const id of ids) {
        await this.deliver(id).catch((err) => this.logger.error({ err, notificationId: id }, 'appointment email: unexpected error'));
      }
      total += ids.length;
      if (ids.length < BATCH) break;
    }
    return total;
  }

  private async claim(): Promise<string[]> {
    const now = this.clock();
    const at = now.toISOString();
    const leaseEnd = new Date(now.getTime() + LEASE_MS).toISOString();
    return rowsOf<{ id: string }>(
      await this.db.execute(sql`
        update appointment_notifications
        set status = 'sending', lease_until = ${leaseEnd}::timestamptz, attempts = attempts + 1, updated_at = now()
        where id in (
          select id from appointment_notifications
          where (status = 'pending' and send_at <= ${at}::timestamptz)
             or (status = 'sending' and lease_until < ${at}::timestamptz)
          order by send_at
          limit ${BATCH}
          for update skip locked)
        returning id`),
    ).map((r) => r.id);
  }

  private async load(id: string): Promise<Loaded | null> {
    const [row] = await this.db
      .select({
        row: n,
        appointment: schema.appointments,
        calendar: schema.calendars,
        contact: { firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, timezone: schema.contacts.timezone },
        business: schema.organizations.name,
      })
      .from(n)
      .innerJoin(schema.appointments, eq(schema.appointments.id, n.appointmentId))
      .innerJoin(schema.calendars, eq(schema.calendars.id, schema.appointments.calendarId))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.appointments.contactId))
      .innerJoin(schema.organizations, eq(schema.organizations.id, n.organizationId))
      .where(eq(n.id, id));
    return row ?? null;
  }

  private async deliver(id: string): Promise<void> {
    const now = this.clock();
    const loaded = await this.load(id);
    if (!loaded || loaded.row.status !== 'sending') return;
    const { row, appointment, calendar } = loaded;
    const stale = staleness(row, appointment, calendar, now);
    if (stale) return this.finish(id, { status: 'cancelled', reason: stale });
    const recipient = await recipientFor(this.db, row.organizationId, appointment.contactId);
    const skip = row.kind !== 'reminder' && !calendar.sendConfirmations ? 'emails_off' : recipient.reason;
    if (skip || !recipient.to) return this.finish(id, { status: 'skipped', reason: skip ?? 'no_email', recipient: null });

    const message = composeEmail({ ...loaded, sequence: await this.sequenceFor(row) });
    try {
      const sent = await this.email.send({ ...message, to: [recipient.to], idempotencyKey: id });
      await this.finish(id, { status: 'sent', sentAt: now, recipient: recipient.to, providerMessageId: sent.id, error: null, reason: null });
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const permanent = err instanceof EmailSendError && err.permanent;
      if (!permanent && row.attempts < MAX_ATTEMPTS) {
        const wait = RETRY_MINUTES[Math.min(row.attempts, RETRY_MINUTES.length) - 1]!;
        return this.finish(id, { status: 'pending', sendAt: new Date(now.getTime() + wait * 60_000), error, recipient: recipient.to });
      }
      await this.finish(id, { status: 'failed', error, recipient: recipient.to });
      await this.alertStaff(loaded, error);
      this.logger.warn({ orgId: row.organizationId, appointmentId: appointment.id, kind: row.kind, error }, 'appointment email failed');
    }
  }

  /** The event's revision in the calendar file: one more for every update or cancellation already sent. */
  private async sequenceFor(row: NotificationRow): Promise<number> {
    const [sent] = await this.db
      .select({ n: count() })
      .from(n)
      .where(and(eq(n.appointmentId, row.appointmentId), inArray(n.kind, ['update', 'cancellation']), eq(n.status, 'sent'), ne(n.id, row.id)));
    return (sent?.n ?? 0) + (row.kind === 'update' || row.kind === 'cancellation' ? 1 : 0);
  }

  private async finish(id: string, patch: Partial<typeof n.$inferInsert>): Promise<void> {
    await this.db
      .update(n)
      .set({ ...patch, leaseUntil: null })
      .where(and(eq(n.id, id), eq(n.status, 'sending')));
  }

  private async alertStaff({ row, appointment, contact }: Loaded, error: string): Promise<void> {
    const who = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'a customer';
    const when = DateTime.fromJSDate(appointment.startsAt, { zone: appointment.timezone }).setLocale('en-US').toFormat('ccc d LLL, h:mm a');
    await this.db.insert(schema.notifications).values({
      organizationId: row.organizationId,
      type: 'appointment.email_failed',
      title: `Couldn't email ${who} about their booking`.slice(0, 200),
      body: `${KIND_LABEL[row.kind]} for ${when} wasn't sent: ${error}`.slice(0, 1000),
      link: `/contacts/${appointment.contactId}`,
      data: { appointmentId: appointment.id, notificationId: row.id },
    });
  }
}

const KIND_LABEL: Record<AppointmentEmailKind, string> = {
  confirmation: 'The confirmation',
  update: 'The change notice',
  cancellation: 'The cancellation notice',
  reminder: 'The reminder',
};

/** Why an email no longer applies, or null to send it. */
function staleness(row: NotificationRow, appointment: AppointmentRow, calendar: CalendarRow, now: Date): string | null {
  if (row.kind === 'cancellation') return appointment.status === 'cancelled' ? null : 'appointment_changed';
  if (appointment.status === 'cancelled') return 'appointment_cancelled';
  if (appointment.status !== 'booked') return 'appointment_ended';
  if (appointment.startsAt.getTime() !== row.forStartsAt.getTime()) return 'appointment_moved';
  if (now.getTime() >= appointment.startsAt.getTime()) return 'too_late';
  if (row.kind === 'reminder' && !calendar.reminderMinutes.includes(row.reminderMinutes ?? -1)) return 'reminders_off';
  return null;
}

// ---------- the email ----------

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The appointment title without the " with <customer>" the AI adds for staff. */
function serviceName(title: string, customer: string): string {
  const suffix = customer ? ` with ${customer}` : '';
  return suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

export function composeEmail(input: Loaded & { sequence: number }): Omit<EmailMessage, 'to'> {
  const { row, appointment, calendar, contact, business } = input;
  const customer = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  const what = serviceName(appointment.title, customer);
  const minutes = Math.round((appointment.endsAt.getTime() - appointment.startsAt.getTime()) / 60_000);
  const local = DateTime.fromJSDate(appointment.startsAt, { zone: appointment.timezone }).setLocale('en-US');
  const theirZone =
    contact.timezone && contact.timezone !== appointment.timezone && DateTime.local().setZone(contact.timezone).isValid ? contact.timezone : null;
  const theirs = theirZone ? DateTime.fromJSDate(appointment.startsAt, { zone: theirZone }).setLocale('en-US') : null;
  const short = theirs ? `${theirs.toFormat('ccc d LLL, h:mm a')} (${zoneName(theirZone!)} time)` : local.toFormat('ccc d LLL, h:mm a');
  const when = [
    `${local.toFormat('cccc d LLLL yyyy, h:mm a')} (${zoneName(appointment.timezone)} time)`,
    theirs ? `${theirs.toFormat(theirs.hasSame(local, 'day') ? 'h:mm a' : 'ccc d LLL, h:mm a')} your time (${zoneName(theirZone!)})` : null,
  ].filter((l): l is string => l !== null);

  const details: Array<[string, string]> = [
    ['What', `${what} (${minutes} minutes)`],
    ['When', when.join('\n')],
    ...(calendar.location ? ([['Where', calendar.location]] as Array<[string, string]>) : []),
  ];
  const policy = calendar.minCancelNoticeMinutes
    ? `Changes and cancellations are possible until ${noticeLabel(calendar.minCancelNoticeMinutes)} before the appointment. `
    : '';
  const contactUs = calendar.replyToEmail ? 'reply to this email' : `contact ${business}`;
  const heading = {
    confirmation: { subject: `Confirmed: your appointment with ${business} on ${short}`, intro: `Your appointment with ${business} is confirmed.` },
    update: { subject: `Changed: your appointment with ${business} is now on ${short}`, intro: `Your appointment with ${business} has moved. The new time:` },
    cancellation: { subject: `Cancelled: your appointment with ${business} on ${short}`, intro: `Your appointment with ${business} has been cancelled:` },
    reminder: { subject: `Reminder: your appointment with ${business} on ${short}`, intro: `This is a reminder of your appointment with ${business}.` },
  }[row.kind];

  const blocks: string[][] = [[contact.firstName ? `Hi ${contact.firstName},` : 'Hi,'], [heading.intro]];
  const lines = (list: Array<[string, string]>) => list.map(([label, value]) => `${label}: ${value.replace(/\n/g, '\n      ')}`);
  if (row.kind === 'cancellation') {
    blocks.push(lines(details.filter(([label]) => label !== 'Where')));
    blocks.push([`To book a new time, ${contactUs}.`]);
  } else {
    blocks.push(lines(details));
    if (calendar.customerInstructions) blocks.push([calendar.customerInstructions]);
    blocks.push([`${policy}To change or cancel, ${contactUs}.`]);
  }
  const file = row.kind === 'reminder' ? null : { confirmation: 'adds it to', update: 'updates it in', cancellation: 'removes it from' }[row.kind];
  if (file) blocks.push([`The attached calendar file ${file} your calendar.`]);
  blocks.push([business]);

  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  const html = blocks
    .map((b) => `<p>${b.map((line) => escapeHtml(line).replace(/\n/g, '<br>')).join('<br>')}</p>`)
    .join('\n');
  const method = row.kind === 'cancellation' ? 'CANCEL' : 'PUBLISH';
  const ics = file
    ? calendarFile({
        uid: `${appointment.id}@omnichannel-ai`,
        sequence: input.sequence,
        method,
        start: appointment.startsAt,
        end: appointment.endsAt,
        summary: `${what} with ${business}`,
        location: calendar.location || undefined,
        description: [calendar.customerInstructions, policy.trim()].filter(Boolean).join('\n') || undefined,
        // The row's creation time, not the send time: a retry must send the same bytes under the same idempotency key.
        stamp: row.createdAt,
      })
    : null;
  return {
    subject: heading.subject,
    text,
    html: `<!doctype html><html><body style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#111">${html}</body></html>`,
    fromName: business,
    replyTo: calendar.replyToEmail ?? undefined,
    attachments: ics
      ? [{ filename: 'invite.ics', content: Buffer.from(ics, 'utf8').toString('base64'), contentType: `text/calendar; charset=utf-8; method=${method}` }]
      : undefined,
  };
}

