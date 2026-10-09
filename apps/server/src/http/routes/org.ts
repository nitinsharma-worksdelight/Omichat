import type { FastifyInstance } from 'fastify';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Container } from '../../container';
import { schema } from '../../db/client';
import { badRequest } from '../../lib/errors';
import { parseInput, parsePatch, queryBool } from '../../lib/validation';
import { API_KEY_SCOPES, hasRole } from '../../modules/auth/service';
import { OrgUpdateSchema } from '../../modules/tenancy/service';
import { AnalyticsQuerySchema } from '../../modules/analytics/service';
import { EXPORTS, exportCsv } from '../../modules/analytics/export';
import { requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

export async function registerOrgRoutes(app: FastifyInstance, c: Container) {
  app.get('/org', async (req) => {
    const auth = await requireUser(c, req);
    return c.tenancy.getOrganization(auth.orgId);
  });

  app.patch('/org', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.tenancy.updateOrganization(auth.orgId, parsePatch(OrgUpdateSchema, req.body));
  });

  app.get('/members', async (req) => {
    const auth = await requireUser(c, req);
    return c.tenancy.listMembers(auth.orgId);
  });

  app.post('/members', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    const input = parseInput(
      z.object({
        email: z.string().email(),
        role: z.enum(['admin', 'agent', 'viewer']),
        name: z.string().max(120).optional(),
        password: z.string().min(8).max(200).optional(),
      }),
      req.body,
    );
    return reply.status(201).send(await c.tenancy.addMember(auth.orgId, input));
  });

  app.patch('/members/:userId', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const { userId } = parseInput(z.object({ userId: z.string().uuid() }), req.params);
    const { role } = parseInput(z.object({ role: z.enum(['admin', 'agent', 'viewer']) }), req.body);
    return c.tenancy.updateMemberRole(auth.orgId, userId, role);
  });

  app.delete('/members/:userId', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    const { userId } = parseInput(z.object({ userId: z.string().uuid() }), req.params);
    await c.tenancy.removeMember(auth.orgId, userId);
    return reply.status(204).send();
  });

  app.get('/api-keys', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.auth.listApiKeys(auth.orgId);
  });

  app.post('/api-keys', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    const input = parseInput(
      z.object({ name: z.string().trim().min(1).max(120), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }),
      req.body,
    );
    return reply.status(201).send(await c.auth.createApiKey(auth.orgId, { ...input, createdByUserId: auth.userId }));
  });

  /** Rename a key or change its scopes (the key itself is never shown again). */
  app.patch('/api-keys/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const input = parseInput(
      z.object({ name: z.string().trim().min(1).max(120).optional(), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).optional() }),
      req.body,
    );
    if (!input.name && !input.scopes) throw badRequest('Send a new name or scopes');
    return c.auth.updateApiKey(auth.orgId, parseInput(Id, req.params).id, { name: input.name, scopes: input.scopes ? [...new Set(input.scopes)] : undefined });
  });

  app.delete('/api-keys/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.auth.revokeApiKey(auth.orgId, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.get('/notifications', async (req) => {
    const auth = await requireUser(c, req);
    const q = parseInput(z.object({ unreadOnly: queryBool.optional() }), req.query);
    return c.automation.listNotifications({ orgId: auth.orgId }, auth.userId, q);
  });

  app.post('/notifications/read', async (req) => {
    const auth = await requireUser(c, req);
    const input = parseInput(z.object({ ids: z.union([z.array(z.string().uuid()), z.literal('all')]) }), req.body);
    await c.automation.markNotificationsRead({ orgId: auth.orgId }, auth.userId, input.ids);
    return { ok: true };
  });

  app.get('/events', async (req) => {
    const auth = await requireUser(c, req);
    const q = parseInput(z.object({ contactId: z.string().uuid().optional(), limit: z.coerce.number().int().optional() }), req.query);
    return c.automation.listEvents({ orgId: auth.orgId }, q);
  });

  /**
   * Month-to-date headline numbers for the Overview, in the organization's timezone. Test chats and merged duplicates
   * are left out; `aiCostUsd` is the same AI cost the Analytics page shows, and `ai` (all spend, Test chats included, as
   * the monthly budget counts it) is for admins only.
   */
  app.get('/usage', async (req) => {
    const auth = await requireUser(c, req);
    const org = await c.tenancy.getOrganization(auth.orgId);
    const isAdmin = hasRole(auth, 'admin');
    const r = await c.analytics.monthToDate(auth.orgId, org.timezone, { includeCost: isAdmin });
    return {
      since: r.since,
      aiCostUsd: r.cost,
      ai: r.spend,
      aiReplies: r.totals.aiReplies,
      conversations: { total: r.totals.conversations, handedOff: r.totals.handoffs },
      leads: { captured: r.totals.leads, qualified: r.totals.qualified },
      appointmentsBookedByAi: r.totals.bookings,
      dealsWon: r.totals.dealsWon,
    };
  });

  /** Reports over a date range, by bot and channel (staff). AI cost is for admins. */
  app.get('/analytics', async (req) => {
    const auth = await requireUser(c, req);
    const q = parseInput(AnalyticsQuerySchema, req.query);
    const org = await c.tenancy.getOrganization(auth.orgId);
    const isAdmin = hasRole(auth, 'admin');
    return c.analytics.report(auth.orgId, org.timezone, q, { includeCost: isAdmin });
  });

  /** The AI Agents dashboard: contacts the AI talked to, actions, bookings and time saved (staff). */
  app.get('/analytics/agents', async (req) => {
    const auth = await requireUser(c, req);
    const q = parseInput(AnalyticsQuerySchema, req.query);
    const org = await c.tenancy.getOrganization(auth.orgId);
    return c.analytics.agents(auth.orgId, org.timezone, q);
  });

  /** Team performance, the funnel, lead sources, AI actions and approvals over a date range (staff). */
  app.get('/analytics/performance', async (req) => {
    const auth = await requireUser(c, req);
    const q = parseInput(AnalyticsQuerySchema, req.query);
    const org = await c.tenancy.getOrganization(auth.orgId);
    return c.analytics.performance(auth.orgId, org.timezone, q, { includeCost: hasRole(auth, 'admin') });
  });

  /** One report as a CSV file (admins). */
  app.get('/analytics/export', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    const q = parseInput(AnalyticsQuerySchema.extend({ report: z.enum(EXPORTS) }), req.query);
    const org = await c.tenancy.getOrganization(auth.orgId);
    const csv = await exportCsv(c, auth.orgId, org.timezone, q);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${q.report}-${csv.from}-to-${csv.to}.csv"`)
      .send(csv.body);
  });
}
