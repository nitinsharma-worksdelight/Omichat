import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { badRequest } from '../../lib/errors';
import { parseInput, parsePatch } from '../../lib/validation';
import { parseLocalStart } from '../../modules/scheduling/availability';
import { CalendarInputSchema } from '../../modules/scheduling/service';
import { requireAccess, requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function registerSchedulingRoutes(app: FastifyInstance, c: Container) {
  app.get('/calendars', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'appointments:read');
    return c.scheduling.listCalendars({ orgId: auth.orgId });
  });

  app.get('/calendars/:id', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'appointments:read');
    return c.scheduling.getCalendar({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/calendars', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.scheduling.createCalendar({ orgId: auth.orgId }, parseInput(CalendarInputSchema, req.body)));
  });

  app.patch('/calendars/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.scheduling.updateCalendar({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(CalendarInputSchema.partial(), req.body));
  });

  app.delete('/calendars/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.scheduling.deleteCalendar({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.get('/calendars/:id/availability', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'appointments:read');
    const q = parseInput(z.object({ from: DateStr.optional(), to: DateStr.optional() }), req.query);
    return c.scheduling.availability({ orgId: auth.orgId }, parseInput(Id, req.params).id, q);
  });

  app.get('/appointments', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'appointments:read');
    const q = parseInput(
      z.object({
        from: z.preprocess((v) => (v === 'now' ? new Date() : v), z.coerce.date()).optional(),
        to: z.coerce.date().optional(),
        calendarId: z.string().uuid().optional(),
        status: z.enum(['booked', 'cancelled', 'completed', 'no_show']).optional(),
      }),
      req.query,
    );
    return c.scheduling.list({ orgId: auth.orgId }, q);
  });

  /** Staff (or an integration) booking on behalf of a contact: the same availability and email rules as the AI. */
  app.post('/appointments', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'appointments:write');
    const input = parseInput(
      z.object({
        calendarId: z.string().uuid(),
        contactId: z.string().uuid(),
        start: z.string().describe('YYYY-MM-DDTHH:mm in the calendar timezone, or ISO with offset'),
        title: z.string().trim().min(1).max(200).default('Appointment'),
        notes: z.string().max(2000).optional(),
        /** Email the customer a confirmation (and reminders). */
        notifyCustomer: z.boolean().default(true),
      }),
      req.body,
    );
    const calendar = await c.scheduling.getCalendar({ orgId: auth.orgId }, input.calendarId);
    const start = parseLocalStart(input.start, calendar.timezone);
    if (!start) throw badRequest('Invalid start time');
    const result = await c.scheduling.book({ orgId: auth.orgId }, { ...input, start, createdBy: 'user' });
    // 200 when the contact already had this exact slot (e.g. a double click): the existing appointment.
    return reply.status(result.duplicate ? 200 : 201).send({ ...result.appointment, customerEmail: result.customerEmail });
  });

  app.post('/appointments/:id/reschedule', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'appointments:write');
    const { start, notifyCustomer } = parseInput(z.object({ start: z.string(), notifyCustomer: z.boolean().default(true) }), req.body);
    const id = parseInput(Id, req.params).id;
    const appt = await c.scheduling.getAppointment({ orgId: auth.orgId }, id);
    const parsed = parseLocalStart(start, appt.timezone);
    if (!parsed) throw badRequest('Invalid start time');
    return c.scheduling.reschedule({ orgId: auth.orgId }, id, parsed, { actor: 'user', notifyCustomer });
  });

  app.post('/appointments/:id/cancel', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'appointments:write');
    const { reason, notifyCustomer } = parseInput(
      z.object({ reason: z.string().max(500).optional(), notifyCustomer: z.boolean().default(true) }),
      req.body ?? {},
    );
    return c.scheduling.cancel({ orgId: auth.orgId }, parseInput(Id, req.params).id, { actor: 'user', reason, notifyCustomer });
  });

  /** The emails to the customer about this appointment: sent, scheduled, skipped (with the reason) or failed. */
  app.get('/appointments/:id/notifications', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'appointments:read');
    return c.scheduling.listEmails({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/appointments/:id/resend-confirmation', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'appointments:write');
    return c.scheduling.resendConfirmation({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/appointments/:id/status', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'appointments:write');
    const { status } = parseInput(z.object({ status: z.enum(['completed', 'no_show']) }), req.body);
    return c.scheduling.setStatus({ orgId: auth.orgId }, parseInput(Id, req.params).id, status);
  });
}
