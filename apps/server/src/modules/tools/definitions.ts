import { DateTime } from 'luxon';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import type { AutomationService } from '../automation/service';
import { STANDARD_LEAD_FIELDS } from '../bots/config';
import type { ContactsService } from '../contacts/service';
import type { DealsService, DealView } from '../deals/service';
import type { KnowledgeService } from '../knowledge/service';
import { consentVersion, isPlainNo } from '../leads/attribution';
import type { QualificationService } from '../leads/qualification';
import { parseLocalStart } from '../scheduling/availability';
import { changePolicy, customerTime, type CustomerEmailOutcome } from '../scheduling/notifications';
import type { SchedulingService } from '../scheduling/service';
import { defineTool, type ToolContext, type ToolDefinition, type ToolOutcome, type ToolSchemaContext } from './types';

export interface ToolDeps {
  contacts: ContactsService;
  qualification: QualificationService;
  knowledge: KnowledgeService;
  scheduling: SchedulingService;
  automation: AutomationService;
  deals: DealsService;
}

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day (YYYY-MM-DD). */
const Day = z
  .string()
  .regex(DATE)
  .refine((d) => DateTime.fromISO(d, { zone: 'utc' }).isValid, 'not a real date');
/** What a deal tool shows the model of a deal. */
const dealSummary = (d: DealView, stages: Array<{ id: string; name: string }>) => ({
  id: d.id,
  title: d.title,
  stage: stages.find((s) => s.id === d.stageId)?.name ?? null,
  value: d.value,
  currency: d.currency,
  status: d.status,
});

const scope = (ctx: ToolContext) => ({ orgId: ctx.orgId });

function fail(error: string, data?: Record<string, unknown>): ToolOutcome {
  return { ok: false, error, data };
}

/** Errors from our own services (4xx) are safe and useful to show the model; anything else is not. */
function toOutcome(err: unknown): ToolOutcome {
  if (err instanceof AppError && err.statusCode < 500) return fail(err.message);
  throw err;
}

/** Too close to the appointment for the AI to change it: point to the team instead of promising the change. */
function changeRefused(err: unknown, ctx: ToolContext): ToolOutcome {
  if (err instanceof AppError && err.code === 'change_window_closed') {
    return fail(
      ctx.bot.config.handoff.enabled
        ? `${err.message} Don't promise the change: explain the policy and offer to connect them with the team (transfer_to_human).`
        : `${err.message} Don't promise the change: explain the policy and suggest they contact the business directly.`,
    );
  }
  return toOutcome(err);
}

/** How a booking tool reports the email the customer gets, so the reply never claims one that isn't coming. */
function emailResult(prefix: 'confirmation' | 'update' | 'cancellation', outcome: CustomerEmailOutcome): Record<string, unknown> {
  const key = prefix === 'confirmation' ? 'customer_confirmation_sent' : `customer_${prefix}_email_sent`;
  return outcome.queued
    ? { [key]: true, ...(prefix === 'confirmation' && outcome.to ? { confirmation_email: outcome.to } : {}) }
    : { [key]: false, [`${prefix === 'confirmation' ? 'confirmation' : prefix}_not_sent_reason`]: outcome.reason };
}

function contactSummary(c: Awaited<ReturnType<ContactsService['get']>>) {
  return {
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    custom_fields: c.customFields,
  };
}

export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { contacts, qualification, knowledge, scheduling, automation, deals } = deps;

  const saveContactDetails = defineTool({
    key: 'save_contact_details',
    activity: 'Saving your details…',
    description: (ctx) =>
      [
        'Save contact details the customer has shared (name, email, phone, company' +
          (ctx.customFields.some((f) => f.aiWritable) ? ', and custom fields' : '') +
          ').',
        'Call this immediately whenever the customer gives any of these details — even partially, even mid-conversation — rather than waiting until the end.',
        'Pass values exactly as the customer gave them; they are validated and normalized server-side. An invalid value comes back as an error: ask the customer once to correct it, and don\'t insist on optional details.',
      ].join(' '),
    enabled: () => true,
    schema: (ctx) => {
      const writable = ctx.customFields.filter((f) => f.aiWritable);
      const custom = Object.fromEntries(
        writable.map((f) => [
          f.key,
          z
            .union([z.string(), z.number(), z.boolean()])
            .optional()
            .describe(`${f.label} (${f.type}${f.options.length ? `: ${f.options.join(' | ')}` : ''})${f.description ? ` — ${f.description}` : ''}`),
        ]),
      );
      return z.object({
        name: z.string().max(200).optional().describe('Full name as the customer gave it'),
        email: z.string().max(254).optional(),
        phone: z.string().max(40).optional().describe('Phone number as given, including any country code the customer mentioned'),
        company: z.string().max(200).optional(),
        timezone: z
          .string()
          .max(64)
          .optional()
          .describe('The customer\'s timezone as an IANA name (e.g. America/Vancouver), when they say where they are'),
        ...(writable.length ? { custom_fields: z.object(custom).optional().describe('Business-specific details') } : {}),
      });
    },
    async run(input, ctx) {
      const { custom_fields: customFields, ...rest } = input as { custom_fields?: Record<string, unknown> } & Record<string, string | undefined>;
      const cleanedCustom = customFields ? Object.fromEntries(Object.entries(customFields).filter(([, v]) => v !== undefined)) : undefined;
      const result = await contacts.captureDetails(
        scope(ctx),
        ctx.contactId,
        { name: rest.name, email: rest.email, phone: rest.phone, company: rest.company, timezone: rest.timezone, customFields: cleanedCustom },
        'ai',
        // What a visitor types is a claim, not proof of who they are: never merge them into another contact here.
        { trust: 'unverified', conversationId: ctx.conversationId },
      );
      if (result.contactId !== ctx.contactId) ctx.setContactId(result.contactId);
      const contact = await contacts.getForConversation(scope(ctx), result.contactId);
      const required = ctx.bot.config.leadCapture.fields.filter((f) => f.required);
      const stillNeeded = required
        .map((f) => f.field)
        .filter((field) => {
          if (field === 'name') return !contact.firstName;
          if ((STANDARD_LEAD_FIELDS as readonly string[]).includes(field)) return !contact[field as 'email' | 'phone' | 'company'];
          return contact.customFields[field] === undefined || contact.customFields[field] === null;
        });
      // A claimed email/phone reads like any other save, so the reply never reveals that another record has it.
      const saved = [...result.changed, ...result.claimed];
      const data = {
        saved,
        contact: contactSummary(contact),
        still_needed: stillNeeded,
        ...(result.mergedIntoId ? { note: 'These details matched an existing customer record; the conversation is now linked to it.' } : {}),
      };
      return result.errors.length && !saved.length ? fail(result.errors.join('; '), data) : { ok: true, data: { ...data, errors: result.errors } };
    },
  });

  const recordQualification = defineTool({
    key: 'record_qualification_answers',
    activity: 'Noting that…',
    description: () =>
      'Record the customer\'s answers to the qualification questions listed in your instructions. Call it as soon as an answer is given (several answers can go in one call). The result tells you which question to ask next and what to do once qualification is complete. Never reveal scores or that the customer is being scored.',
    enabled: (ctx) => ctx.bot.config.qualification.enabled && ctx.bot.config.qualification.questions.length > 0,
    schema: (ctx) => {
      const keys = ctx.bot.config.qualification.questions.map((q) => q.key) as [string, ...string[]];
      return z.object({
        answers: z
          .array(
            z.object({
              question_key: z.enum(keys),
              value: z
                .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
                .describe('The answer, using one of the listed options where the question has options'),
            }),
          )
          .min(1)
          .max(25),
      });
    },
    async run(input, ctx) {
      const config = ctx.bot.config.qualification;
      const result = await qualification.recordAnswers(scope(ctx), {
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
        botId: ctx.bot.id,
        config,
        answers: input.answers.map((a) => ({ questionKey: a.question_key, value: a.value })),
        actor: 'ai',
      });
      let guidance: string;
      if (result.status === 'qualified') {
        // Without the booking tool the bot can't book, so it never offers to.
        const canBook = bookingEnabled(ctx.schema) && !ctx.bot.config.actions.disabledTools.includes('book_appointment');
        guidance = {
          offer_booking: canBook
            ? 'Qualification complete: this lead is a good fit. Offer to book an appointment next.'
            : 'Qualification complete: this lead is a good fit. Make sure you have their contact details so the team can arrange an appointment.',
          collect_contact: 'Qualification complete: this lead is a good fit. Make sure you have their contact details so the team can follow up.',
          handoff: 'Qualification complete: this lead is a good fit. Transfer the conversation to the team now.',
          none: 'Qualification complete. Continue helping the customer.',
        }[config.qualifiedNextStep];
      } else if (result.status === 'disqualified') {
        guidance = config.disqualifiedMessage
          ? `Qualification complete: not a fit right now. Close politely along these lines: "${config.disqualifiedMessage}"`
          : 'Qualification complete: not a fit right now. Stay helpful and polite; do not push for a booking.';
      } else if (result.nextQuestion) {
        guidance = `Next, ask naturally: "${result.nextQuestion.question}"${result.nextQuestion.options.length ? ` (options: ${result.nextQuestion.options.join(', ')})` : ''}`;
      } else {
        guidance = 'All questions answered.';
      }
      return {
        ok: result.errors.length === 0 || result.accepted.length > 0,
        ...(result.errors.length && !result.accepted.length ? { error: result.errors.join('; ') } : {}),
        data: { recorded: result.accepted, errors: result.errors, status: result.status, guidance },
      } as ToolOutcome;
    },
  });

  const searchKnowledge = defineTool({
    key: 'search_knowledge_base',
    activity: 'Looking that up…',
    description: () =>
      'Search the business knowledge base (services, pricing, policies, FAQs). Call this whenever you need a fact about the business that is not already in the <knowledge> provided with the latest message — for example when the customer asks a follow-up or a different question. Answer only from what it returns.',
    enabled: (ctx) => ctx.bot.knowledgeBaseIds.length > 0,
    schema: () =>
      z.object({
        query: z.string().min(2).max(500).describe('A focused search query'),
        category: z.enum(['general', 'faq', 'services', 'pricing', 'policies', 'other']).optional(),
      }),
    async run(input, ctx) {
      const result = await knowledge.search(scope(ctx), {
        knowledgeBaseIds: ctx.bot.knowledgeBaseIds,
        query: input.query,
        category: input.category,
        limit: 5,
      });
      return {
        ok: true,
        data: {
          grounding: result.grounding,
          results: result.chunks.map((c) => ({ source_id: c.id, document_id: c.documentId, title: c.title, content: c.content, url: c.url })),
          ...(result.chunks.length ? {} : { note: 'Nothing relevant found. Do not guess — say you are not sure and offer to have the team follow up.' }),
        },
      };
    },
  });

  const bookingEnabled = (ctx: ToolSchemaContext) => ctx.bot.config.booking.enabled && Boolean(ctx.bot.config.booking.calendarId);

  const checkAvailability = defineTool({
    key: 'check_availability',
    activity: 'Checking availability…',
    description: () =>
      'Look up open appointment slots. Call this before proposing any times, and again whenever the customer asks about a different day. Only offer times this returns — never invent availability.',
    enabled: bookingEnabled,
    schema: () =>
      z.object({
        date_from: z.string().regex(DATE).optional().describe('First day to search, YYYY-MM-DD (calendar timezone). Defaults to today.'),
        date_to: z.string().regex(DATE).optional().describe('Last day to search, YYYY-MM-DD. Defaults to 6 days after date_from.'),
        time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
      }),
    async run(input, ctx) {
      const calendarId = ctx.bot.config.booking.calendarId!;
      try {
        const calendar = await scheduling.getCalendar(scope(ctx), calendarId);
        const { timezone: theirs } = await contacts.getForConversation(scope(ctx), ctx.contactId);
        const slot = (s: { local: string; label: string; start: string | Date }) => {
          const yours = customerTime(new Date(s.start), calendar.timezone, theirs);
          return { start: s.local, label: s.label, ...(yours ? { your_time: yours } : {}) };
        };
        const today = DateTime.fromJSDate(ctx.now, { zone: calendar.timezone }).toISODate()!;
        const from = input.date_from && input.date_from > today ? input.date_from : today;
        const to = input.date_to && input.date_to >= from ? input.date_to : DateTime.fromISO(from).plus({ days: 6 }).toISODate()!;
        const inWindow = (local: string) => {
          const hour = Number(local.slice(11, 13));
          if (!input.time_of_day || input.time_of_day === 'any') return true;
          if (input.time_of_day === 'morning') return hour < 12;
          if (input.time_of_day === 'afternoon') return hour >= 12 && hour < 17;
          return hour >= 17;
        };
        const { slots } = await scheduling.availability(scope(ctx), calendarId, { from, to, limit: 300 });
        const filtered = slots.filter((s) => inWindow(s.local));
        if (!filtered.length) {
          const later = await scheduling.availability(scope(ctx), calendarId, {
            from: DateTime.fromISO(to).plus({ days: 1 }).toISODate()!,
            to: DateTime.fromISO(to).plus({ days: 30 }).toISODate()!,
            limit: 300,
          });
          const next = later.slots.filter((s) => inWindow(s.local)).slice(0, 3);
          return {
            ok: true,
            data: {
              timezone: calendar.timezone,
              available: false,
              searched: { from, to },
              next_available: next.map(slot),
            },
          };
        }
        const byDay = new Map<string, Array<ReturnType<typeof slot>>>();
        for (const s of filtered) {
          const day = s.local.slice(0, 10);
          const list = byDay.get(day) ?? [];
          if (list.length < 6) list.push(slot(s));
          byDay.set(day, list);
        }
        return {
          ok: true,
          data: {
            timezone: calendar.timezone,
            ...(theirs && theirs !== calendar.timezone ? { customer_timezone: theirs } : {}),
            duration_minutes: calendar.slotMinutes,
            available: true,
            days: [...byDay.entries()].slice(0, 5).map(([date, times]) => ({ date, times })),
            note: 'Offer two or three of these options rather than reading out the whole list. Pass the chosen "start" value to book_appointment.',
          },
        };
      } catch (err) {
        return toOutcome(err);
      }
    },
  });

  const bookAppointment = defineTool({
    key: 'book_appointment',
    activity: 'Booking your appointment…',
    description: (ctx) =>
      [
        'Book an appointment in an open slot returned by check_availability.',
        'Before calling: the customer must have explicitly confirmed the exact date and time, and you must have saved their',
        ctx.bot.config.booking.requiredFields.join(', ') + '.',
        'Set customer_confirmed=true only after they confirmed.',
      ].join(' '),
    enabled: bookingEnabled,
    schema: () =>
      z.object({
        start: z.string().regex(LOCAL_DATETIME).describe('Slot start exactly as returned by check_availability (YYYY-MM-DDTHH:mm, calendar timezone)'),
        notes: z.string().max(1000).optional().describe('What the appointment is about, in a sentence'),
        customer_confirmed: z.boolean(),
      }),
    async run(input, ctx) {
      const booking = ctx.bot.config.booking;
      if (!input.customer_confirmed) {
        return fail('Confirm the exact date and time with the customer first, then call again with customer_confirmed=true.');
      }
      const contact = await contacts.getForConversation(scope(ctx), ctx.contactId);
      const missing = booking.requiredFields.filter((f) => (f === 'name' ? !contact.firstName : !contact[f]));
      if (missing.length) {
        return fail(`Before booking, ask for and save (with save_contact_details) the customer's ${missing.join(' and ')}.`);
      }
      if (booking.requireQualification && contact.qualificationStatus !== 'qualified') {
        return fail('Bookings are only for qualified leads. Finish the qualification questions first.');
      }
      try {
        const calendar = await scheduling.getCalendar(scope(ctx), booking.calendarId!);
        const start = parseLocalStart(input.start, calendar.timezone);
        if (!start) return fail('Invalid start time. Use the exact "start" value from check_availability.');
        const result = await scheduling.book(scope(ctx), {
          calendarId: calendar.id,
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          start,
          title: `${booking.appointmentTitle}${contact.name ? ` with ${contact.name}` : ''}`,
          notes: input.notes,
          createdBy: 'ai',
        });
        const yours = customerTime(result.appointment.startsAt, calendar.timezone, contact.timezone);
        return {
          ok: true,
          data: {
            booked: true,
            appointment_id: result.appointment.id,
            when: result.appointment.label,
            timezone: result.appointment.timezone,
            ...(yours ? { your_time: yours } : {}),
            duration_minutes: calendar.slotMinutes,
            // The customer already had this exact slot (asked again, or a retried turn): no new booking was made.
            ...(result.duplicate ? { already_booked: true } : {}),
            // True only when a confirmation email is really on its way to the customer's own address.
            ...emailResult('confirmation', result.customerEmail),
            changes_allowed_until: changePolicy(calendar),
          },
        };
      } catch (err) {
        if (err instanceof AppError && err.code === 'slot_unavailable') {
          return fail(`${err.message} Call check_availability again and offer the customer other times.`);
        }
        return toOutcome(err);
      }
    },
  });

  const listAppointments = defineTool({
    key: 'list_my_appointments',
    description: () =>
      "List this customer's upcoming appointments. Call it when they ask about, want to change, or want to cancel an existing booking.",
    enabled: bookingEnabled,
    schema: () => z.object({}),
    async run(_input, ctx) {
      const upcoming = await scheduling.listForContact(scope(ctx), ctx.contactId, { upcomingOnly: true });
      const calendars = new Map((await scheduling.calendarsById(scope(ctx), [...new Set(upcoming.map((a) => a.calendarId))])).map((c) => [c.id, c]));
      const { timezone: theirs } = await contacts.getForConversation(scope(ctx), ctx.contactId);
      return {
        ok: true,
        data: {
          appointments: upcoming.map((a) => {
            const calendar = calendars.get(a.calendarId);
            const yours = customerTime(a.startsAt, a.timezone, theirs);
            return {
              appointment_id: a.id,
              title: a.title,
              when: a.label,
              timezone: a.timezone,
              ...(yours ? { your_time: yours } : {}),
              ...(calendar ? { changes_allowed_until: changePolicy(calendar) } : {}),
            };
          }),
        },
      };
    },
  });

  const rescheduleAppointment = defineTool({
    key: 'reschedule_appointment',
    activity: 'Rescheduling…',
    description: () =>
      "Move one of this customer's upcoming appointments to a new open slot. Check availability first and get the customer's explicit confirmation of the new time.",
    enabled: (ctx) => bookingEnabled(ctx) && ctx.bot.config.booking.allowReschedule,
    schema: () =>
      z.object({
        appointment_id: z.string().uuid().describe('From list_my_appointments'),
        new_start: z.string().regex(LOCAL_DATETIME).describe('New slot start from check_availability'),
        customer_confirmed: z.boolean(),
      }),
    async run(input, ctx) {
      if (!input.customer_confirmed) return fail('Confirm the new time with the customer first.');
      try {
        const calendar = await scheduling.getCalendar(scope(ctx), ctx.bot.config.booking.calendarId!);
        const start = parseLocalStart(input.new_start, calendar.timezone);
        if (!start) return fail('Invalid new_start. Use the exact "start" value from check_availability.');
        const appt = await scheduling.reschedule(scope(ctx), input.appointment_id, start, { actor: 'ai', contactId: ctx.contactId });
        const { timezone: theirs } = await contacts.getForConversation(scope(ctx), ctx.contactId);
        const yours = customerTime(appt.startsAt, appt.timezone, theirs);
        return {
          ok: true,
          data: {
            rescheduled: true,
            appointment_id: appt.id,
            when: appt.label,
            timezone: appt.timezone,
            ...(yours ? { your_time: yours } : {}),
            ...emailResult('update', appt.customerEmail),
          },
        };
      } catch (err) {
        return changeRefused(err, ctx);
      }
    },
  });

  const cancelAppointment = defineTool({
    key: 'cancel_appointment',
    activity: 'Cancelling…',
    description: () =>
      "Cancel one of this customer's upcoming appointments after they explicitly confirm they want to cancel. Offer to reschedule instead first.",
    enabled: (ctx) => bookingEnabled(ctx) && ctx.bot.config.booking.allowCancel,
    schema: () =>
      z.object({
        appointment_id: z.string().uuid(),
        reason: z.string().max(500).optional(),
        customer_confirmed: z.boolean(),
      }),
    async run(input, ctx) {
      if (!input.customer_confirmed) return fail('Confirm with the customer that they want to cancel first.');
      try {
        const appt = await scheduling.cancel(scope(ctx), input.appointment_id, { actor: 'ai', reason: input.reason, contactId: ctx.contactId });
        return { ok: true, data: { cancelled: true, appointment_id: appt.id, was: appt.label, ...emailResult('cancellation', appt.customerEmail) } };
      } catch (err) {
        return changeRefused(err, ctx);
      }
    },
  });

  const addTags = defineTool({
    key: 'add_tags',
    description: (ctx) =>
      ctx.allowedTags.length
        ? `Tag the customer's record to categorize them (interest, intent, product). Allowed tags: ${ctx.allowedTags.join(', ')}.`
        : 'Tag the customer\'s record to categorize them (interest, intent, product) using the business\'s existing tags.',
    enabled: () => true,
    schema: (ctx) =>
      z.object({
        tags: z
          .array(ctx.allowedTags.length ? z.enum(ctx.allowedTags as [string, ...string[]]) : z.string().min(1).max(60))
          .min(1)
          .max(10),
      }),
    async run(input, ctx) {
      const result = await contacts.addTags(scope(ctx), ctx.contactId, input.tags as string[], {
        addedBy: 'ai',
        allowCreate: ctx.bot.config.actions.allowCreateTags,
        allowed: ctx.bot.config.actions.allowedTags,
      });
      return result.added.length || !result.skipped.length
        ? { ok: true, data: { added: result.added, skipped: result.skipped } }
        : fail(`No tags applied: ${result.skipped.join('; ')}`);
    },
  });

  const addNote = defineTool({
    key: 'add_note',
    repeatKey: () => '',
    description: () =>
      'Save a durable fact about this customer that will matter in future conversations (preferences, situation, constraints — e.g. "prefers evening calls", "moving in March"). Not for name/email/phone (use save_contact_details) and not for a transcript summary.',
    enabled: () => true,
    schema: () => z.object({ note: z.string().min(3).max(500) }),
    async run(input, ctx) {
      await contacts.addNote(scope(ctx), ctx.contactId, input.note, 'ai');
      return { ok: true, data: { saved: true } };
    },
  });

  const createTask = defineTool({
    key: 'create_task',
    repeatKey: () => '',
    description: () =>
      'Create a follow-up task for the team when something needs a human action later (call back, send a quote, check a special request). Use notify_team instead when it is urgent.',
    enabled: () => true,
    schema: () =>
      z.object({
        title: z.string().min(3).max(200),
        description: z.string().max(2000).optional(),
        due_in_hours: z.number().min(0).max(24 * 60).optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
      }),
    async run(input, ctx) {
      const task = await contacts.createTask(scope(ctx), {
        title: input.title,
        description: input.description,
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
        dueAt: input.due_in_hours !== undefined ? new Date(ctx.now.getTime() + input.due_in_hours * 3_600_000) : null,
        priority: input.priority,
        createdBy: 'ai',
      });
      return {
        ok: true,
        data: {
          task_id: task.id,
          created: true,
          note: "An internal to-do for the team: nothing is booked, confirmed or done for the customer yet. Tell them the team will follow up; don't say it's done.",
        },
      };
    },
  });

  const notifyTeam = defineTool({
    key: 'notify_team',
    repeatKey: () => '',
    description: () =>
      'Alert the business team right away about something that needs attention now (hot lead ready to buy, urgent request, complaint). Do not use for routine questions.',
    enabled: () => true,
    schema: () =>
      z.object({
        subject: z.string().min(3).max(150),
        message: z.string().min(3).max(2000),
        urgency: z.enum(['normal', 'high']).default('normal'),
      }),
    async run(input, ctx) {
      await automation.notifyTeam(scope(ctx), {
        subject: input.subject,
        message: input.message,
        urgency: input.urgency,
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
      });
      return {
        ok: true,
        data: {
          notified: true,
          note: "The team was alerted: nothing is booked, confirmed or done for the customer yet. Tell them the team will follow up; don't say it's done.",
        },
      };
    },
  });

  const triggerWorkflow = defineTool({
    key: 'trigger_workflow',
    activity: 'Working on it…',
    description: (ctx) => {
      const fromRecord = ctx.workflows.some((w) => w.inputFields.some((f) => (f.source ?? 'chat') !== 'chat'));
      return [
        'Run one of the business\'s automated workflows. Available workflows:',
        ...ctx.workflows.map((w) => {
          const chat = w.inputFields.filter((f) => (f.source ?? 'chat') === 'chat');
          const inputs = chat.map((f) => `${f.name}${f.required ? '' : ' (optional)'}${f.description ? `: ${f.description}` : ''}`);
          return `- ${w.key}: ${w.name} — ${w.description}${inputs.length ? ` Inputs: ${inputs.join('; ')}.` : ''}`;
        }),
        ...(fromRecord ? ["Values from the customer's record (such as their email on file) are added automatically: don't pass them."] : []),
      ].join('\n');
    },
    enabled: (ctx) => ctx.workflows.length > 0,
    schema: (ctx) =>
      z.object({
        workflow_key: z.enum(ctx.workflows.map((w) => w.key) as [string, ...string[]]),
        inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Inputs the workflow needs'),
      }),
    // Each workflow is its own action: a retry replays calls to the same workflow only.
    repeatKey: (input) => input.workflow_key,
    async run(input, ctx) {
      try {
        const result = await automation.triggerWorkflow(scope(ctx), {
          key: input.workflow_key,
          inputs: input.inputs ?? {},
          contactId: ctx.contactId,
          conversationId: ctx.conversationId,
          allowedKeys: ctx.bot.config.actions.workflowKeys,
          approvedBy: ctx.approval?.decidedByUserId,
        });
        return result.ok ? { ok: true, data: result } : fail(result.error ?? 'The workflow failed', result);
      } catch (err) {
        return toOutcome(err);
      }
    },
  });

  const transferToHuman = defineTool({
    key: 'transfer_to_human',
    description: () =>
      'Hand the conversation to a human team member. Call this when the customer asks for a person, is upset or complaining, raises a refund/legal/billing dispute or anything sensitive, or when you cannot help after a genuine attempt. After calling it, tell the customer a team member will reply here.',
    enabled: (ctx) => ctx.bot.config.handoff.enabled,
    schema: () => z.object({ reason: z.string().min(3).max(300) }),
    async run(input, ctx) {
      ctx.requestHandoff(input.reason);
      return {
        ok: true,
        data: { transferred: true, instruction: 'Let the customer know a team member will reply in this chat soon. Do not call further tools.' },
      };
    },
  });

  // ---- CRM actions: each off until the bot allows it, and limited to the bot's lists ----

  const setLifecycleStage = defineTool({
    key: 'set_lifecycle_stage',
    description: (ctx) =>
      `Move the customer to another lifecycle stage as soon as what they say puts them in it (for example, they tell you they have paid or bought). Stages you may set: ${ctx.lifecycleStages.join(', ')}.`,
    enabled: (ctx) => ctx.lifecycleStages.length > 0,
    schema: (ctx) => z.object({ stage: z.enum(ctx.lifecycleStages as [string, ...string[]]) }),
    async run(input, ctx) {
      const contact = await contacts.get(scope(ctx), ctx.contactId);
      if (contact.lifecycleStage === input.stage) return { ok: true, data: { stage: input.stage, unchanged: true } };
      await contacts.setLifecycleStage(scope(ctx), ctx.contactId, input.stage, 'ai', ctx.conversationId);
      return { ok: true, data: { stage: input.stage, previous: contact.lifecycleStage } };
    },
  });

  const assignOwner = defineTool({
    key: 'assign_owner',
    description: (ctx) =>
      `Make a team member the customer's owner (the person who looks after them): ${ctx.owners.map((o) => o.name).join(', ')}. Call it as soon as you know what they need, when the business's instructions say who looks after that, and before telling the customer who will. Don't reassign a customer who already has an owner unless asked to.`,
    enabled: (ctx) => ctx.owners.length > 0,
    schema: (ctx) => z.object({ owner: z.enum(ctx.owners.map((o) => o.name) as [string, ...string[]]) }),
    async run(input, ctx) {
      const owner = ctx.schema.owners.find((o) => o.name === input.owner);
      if (!owner) return fail(`${input.owner} isn't someone you may assign.`);
      if ((await contacts.get(scope(ctx), ctx.contactId)).ownerUserId === owner.id) return { ok: true, data: { owner: owner.name, unchanged: true } };
      try {
        await contacts.setOwner(scope(ctx), ctx.contactId, owner.id, 'ai', ctx.conversationId);
      } catch (err) {
        return toOutcome(err);
      }
      return { ok: true, data: { owner: owner.name } };
    },
  });

  const removeTags = defineTool({
    key: 'remove_tags',
    description: (ctx) =>
      ctx.allowedTags.length
        ? `Remove tags that no longer fit what the customer says (for example, they are no longer interested in something). Tags you may remove: ${ctx.allowedTags.join(', ')}.`
        : 'Remove tags you added earlier that no longer fit what the customer says, for example when they are no longer interested in something (tags the team added stay).',
    enabled: (ctx) => ctx.bot.config.actions.removeTags,
    schema: (ctx) =>
      z.object({
        tags: z
          .array(ctx.allowedTags.length ? z.enum(ctx.allowedTags as [string, ...string[]]) : z.string().min(1).max(60))
          .min(1)
          .max(10),
      }),
    async run(input, ctx) {
      const result = await contacts.removeTagsByName(scope(ctx), ctx.contactId, input.tags as string[], {
        allowed: ctx.bot.config.actions.allowedTags,
        actor: 'ai',
        conversationId: ctx.conversationId,
      });
      return result.removed.length || !result.skipped.length ? { ok: true, data: result } : fail(`No tags removed: ${result.skipped.join('; ')}`, result);
    },
  });

  const dealStageField = (ctx: ToolSchemaContext) => z.enum(ctx.pipeline!.stages.map((s) => s.name) as [string, ...string[]]);
  const dealValueField = () => z.number().nonnegative().max(999_999_999_999.99);

  const createDeal = defineTool({
    key: 'create_deal',
    // A retried turn hands back the deal an earlier attempt opened instead of opening another.
    repeatKey: () => '',
    description: (ctx) =>
      `Open a deal (a sales opportunity) for this customer in the "${ctx.pipeline!.name}" pipeline as soon as they say they want to buy or go ahead with a product or service (not when they only ask about it), even before you have their contact details. A customer has one open deal here: if <deals> lists one, change it with update_deal instead.`,
    enabled: (ctx) => ctx.bot.config.actions.deals.enabled && ctx.pipeline !== null,
    schema: (ctx) =>
      z.object({
        title: z.string().min(2).max(200).describe('What they want, e.g. "Invisalign"'),
        value: dealValueField().optional().describe('Estimated value, if known'),
        stage: dealStageField(ctx).optional().describe('Defaults to the first stage'),
        expected_close_on: Day.optional().describe('YYYY-MM-DD, if they said when'),
      }),
    async run(input, ctx) {
      const pipeline = ctx.schema.pipeline!;
      const [open] = await deals.list(scope(ctx), { contactId: ctx.contactId, pipelineId: pipeline.id, status: 'open', limit: 1, offset: 0 });
      if (open) {
        return fail(`Not created: this customer already has an open deal. To record a stage, value or date they mentioned, call update_deal with deal_id "${open.id}".`, {
          existing: true,
          deal: dealSummary(open, pipeline.stages),
        });
      }
      try {
        const deal = await deals.create(
          scope(ctx),
          {
            title: input.title,
            contactId: ctx.contactId,
            pipelineId: pipeline.id,
            stageId: input.stage ? pipeline.stages.find((s) => s.name === input.stage)?.id : undefined,
            value: input.value ?? null,
            expectedCloseOn: input.expected_close_on ?? null,
            conversationId: ctx.conversationId,
          },
          { source: 'ai' },
        );
        return { ok: true, data: { created: true, deal: dealSummary(deal, pipeline.stages) } };
      } catch (err) {
        return toOutcome(err);
      }
    },
  });

  const updateDeal = defineTool({
    key: 'update_deal',
    description: (ctx) =>
      ctx.bot.config.actions.deals.canClose
        ? "Change this customer's open deal (listed in <deals>): its stage, value or expected close date. Mark it won once they have committed (booked or bought), or lost when they clearly decline."
        : "Change this customer's open deal (listed in <deals>): its stage, value or expected close date. Marking it won or lost is for the team, so don't set a status.",
    enabled: (ctx) => ctx.bot.config.actions.deals.enabled && ctx.pipeline !== null,
    schema: (ctx) =>
      z.object({
        deal_id: z.string().uuid().describe('The id shown in <deals>'),
        stage: dealStageField(ctx).optional(),
        value: dealValueField().optional(),
        expected_close_on: Day.optional(),
        status: z.enum(['won', 'lost']).optional(),
        lost_reason: z.string().max(500).optional().describe('Why they declined, when marking it lost'),
      }),
    async run(input, ctx) {
      const pipeline = ctx.schema.pipeline!;
      let deal: DealView;
      try {
        deal = await deals.get(scope(ctx), input.deal_id);
      } catch (err) {
        return toOutcome(err);
      }
      if (deal.contactId !== ctx.contactId) return fail('That deal belongs to another customer.');
      if (deal.pipelineId !== pipeline.id) return fail(`That deal isn't in the "${pipeline.name}" pipeline.`);
      if (deal.status !== 'open') return fail(`That deal is already ${deal.status}.`);
      if (input.status && !ctx.bot.config.actions.deals.canClose) {
        return fail('Marking deals won or lost is for the team: let them know instead (create_task or notify_team).');
      }
      try {
        const updated = await deals.update(
          scope(ctx),
          deal.id,
          {
            stageId: input.stage ? pipeline.stages.find((s) => s.name === input.stage)?.id : undefined,
            value: input.value,
            expectedCloseOn: input.expected_close_on,
            status: input.status,
            lostReason: input.status === 'lost' ? input.lost_reason : undefined,
          },
          { source: 'ai' },
        );
        return { ok: true, data: { updated: true, deal: dealSummary(updated, pipeline.stages) } };
      } catch (err) {
        return toOutcome(err);
      }
    },
  });

  // ---- marketing opt-in: the server posts the business's exact wording; the answer is recorded with proof ----

  const optInQuestion = (ctx: { bot: ToolContext['bot'] }) => (ctx.bot.config.leadCapture.enabled ? ctx.bot.config.leadCapture.marketingOptIn.trim() : '');

  const askMarketingConsent = defineTool({
    key: 'ask_marketing_consent',
    description: () =>
      "Ask the customer the business's marketing opt-in question. The system posts its exact wording as a separate message right after your reply, so don't ask it in your own words. Call it once, after you have their email or phone, when <contact> shows marketing consent as not asked yet.",
    enabled: (ctx) => optInQuestion(ctx) !== '',
    schema: () => z.object({}),
    async run(_input, ctx) {
      const contact = await contacts.get(scope(ctx), ctx.contactId);
      const answered = contact.consent.marketing;
      if (answered) return fail(`They already answered (${answered.granted ? 'yes' : 'no'}). Don't ask again.`);
      const asked = await contacts.consentQuestion(scope(ctx), ctx.conversationId, 'marketing');
      if (asked.request) {
        return fail(
          asked.answer
            ? 'You already asked, and they replied: record their answer with record_marketing_consent.'
            : 'You already asked in this conversation: wait for their answer.',
        );
      }
      const text = optInQuestion(ctx);
      ctx.postAfterReply({ content: text, metadata: { consentRequest: { purpose: 'marketing', textVersion: consentVersion(text) } } });
      return { ok: true, data: { question_posted_after_your_reply: true, note: "Don't repeat the question. When they answer, call record_marketing_consent." } };
    },
  });

  const recordMarketingConsent = defineTool({
    key: 'record_marketing_consent',
    description: () =>
      "Record the customer's answer to the marketing opt-in question: granted=true only if they clearly said yes to it, granted=false if they said no. Also call it with granted=false whenever they ask to stop receiving marketing, even if they weren't asked.",
    enabled: (ctx) => optInQuestion(ctx) !== '',
    // Recording twice on a retried turn would only duplicate the history.
    repeatKey: () => '',
    schema: () => z.object({ granted: z.boolean().describe('true = yes to the opt-in question; false = declined, or asked to stop') }),
    async run(input, ctx) {
      const asked = await contacts.consentQuestion(scope(ctx), ctx.conversationId, 'marketing');
      if (input.granted) {
        // A yes counts only as an answer to the exact wording the server posted.
        if (!asked.request) return fail('Ask first with ask_marketing_consent: the customer must see the exact wording.');
        if (!asked.answer) return fail("They haven't answered the question yet: wait for their reply.");
        if (isPlainNo(asked.answer.content)) return fail(`They replied "${asked.answer.content.slice(0, 80)}", which is a no. Record granted=false.`);
      }
      // A decline answers the question; a withdrawal can come anytime, in the customer's own words.
      const evidence = asked.answer ?? asked.latestInbound;
      if (!evidence) return fail('There is no customer message to record this from.');
      const request = asked.answer ? asked.request : null;
      const record = await contacts.recordConsent(scope(ctx), ctx.contactId, {
        purpose: 'marketing',
        granted: input.granted,
        text: request?.content ?? null,
        source: 'chat',
        conversationId: ctx.conversationId,
        requestMessageId: request?.id ?? null,
        evidenceMessageId: evidence.id,
      });
      return { ok: true, data: { recorded: true, granted: record.granted } };
    },
  });

  return [
    saveContactDetails,
    recordQualification,
    searchKnowledge,
    checkAvailability,
    bookAppointment,
    listAppointments,
    rescheduleAppointment,
    cancelAppointment,
    addTags,
    addNote,
    createTask,
    notifyTeam,
    triggerWorkflow,
    transferToHuman,
    askMarketingConsent,
    recordMarketingConsent,
    setLifecycleStage,
    assignOwner,
    removeTags,
    createDeal,
    updateDeal,
  ] as unknown as ToolDefinition[];
}
