import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parseInput, parsePatch } from '../../lib/validation';
import { WebchatChannelSchema } from '../../modules/channels/service';
import { requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

export async function registerChannelRoutes(app: FastifyInstance, c: Container) {
  app.get('/channels', async (req) => {
    const auth = await requireUser(c, req);
    return c.channels.list({ orgId: auth.orgId });
  });

  app.post('/channels/webchat', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.channels.createWebchat({ orgId: auth.orgId }, parseInput(WebchatChannelSchema, req.body)));
  });

  app.patch('/channels/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.channels.update({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(WebchatChannelSchema.partial(), req.body));
  });

  app.post('/channels/:id/rotate-key', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.channels.rotateKey({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.delete('/channels/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.channels.delete({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });
}
