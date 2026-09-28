import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_helpers';
import { organizations } from './core';
import { contacts } from './crm';
import { conversations } from './conversations';

export interface TimeRange {
  /** "HH:mm" 24h local time */
  start: string;
  end: string;
}

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WeeklyHours = Partial<Record<Weekday, TimeRange[]>>;

export interface DateOverride {
  /** "YYYY-MM-DD" in the calendar's timezone */
  date: string;
  /** Empty = closed that day. */
  hours: TimeRange[];
}

export const calendars = pgTable(
  'calendars',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    timezone: text().notNull(),
    slotMinutes: integer().notNull().default(30),
    /** Step between slot start times; defaults to slotMinutes. */
    slotIntervalMinutes: integer(),
    bufferMinutes: integer().notNull().default(0),
    minNoticeMinutes: integer().notNull().default(120),
    maxDaysAhead: integer().notNull().default(30),
    maxPerDay: integer(),
    weeklyHours: jsonb().$type<WeeklyHours>().notNull(),
    dateOverrides: jsonb().$type<DateOverride[]>().notNull().default([]),
    provider: text().$type<'internal' | 'google' | 'ghl'>().notNull().default('internal'),
    providerConfig: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean().notNull().default(true),
    /** Shown to the customer in emails and the calendar file: an address, "Video call", … */
    location: text().notNull().default(''),
    /** Added to the customer's emails, e.g. "Please arrive 10 minutes early." */
    customerInstructions: text().notNull().default(''),
    /** Email the customer a confirmation, and a notice when the booking moves or is cancelled. */
    sendConfirmations: boolean().notNull().default(true),
    /** Reminder emails, in minutes before the start (whole days keep the local time of day); [] = none. */
    reminderMinutes: jsonb().$type<number[]>().notNull().default([1440]),
    replyToEmail: text(),
    /**
     * How long before the start the AI (acting for the customer) may still move or cancel a booking; null = until
     * it starts. Staff always can.
     */
    minCancelNoticeMinutes: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('calendars_org_idx').on(t.organizationId)],
);

export type AppointmentStatus = 'booked' | 'cancelled' | 'completed' | 'no_show';

export const appointments = pgTable(
  'appointments',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    calendarId: uuid().notNull().references(() => calendars.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    title: text().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    timezone: text().notNull(),
    status: text().$type<AppointmentStatus>().notNull().default('booked'),
    notes: text().notNull().default(''),
    createdBy: text().$type<'ai' | 'user' | 'contact'>().notNull().default('user'),
    cancelReason: text(),
    rescheduledFromId: uuid(),
    externalEventId: text(),
    idempotencyKey: text().unique(),
    /** Emails to the customer about this booking; staff can book without them. */
    notifyCustomer: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('appointments_org_starts_idx').on(t.organizationId, t.startsAt),
    index('appointments_calendar_starts_idx').on(t.calendarId, t.startsAt),
    index('appointments_contact_idx').on(t.contactId),
  ],
);

export type AppointmentEmailKind = 'confirmation' | 'update' | 'cancellation' | 'reminder';
export type AppointmentEmailStatus = 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'cancelled';

/**
 * Emails to the customer about an appointment: one row per email, written in the same transaction as the booking
 * change, sent by a worker when due. Also the log staff see.
 */
export const appointmentNotifications = pgTable(
  'appointment_notifications',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    appointmentId: uuid().notNull().references(() => appointments.id, { onDelete: 'cascade' }),
    kind: text().$type<AppointmentEmailKind>().notNull(),
    channel: text().$type<'email'>().notNull().default('email'),
    status: text().$type<AppointmentEmailStatus>().notNull().default('pending'),
    /** Why it was skipped or cancelled, as a short code (no_email, appointment_moved, …). */
    reason: text(),
    /** The provider's error for a failed attempt. */
    error: text(),
    sendAt: timestamp({ withTimezone: true }).notNull(),
    /** The start time this email was written for: a reminder for a booking that has since moved is dropped. */
    forStartsAt: timestamp({ withTimezone: true }).notNull(),
    /** Reminders: minutes before the start. */
    reminderMinutes: integer(),
    /** Where it went (or is going). */
    recipient: text(),
    attempts: integer().notNull().default(0),
    /** While `sending`: another worker may take it over after this time. */
    leaseUntil: ts(),
    sentAt: ts(),
    providerMessageId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('appointment_notifications_due_idx').on(t.sendAt).where(sql`status in ('pending', 'sending')`),
    index('appointment_notifications_appointment_idx').on(t.appointmentId, t.createdAt),
  ],
);
