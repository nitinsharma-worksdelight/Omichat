import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Container } from '../../container';
import { schema } from '../../db/client';
import { badRequest } from '../../lib/errors';
import { parseInput, parsePatch, queryBool } from '../../lib/validation';
import { API_KEY_SCOPES } from '../../modules/auth/service';
import { OrgUpdateSchema } from '../../modules/tenancy/service';
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

  /** Headline numbers for the dashboard home and for billing export later. */
  app.get('/usage', async (req) => {
    const auth = await requireUser(c, req);
    const since = DateTime.utc().startOf('month').toJSDate();
    return c.tenantDb.run(auth.orgId, async (tx) => {
      const [ai] = await tx
        .select({
          runs: sql<number>`count(*)::int`,
          cost: sql<string>`coalesce(sum(${schema.aiRuns.costUsd}), 0)`,
          inputTokens: sql<number>`coalesce(sum(${schema.aiRuns.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${schema.aiRuns.outputTokens}), 0)::int`,
          cacheReadTokens: sql<number>`coalesce(sum(${schema.aiRuns.cacheReadTokens}), 0)::int`,
        })
        .from(schema.aiRuns)
        .where(and(eq(schema.aiRuns.organizationId, auth.orgId), gte(schema.aiRuns.createdAt, since)));
      const [conv] = await tx
        .select({ total: sql<number>`count(*)::int`, handedOff: sql<number>`count(*) filter (where ${schema.conversations.status} = 'human_active')::int` })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.organizationId, auth.orgId), eq(schema.conversations.isTest, false), gte(schema.conversations.createdAt, since)));
      const [leads] = await tx
        .select({
          captured: sql<number>`count(*) filter (where ${schema.contacts.leadCapturedAt} >= ${since})::int`,
          qualified: sql<number>`count(*) filter (where ${schema.contacts.qualificationStatus} = 'qualified' and ${schema.contacts.updatedAt} >= ${since})::int`,
        })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.organizationId, auth.orgId), eq(schema.contacts.isTest, false)));
      const [appts] = await tx
        .select({ booked: sql<number>`count(*)::int` })
        .from(schema.appointments)
        .where(and(eq(schema.appointments.organizationId, auth.orgId), gte(schema.appointments.createdAt, since), eq(schema.appointments.createdBy, 'ai')));
      return {
        since,
        ai: { ...ai, costUsd: Number(ai?.cost ?? 0) },
        conversations: conv,
        leads,
        appointmentsBookedByAi: appts?.booked ?? 0,
      };
    });
  });
}
