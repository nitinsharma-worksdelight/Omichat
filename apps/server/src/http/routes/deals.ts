import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parseInput, parsePatch } from '../../lib/validation';
import type { AuthContext } from '../../modules/auth/service';
import {
  DealCreateSchema,
  DealListSchema,
  DealSummarySchema,
  DealUpdateSchema,
  PipelineCreateSchema,
  PipelineUpdateSchema,
  type DealActor,
} from '../../modules/deals/service';
import { requireAccess, requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

const actorOf = (auth: AuthContext): DealActor => (auth.kind === 'user' ? { userId: auth.userId, source: 'user' } : { source: 'api' });

/** Deals and the pipelines they move through. Reading: viewer / `deals:read`; deals: agent / `deals:write`; pipelines: admins. */
export async function registerDealRoutes(app: FastifyInstance, c: Container) {
  // ---- pipelines ----
  app.get('/pipelines', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'deals:read');
    return c.deals.listPipelines({ orgId: auth.orgId });
  });

  app.post('/pipelines', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.deals.createPipeline({ orgId: auth.orgId }, parseInput(PipelineCreateSchema, req.body)));
  });

  app.patch('/pipelines/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.deals.updatePipeline({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(PipelineUpdateSchema, req.body), actorOf(auth));
  });

  app.delete('/pipelines/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.deals.deletePipeline({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  // ---- deals ----
  app.get('/deals', async (req, reply) => {
    const auth = await requireAccess(c, req, 'viewer', 'deals:read');
    const items = await c.deals.list({ orgId: auth.orgId }, parseInput(DealListSchema, req.query));
    // The body stays a plain array; the total count travels in a header for pagination.
    void reply.header('x-total-count', String(items.total)).header('access-control-expose-headers', 'x-total-count');
    return [...items];
  });

  /** Per stage: the count and the total value of the deals shown on the board. */
  app.get('/deals/summary', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'deals:read');
    return c.deals.summary({ orgId: auth.orgId }, parseInput(DealSummarySchema, req.query));
  });

  app.post('/deals', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'deals:write');
    return reply.status(201).send(await c.deals.create({ orgId: auth.orgId }, parseInput(DealCreateSchema, req.body), actorOf(auth)));
  });

  app.get('/deals/:id', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'deals:read');
    return c.deals.get({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.patch('/deals/:id', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'deals:write');
    return c.deals.update({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(DealUpdateSchema, req.body), actorOf(auth));
  });

  app.delete('/deals/:id', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'deals:write');
    await c.deals.delete({ orgId: auth.orgId }, parseInput(Id, req.params).id, actorOf(auth));
    return reply.status(204).send();
  });

  app.get('/contacts/:id/deals', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'deals:read');
    return [...(await c.deals.list({ orgId: auth.orgId }, { contactId: parseInput(Id, req.params).id, limit: 200, offset: 0 }))];
  });
}
