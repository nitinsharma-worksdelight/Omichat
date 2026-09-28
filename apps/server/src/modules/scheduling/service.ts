import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { schema, type Db } from '../../db/client';
import type { AppointmentStatus } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../automation/events';
import { checkSlot, computeSlots, formatSlotLabel, validateHours, type CalendarRules, type Interval } from './availability';
import {
  cancelPending,
  confirmationState,
  noticeLabel,
  notQueued,
  planBooked,
  planCancelled,
  planMoved,
  planResend,
  type CustomerEmailOutcome,
} from './notifications';
import type { CalendarProviderRegistry } from './providers';

const TimeRangeSchema = z.object({ start: z.string(), end: z.string() });
const WeeklyHoursSchema = z
  .object({
    mon: z.array(TimeRangeSchema).optional(),
    tue: z.array(TimeRangeSchema).optional(),
    wed: z.array(TimeRangeSchema).optional(),
    thu: z.array(TimeRangeSchema).optional(),
    fri: z.array(TimeRangeSchema).optional(),
    sat: z.array(TimeRangeSchema).optional(),
    sun: z.array(TimeRangeSchema).optional(),
  })
  .superRefine((v, ctx) => {
    for (const [day, ranges] of Object.entries(v)) {
      const problem = ranges ? validateHours(ranges) : null;
      if (problem) ctx.addIssue({ code: 'custom', path: [day], message: problem });
    }
  });

export const CalendarInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  timezone: z.string().refine((tz) => DateTime.local().setZone(tz).isValid, 'unknown timezone'),
  slotMinutes: z.number().int().min(5).max(480).default(30),
  slotIntervalMinutes: z.number().int().min(5).max(480).nullable().default(null),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 30).default(120),
  maxDaysAhead: z.number().int().min(1).max(365).default(30),
  maxPerDay: z.number().int().min(1).max(500).nullable().default(null),
  weeklyHours: WeeklyHoursSchema,
  dateOverrides: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hours: z.array(TimeRangeSchema) }))
    .max(366)
    .default([]),
  isActive: z.boolean().default(true),
  location: z.string().trim().max(300).default(''),
  customerInstructions: z.string().trim().max(2000).default(''),
  sendConfirmations: z.boolean().default(true),
  /** Minutes before the start; whole days keep the local time of day. At most three. */
  reminderMinutes: z
    .array(z.number().int().min(30).max(60 * 24 * 7))
    .max(3)
    .default([1440])
    .transform((list) => [...new Set(list)].sort((a, b) => b - a)),
  replyToEmail: z.preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email().max(254).nullable()).default(null),
  /** How late the AI may still move or cancel a booking for the customer; null = until it starts. */
  minCancelNoticeMinutes: z.number().int().min(0).max(60 * 24 * 30).nullable().default(null),
});

type CalendarRow = typeof schema.calendars.$inferSelect;
type AppointmentRow = typeof schema.appointments.$inferSelect;
export type AppointmentView = ReturnType<typeof toAppointmentView>;
type Actor = 'ai' | 'user' | 'contact';

export function toAppointmentView(a: AppointmentRow) {
  const local = DateTime.fromJSDate(a.startsAt, { zone: a.timezone });
  return {
    id: a.id,
    calendarId: a.calendarId,
    contactId: a.contactId,
    conversationId: a.conversationId,
    title: a.title,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    timezone: a.timezone,
    localStart: local.toFormat("yyyy-LL-dd'T'HH:mm"),
    label: formatSlotLabel(local),
    status: a.status,
    notes: a.notes,
    createdBy: a.createdBy,
    cancelReason: a.cancelReason,
    createdAt: a.createdAt,
  };
}

function rulesOf(c: CalendarRow): CalendarRules {
  return {
    timezone: c.timezone,
    slotMinutes: c.slotMinutes,
    slotIntervalMinutes: c.slotIntervalMinutes,
    bufferMinutes: c.bufferMinutes,
    minNoticeMinutes: c.minNoticeMinutes,
    maxDaysAhead: c.maxDaysAhead,
    maxPerDay: c.maxPerDay,
    weeklyHours: c.weeklyHours,
    dateOverrides: c.dateOverrides,
  };
}

const EXCLUSION_VIOLATION = '23P01';

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export class SchedulingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly providers: CalendarProviderRegistry,
    private readonly clock: () => Date = () => new Date(),
    /** Called after a change that planned customer emails commits, so the sender can go now instead of on its timer. */
    private readonly onEmailsPlanned: () => void = () => {},
  ) {}

  // ---------- calendars ----------

  async listCalendars(scope: Scope) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx.select().from(schema.calendars).where(eq(schema.calendars.organizationId, scope.orgId)).orderBy(asc(schema.calendars.createdAt)),
    );
  }

  async getCalendar(scope: Scope, id: string) {
    return inScope(this.tenantDb, scope, (tx) => this.calendarRow(tx, scope.orgId, id));
  }

  async createCalendar(scope: Scope, input: z.infer<typeof CalendarInputSchema>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx.insert(schema.calendars).values({ organizationId: scope.orgId, ...input }).returning();
      return row!;
    });
  }

  async updateCalendar(scope: Scope, id: string, input: Partial<z.infer<typeof CalendarInputSchema>>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(schema.calendars)
        .set(input)
        .where(and(eq(schema.calendars.id, id), eq(schema.calendars.organizationId, scope.orgId)))
        .returning();
      if (!row) throw notFound('Calendar');
      return row;
    });
  }

  async deleteCalendar(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const deleted = await tx
        .delete(schema.calendars)
        .where(and(eq(schema.calendars.id, id), eq(schema.calendars.organizationId, scope.orgId)))
        .returning({ id: schema.calendars.id });
      if (!deleted.length) throw notFound('Calendar');
    });
  }

  // ---------- availability ----------

  async availability(scope: Scope, calendarId: string, range: { from?: string; to?: string; limit?: number }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const calendar = await this.calendarRow(tx, scope.orgId, calendarId);
      if (!calendar.isActive) throw badRequest('This calendar is not accepting bookings');
      const now = this.clock();
      const today = DateTime.fromJSDate(now, { zone: calendar.timezone }).toISODate()!;
      const from = range.from && range.from > today ? range.from : today;
      const to = range.to ?? DateTime.fromISO(from).plus({ days: 7 }).toISODate()!;
      const { busy, perDay } = await this.busy(tx, calendar, from, to);
      return {
        calendar: { id: calendar.id, name: calendar.name, timezone: calendar.timezone, slotMinutes: calendar.slotMinutes },
        slots: computeSlots(rulesOf(calendar), busy, { from, to }, now, { limit: range.limit ?? 200, bookedPerDay: perDay }),
      };
    });
  }

  private async busy(tx: Db, calendar: CalendarRow, fromDate: string, toDate: string): Promise<{ busy: Interval[]; perDay: Map<string, number> }> {
    const start = DateTime.fromISO(fromDate, { zone: calendar.timezone }).minus({ days: 1 }).toJSDate();
    const end = DateTime.fromISO(toDate, { zone: calendar.timezone }).plus({ days: 2 }).toJSDate();
    const booked = await tx
      .select({ startsAt: schema.appointments.startsAt, endsAt: schema.appointments.endsAt })
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.calendarId, calendar.id),
          eq(schema.appointments.status, 'booked'),
          lt(schema.appointments.startsAt, end),
          gte(schema.appointments.endsAt, start),
        ),
      );
    const external = await this.providers.get(calendar.provider).busy(calendar, start, end);
    const perDay = new Map<string, number>();
    for (const b of booked) {
      const day = DateTime.fromJSDate(b.startsAt, { zone: calendar.timezone }).toISODate()!;
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    return { busy: [...booked.map((b) => ({ start: b.startsAt, end: b.endsAt })), ...external], perDay };
  }

  // ---------- appointments ----------

  /**
   * Books a slot. Bookings on one calendar are taken one at a time and availability is re-checked inside the
   * transaction; the Postgres exclusion constraint is the final arbiter for overlapping times. Asking again for
   * a slot this contact already holds returns that booking (`duplicate`), e.g. a retried AI turn or a double click.
   */
  async book(
    scope: Scope,
    input: {
      calendarId: string;
      contactId: string;
      conversationId?: string | null;
      start: Date;
      title: string;
      notes?: string;
      createdBy: Actor;
      /** Staff can book without emailing the customer (default: email them). */
      notifyCustomer?: boolean;
    },
  ): Promise<{ appointment: AppointmentView; duplicate: boolean; customerEmail: CustomerEmailOutcome }> {
    try {
      const result = await inScope(this.tenantDb, scope, async (tx) => {
        await this.lockCalendar(tx, input.calendarId);
        const [existing] = await tx
          .select()
          .from(schema.appointments)
          .where(
            and(
              eq(schema.appointments.organizationId, scope.orgId),
              eq(schema.appointments.calendarId, input.calendarId),
              eq(schema.appointments.contactId, input.contactId),
              eq(schema.appointments.startsAt, input.start),
              eq(schema.appointments.status, 'booked'),
            ),
          );
        if (existing) return { appointment: toAppointmentView(existing), duplicate: true, customerEmail: await confirmationState(tx, existing.id) };
        const calendar = await this.calendarRow(tx, scope.orgId, input.calendarId);
        if (!calendar.isActive) throw badRequest('This calendar is not accepting bookings');
        const day = DateTime.fromJSDate(input.start, { zone: calendar.timezone }).toISODate()!;
        const { busy, perDay } = await this.busy(tx, calendar, day, day);
        const problem = checkSlot(rulesOf(calendar), busy, input.start, this.clock(), perDay);
        if (problem) throw new AppError(409, 'slot_unavailable', problem);
        const endsAt = new Date(input.start.getTime() + calendar.slotMinutes * 60_000);
        const notify = input.notifyCustomer ?? true;
        const [row] = await tx
          .insert(schema.appointments)
          .values({
            organizationId: scope.orgId,
            calendarId: calendar.id,
            contactId: input.contactId,
            conversationId: input.conversationId ?? null,
            title: input.title.slice(0, 200),
            startsAt: input.start,
            endsAt,
            timezone: calendar.timezone,
            notes: (input.notes ?? '').slice(0, 2000),
            createdBy: input.createdBy,
            notifyCustomer: notify,
          })
          .returning();
        await this.providers.get(calendar.provider).onBooked?.(calendar, row!);
        const [contact] = await tx
          .select({ stage: schema.contacts.lifecycleStage })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, input.contactId));
        if (contact && ['new', 'engaged', 'qualified'].includes(contact.stage)) {
          await tx.update(schema.contacts).set({ lifecycleStage: 'booked' }).where(eq(schema.contacts.id, input.contactId));
        }
        const view = toAppointmentView(row!);
        await recordEvent(tx, {
          orgId: scope.orgId,
          type: 'appointment.booked',
          actor: input.createdBy,
          contactId: input.contactId,
          conversationId: input.conversationId,
          payload: { appointment: view, calendarName: calendar.name },
        });
        const customerEmail = await planBooked(tx, { orgId: scope.orgId, appointment: row!, calendar, now: this.clock(), notify });
        return { appointment: view, duplicate: false, customerEmail };
      });
      if (!result.duplicate) this.onEmailsPlanned();
      return result;
    } catch (err) {
      if (pgCode(err) === EXCLUSION_VIOLATION) throw new AppError(409, 'slot_unavailable', 'That time was just booked by someone else.');
      throw err;
    }
  }

  async reschedule(
    scope: Scope,
    appointmentId: string,
    newStart: Date,
    opts: { actor: Actor; contactId?: string; notifyCustomer?: boolean },
  ): Promise<AppointmentView & { customerEmail: CustomerEmailOutcome }> {
    let moved = false;
    try {
      const result = await inScope(this.tenantDb, scope, async (tx) => {
        const appt = await this.appointmentRow(tx, scope.orgId, appointmentId, opts.contactId);
        if (appt.status !== 'booked') throw badRequest('Only booked appointments can be rescheduled');
        // Already at that time (a repeated request): nothing to change.
        if (appt.startsAt.getTime() === newStart.getTime()) return { ...toAppointmentView(appt), customerEmail: notQueued('unchanged') };
        await this.lockCalendar(tx, appt.calendarId);
        const calendar = await this.calendarRow(tx, scope.orgId, appt.calendarId);
        this.assertChangeAllowed(calendar, appt, opts.actor);
        const day = DateTime.fromJSDate(newStart, { zone: calendar.timezone }).toISODate()!;
        const { busy, perDay } = await this.busy(tx, calendar, day, day);
        const others = busy.filter((b) => !(b.start.getTime() === appt.startsAt.getTime() && b.end.getTime() === appt.endsAt.getTime()));
        const sameDay = DateTime.fromJSDate(appt.startsAt, { zone: calendar.timezone }).toISODate() === day;
        if (sameDay) perDay.set(day, Math.max(0, (perDay.get(day) ?? 1) - 1));
        const problem = checkSlot(rulesOf(calendar), others, newStart, this.clock(), perDay);
        if (problem) throw new AppError(409, 'slot_unavailable', problem);
        const previous = toAppointmentView(appt);
        const [row] = await tx
          .update(schema.appointments)
          .set({ startsAt: newStart, endsAt: new Date(newStart.getTime() + calendar.slotMinutes * 60_000) })
          .where(and(eq(schema.appointments.id, appt.id), eq(schema.appointments.status, 'booked')))
          .returning();
        if (!row) throw conflict('This appointment was just cancelled');
        await this.providers.get(calendar.provider).onRescheduled?.(calendar, row);
        const view = toAppointmentView(row!);
        await recordEvent(tx, {
          orgId: scope.orgId,
          type: 'appointment.rescheduled',
          actor: opts.actor,
          contactId: appt.contactId,
          conversationId: appt.conversationId,
          payload: { appointment: view, previousStart: previous.startsAt, previousLabel: previous.label },
        });
        const customerEmail = await planMoved(tx, {
          orgId: scope.orgId,
          appointment: row!,
          calendar,
          now: this.clock(),
          notify: opts.notifyCustomer ?? true,
        });
        moved = true;
        return { ...view, customerEmail };
      });
      if (moved) this.onEmailsPlanned();
      return result;
    } catch (err) {
      if (pgCode(err) === EXCLUSION_VIOLATION) throw new AppError(409, 'slot_unavailable', 'That time was just booked by someone else.');
      throw err;
    }
  }

  async cancel(
    scope: Scope,
    appointmentId: string,
    opts: { actor: Actor; reason?: string; contactId?: string; notifyCustomer?: boolean },
  ): Promise<AppointmentView & { customerEmail: CustomerEmailOutcome }> {
    let cancelled = false;
    const result = await inScope(this.tenantDb, scope, async (tx) => {
      const appt = await this.appointmentRow(tx, scope.orgId, appointmentId, opts.contactId);
      // Already cancelled (a repeated request): report it as it is, without a second event.
      if (appt.status === 'cancelled') return { ...toAppointmentView(appt), customerEmail: notQueued('unchanged') };
      if (appt.status !== 'booked') throw badRequest(`Appointment is already ${appt.status}`);
      const calendar = await this.calendarRow(tx, scope.orgId, appt.calendarId);
      this.assertChangeAllowed(calendar, appt, opts.actor);
      const [row] = await tx
        .update(schema.appointments)
        .set({ status: 'cancelled', cancelReason: opts.reason?.slice(0, 500) ?? null })
        .where(and(eq(schema.appointments.id, appt.id), eq(schema.appointments.status, 'booked')))
        .returning();
      // A simultaneous request cancelled it first: same outcome, and that request records the event and the email.
      if (!row) return { ...toAppointmentView(await this.appointmentRow(tx, scope.orgId, appt.id)), customerEmail: notQueued('unchanged') };
      await this.providers.get(calendar.provider).onCancelled?.(calendar, row);
      const view = toAppointmentView(row);
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'appointment.cancelled',
        actor: opts.actor,
        contactId: appt.contactId,
        conversationId: appt.conversationId,
        payload: { appointment: view, reason: opts.reason ?? null },
      });
      const customerEmail = await planCancelled(tx, {
        orgId: scope.orgId,
        appointment: row,
        calendar,
        now: this.clock(),
        notify: opts.notifyCustomer ?? true,
      });
      cancelled = true;
      return { ...view, customerEmail };
    });
    if (cancelled) this.onEmailsPlanned();
    return result;
  }

  async setStatus(scope: Scope, appointmentId: string, status: Exclude<AppointmentStatus, 'booked' | 'cancelled'>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const appt = await this.appointmentRow(tx, scope.orgId, appointmentId);
      const [row] = await tx.update(schema.appointments).set({ status }).where(eq(schema.appointments.id, appt.id)).returning();
      await cancelPending(tx, appt.id, 'appointment_ended');
      return toAppointmentView(row!);
    });
  }

  /** The emails to the customer about one appointment, oldest first: the log staff see. */
  async listEmails(scope: Scope, appointmentId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.appointmentRow(tx, scope.orgId, appointmentId);
      const n = schema.appointmentNotifications;
      return tx
        .select({
          id: n.id,
          kind: n.kind,
          status: n.status,
          reason: n.reason,
          error: n.error,
          sendAt: n.sendAt,
          sentAt: n.sentAt,
          recipient: n.recipient,
          reminderMinutes: n.reminderMinutes,
          attempts: n.attempts,
          createdAt: n.createdAt,
        })
        .from(n)
        .where(and(eq(n.appointmentId, appointmentId), eq(n.organizationId, scope.orgId)))
        .orderBy(asc(n.createdAt), asc(n.sendAt));
    });
  }

  /** Staff: (re)send the confirmation. A booking made without emails starts getting them, reminders included. */
  async resendConfirmation(scope: Scope, appointmentId: string): Promise<CustomerEmailOutcome> {
    const outcome = await inScope(this.tenantDb, scope, async (tx) => {
      const appt = await this.appointmentRow(tx, scope.orgId, appointmentId);
      if (appt.status !== 'booked') throw badRequest('Only a booked appointment can be confirmed');
      const calendar = await this.calendarRow(tx, scope.orgId, appt.calendarId);
      const [row] = appt.notifyCustomer
        ? [appt]
        : await tx.update(schema.appointments).set({ notifyCustomer: true }).where(eq(schema.appointments.id, appt.id)).returning();
      return planResend(tx, { orgId: scope.orgId, appointment: row!, calendar, now: this.clock(), notify: true });
    });
    this.onEmailsPlanned();
    return outcome;
  }

  async getAppointment(scope: Scope, id: string) {
    return inScope(this.tenantDb, scope, async (tx) => toAppointmentView(await this.appointmentRow(tx, scope.orgId, id)));
  }

  async listForContact(scope: Scope, contactId: string, opts: { upcomingOnly?: boolean } = {}) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const where: SQL[] = [eq(schema.appointments.organizationId, scope.orgId), eq(schema.appointments.contactId, contactId)];
      if (opts.upcomingOnly) {
        where.push(eq(schema.appointments.status, 'booked'), gte(schema.appointments.startsAt, this.clock()));
      }
      const rows = await tx.select().from(schema.appointments).where(and(...where)).orderBy(asc(schema.appointments.startsAt)).limit(50);
      return rows.map(toAppointmentView);
    });
  }

  /** The contact's latest appointments that have already started (whatever the outcome), newest first. */
  async pastForContact(scope: Scope, contactId: string, opts: { limit: number; sinceDays: number }) {
    const now = this.clock();
    const since = new Date(now.getTime() - opts.sinceDays * 86_400_000);
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.appointments)
        .where(
          and(
            eq(schema.appointments.organizationId, scope.orgId),
            eq(schema.appointments.contactId, contactId),
            lt(schema.appointments.startsAt, now),
            gte(schema.appointments.startsAt, since),
          ),
        )
        .orderBy(desc(schema.appointments.startsAt))
        .limit(opts.limit);
      return rows.map(toAppointmentView);
    });
  }

  async list(scope: Scope, filters: { from?: Date; to?: Date; calendarId?: string; status?: AppointmentStatus }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const where: SQL[] = [eq(schema.appointments.organizationId, scope.orgId)];
      if (filters.from) where.push(gte(schema.appointments.startsAt, filters.from));
      if (filters.to) where.push(lt(schema.appointments.startsAt, filters.to));
      if (filters.calendarId) where.push(eq(schema.appointments.calendarId, filters.calendarId));
      if (filters.status) where.push(eq(schema.appointments.status, filters.status));
      const rows = await tx
        .select({
          appointment: schema.appointments,
          contactFirstName: schema.contacts.firstName,
          contactLastName: schema.contacts.lastName,
          contactEmail: schema.contacts.email,
          contactPhone: schema.contacts.phone,
        })
        .from(schema.appointments)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.appointments.contactId))
        .where(and(...where))
        .orderBy(asc(schema.appointments.startsAt))
        .limit(500);
      return rows.map((r) => ({
        ...toAppointmentView(r.appointment),
        contact: {
          name: [r.contactFirstName, r.contactLastName].filter(Boolean).join(' ') || null,
          email: r.contactEmail,
          phone: r.contactPhone,
        },
      }));
    });
  }

  async calendarsById(scope: Scope, ids: string[]) {
    if (!ids.length) return [];
    return inScope(this.tenantDb, scope, (tx) =>
      tx.select().from(schema.calendars).where(and(eq(schema.calendars.organizationId, scope.orgId), inArray(schema.calendars.id, ids))),
    );
  }

  /**
   * The AI acts for the customer, so the calendar's change policy applies to it (and nothing can be changed once the
   * appointment has started). Staff can always change a booking.
   */
  private assertChangeAllowed(calendar: CalendarRow, appt: AppointmentRow, actor: Actor): void {
    if (actor === 'user') return;
    const now = this.clock().getTime();
    const start = appt.startsAt.getTime();
    if (now >= start) throw new AppError(409, 'change_window_closed', 'This appointment has already started, so it can no longer be changed here.');
    const notice = calendar.minCancelNoticeMinutes;
    if (notice && now > start - notice * 60_000) {
      throw new AppError(
        409,
        'change_window_closed',
        `Changes and cancellations are only possible until ${noticeLabel(notice)} before the appointment, and this one starts sooner than that.`,
      );
    }
  }

  /**
   * Takes bookings on one calendar one at a time, until the transaction ends. The exclusion constraint only stops
   * overlapping appointments; buffers and the daily cap are checked in code, which is only safe one at a time.
   */
  private async lockCalendar(tx: Db, calendarId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`calendar:${calendarId}`}, 0))`);
  }

  private async calendarRow(tx: Db, orgId: string, id: string): Promise<CalendarRow> {
    const [row] = await tx
      .select()
      .from(schema.calendars)
      .where(and(eq(schema.calendars.id, id), eq(schema.calendars.organizationId, orgId)));
    if (!row) throw notFound('Calendar');
    return row;
  }

  /** When `contactId` is given the appointment must belong to that contact (AI tools act for one person only). */
  private async appointmentRow(tx: Db, orgId: string, id: string, contactId?: string): Promise<AppointmentRow> {
    const where: SQL[] = [eq(schema.appointments.id, id), eq(schema.appointments.organizationId, orgId)];
    if (contactId) where.push(eq(schema.appointments.contactId, contactId));
    const [row] = await tx.select().from(schema.appointments).where(and(...where));
    if (!row) throw notFound('Appointment');
    return row;
  }
}

