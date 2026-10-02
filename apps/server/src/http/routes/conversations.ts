import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Container } from '../../container';
import { schema } from '../../db/client';
import { parseInput } from '../../lib/validation';
import type { SummaryJob } from '../../modules/ai/summary';
import { ConversationListSchema, convChannel, orgChannel, userChannel } from '../../modules/conversations/service';
import type { AuthContext } from '../../modules/auth/service';
import { actorUserId, requireAccess, requireUser } from '../auth';
import { openSse } from '../sse';

const Id = z.object({ id: z.string().uuid() });

/**
 * A visitor's IP address is personal data: only admins and owners see it, never API keys, and nobody while the
 * organization doesn't record addresses. Everyone else gets the conversation without it.
 */
async function ipFilter(c: Container, auth: AuthContext) {
  const shown = auth.kind === 'user' && (auth.role === 'admin' || auth.role === 'owner') && (await c.tenancy.getOrganization(auth.orgId)).settings.recordVisitorIp;
  return <T extends { metadata: Record<string, unknown> }>(conv: T): T => {
    if (shown) return conv;
    const { visitorIp: _ip, visitorIpAt: _at, ...metadata } = conv.metadata;
    return { ...conv, metadata };
  };
}

export async function registerConversationRoutes(app: FastifyInstance, c: Container) {
  app.get('/conversations', async (req, reply) => {
    const auth = await requireAccess(c, req, 'viewer', 'conversations:read');
    const items = await c.conversations.list({ orgId: auth.orgId }, parseInput(ConversationListSchema, req.query), actorUserId(auth) ?? null);
    // The body stays a plain array; the total count travels in a header for pagination.
    void reply.header('x-total-count', String(items.total)).header('access-control-expose-headers', 'x-total-count');
    return items.map(await ipFilter(c, auth));
  });

  app.get('/conversations/:id', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'conversations:read');
    return (await ipFilter(c, auth))(await c.conversations.get({ orgId: auth.orgId }, parseInput(Id, req.params).id));
  });

  app.get('/conversations/:id/messages', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'conversations:read');
    const q = parseInput(
      z.object({ limit: z.coerce.number().int().optional(), after: z.string().uuid().optional(), before: z.string().uuid().optional() }),
      req.query,
    );
    return c.conversations.messages({ orgId: auth.orgId }, parseInput(Id, req.params).id, q);
  });

  app.get('/conversations/:id/timeline', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'conversations:read');
    const id = parseInput(Id, req.params).id;
    const [events, tools] = await Promise.all([
      c.conversations.timeline({ orgId: auth.orgId }, id),
      c.conversations.toolInvocations({ orgId: auth.orgId }, id),
    ]);
    return { events, tools };
  });

  app.get('/conversations/:id/ai-runs', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const id = parseInput(Id, req.params).id;
    return c.tenantDb.run(auth.orgId, (tx) =>
      tx
        .select()
        .from(schema.aiRuns)
        .where(and(eq(schema.aiRuns.organizationId, auth.orgId), eq(schema.aiRuns.conversationId, id)))
        .orderBy(desc(schema.aiRuns.createdAt))
        .limit(100),
    );
  });

  /** Staff reply; replying to an AI-run conversation takes it over. */
  app.post('/conversations/:id/messages', async (req, reply) => {
    const auth = await requireUser(c, req, 'agent');
    const { content } = parseInput(z.object({ content: z.string().trim().min(1).max(4000) }), req.body);
    return reply.status(201).send(await c.conversations.humanReply({ orgId: auth.orgId }, parseInput(Id, req.params).id, auth.userId, content));
  });

  /** Staff ask for a fresh summary: a recap is queued (202), or the reason it can't be written now. */
  app.post('/conversations/:id/summary', async (req, reply) => {
    const auth = await requireUser(c, req, 'agent');
    const id = parseInput(Id, req.params).id;
    await c.conversations.get({ orgId: auth.orgId }, id);
    const reason = await c.summarizer.check(auth.orgId, id);
    if (reason) return { queued: false, reason };
    const job: SummaryJob = { orgId: auth.orgId, conversationId: id, mode: 'recap', trigger: 'manual' };
    // One per conversation per minute: a double click queues one recap.
    await c.queue.add('summary', job, { jobId: `manual_${id}_${Math.floor(Date.now() / 60_000)}`, attempts: 2 });
    return reply.status(202).send({ queued: true });
  });

  /** takeover → human_active · resume → ai_active · close → closed */
  app.post('/conversations/:id/status', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    const { action, reason } = parseInput(
      z.object({ action: z.enum(['takeover', 'resume', 'close', 'reopen']), reason: z.string().max(300).optional() }),
      req.body,
    );
    // Reopening a closed chat hands it back to the person reopening it, to reply to.
    const status = action === 'takeover' || action === 'reopen' ? 'human_active' : action === 'resume' ? 'ai_active' : 'closed';
    const updated = await c.conversations.setStatus({ orgId: auth.orgId }, parseInput(Id, req.params).id, status, {
      actor: 'user',
      actorUserId: auth.userId,
      reason: reason ?? (action === 'takeover' ? 'Taken over by staff' : action === 'reopen' ? 'Reopened by staff' : null),
      reopen: action === 'reopen',
    });
    return (await ipFilter(c, auth))(updated);
  });

  /** Gives the conversation to a team member (`userId`), or to nobody (`null`). */
  app.post('/conversations/:id/assign', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    const { userId } = parseInput(z.object({ userId: z.string().uuid().nullable() }), req.body);
    await c.conversations.assign({ orgId: auth.orgId }, parseInput(Id, req.params).id, userId, auth.userId);
    return (await ipFilter(c, auth))(await c.conversations.get({ orgId: auth.orgId }, parseInput(Id, req.params).id));
  });

  /** Live updates for the dashboard: one conversation (`?conversationId=`) or the whole org inbox. */
  app.get('/stream', async (req, reply) => {
    const auth = await requireUser(c, req);
    const q = parseInput(z.object({ conversationId: z.string().uuid().optional() }), req.query);
    if (q.conversationId) await c.conversations.get({ orgId: auth.orgId }, q.conversationId);
    const stream = openSse(req, reply);
    const forward = (event: unknown) => stream.send((event as { type: string }).type, event);
    // The org inbox stream also carries this member's own notifications; a conversation stream carries that conversation.
    const unsubscribes = q.conversationId
      ? [c.pubsub.subscribe(convChannel(q.conversationId), forward)]
      : [c.pubsub.subscribe(orgChannel(auth.orgId), forward), c.pubsub.subscribe(userChannel(auth.orgId, auth.userId), forward)];
    stream.onClose(() => unsubscribes.forEach((u) => u()));
  });
}
