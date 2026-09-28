import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parseInput, parsePatch } from '../../lib/validation';
import { WebhookEndpointSchema, WorkflowSchema } from '../../modules/automation/service';
import { requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

export async function registerAutomationRoutes(app: FastifyInstance, c: Container) {
  app.get('/webhooks', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.automation.listEndpoints({ orgId: auth.orgId });
  });

  app.post('/webhooks', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.automation.createEndpoint({ orgId: auth.orgId }, parseInput(WebhookEndpointSchema, req.body)));
  });

  app.patch('/webhooks/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.automation.updateEndpoint({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(WebhookEndpointSchema.partial(), req.body));
  });

  app.delete('/webhooks/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.automation.deleteEndpoint({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.automation.listDeliveries({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.get('/workflows', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.automation.listWorkflows({ orgId: auth.orgId });
  });

  app.post('/workflows', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.automation.createWorkflow({ orgId: auth.orgId }, parseInput(WorkflowSchema, req.body)));
  });

  app.patch('/workflows/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.automation.updateWorkflow({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(WorkflowSchema.omit({ key: true }).partial(), req.body));
  });

  app.delete('/workflows/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.automation.deleteWorkflow({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  /** Run a workflow by hand with sample inputs to check the n8n side. */
  app.post('/workflows/:key/test', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const { key } = parseInput(z.object({ key: z.string() }), req.params);
    const { inputs } = parseInput(z.object({ inputs: z.record(z.string(), z.unknown()).default({}) }), req.body ?? {});
    return c.automation.triggerWorkflow({ orgId: auth.orgId }, { key, inputs, actor: 'user', actorUserId: auth.userId });
  });
}
