import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parseInput } from '../../lib/validation';
import { ApprovalListSchema, ApproveSchema, RejectSchema } from '../../modules/approvals/service';
import { requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

/** "Ask the team first": the assistant's requests, and the team's answer. Staff only (API keys can't decide). */
export async function registerApprovalRoutes(app: FastifyInstance, c: Container) {
  app.get('/approvals', async (req, reply) => {
    const auth = await requireUser(c, req);
    const items = await c.approvals.list({ orgId: auth.orgId }, parseInput(ApprovalListSchema, req.query));
    // The body stays a plain array; the total count travels in a header for pagination.
    void reply.header('x-total-count', String(items.total)).header('access-control-expose-headers', 'x-total-count');
    return items;
  });

  app.post('/approvals/:id/approve', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    return c.approvals.approve({ orgId: auth.orgId }, parseInput(Id, req.params).id, auth.userId, parseInput(ApproveSchema, req.body ?? {}));
  });

  app.post('/approvals/:id/reject', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    return c.approvals.reject({ orgId: auth.orgId }, parseInput(Id, req.params).id, auth.userId, parseInput(RejectSchema, req.body ?? {}));
  });
}
