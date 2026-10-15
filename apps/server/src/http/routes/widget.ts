import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { normalizeIp } from '../../lib/ip';
import { parseInput } from '../../lib/validation';
import { quietReason, type Quiet } from '../../modules/ai/quiet';
import { DEFAULT_CHAT_NAME, offeredStarters } from '../../modules/bots/config';
import { openingGreeting } from '../../modules/channels/service';
import { convChannel, type RealtimeEvent } from '../../modules/conversations/service';
import { requireWidget } from '../auth';
import { openSse } from '../sse';

const VISITOR_RE = /^[A-Za-z0-9_-]{8,80}$/;

/**
 * Public endpoints for the embeddable chat widget (and the dashboard playground, which uses a
 * playground-channel session). A session is anonymous: it identifies the org, the channel and a
 * random visitor id kept in the browser — not a person.
 */
export async function registerWidgetRoutes(app: FastifyInstance, c: Container) {
  const visitorKey = (req: FastifyRequest) => {
    const auth = req.headers.authorization ?? '';
    return auth.length > 20 ? auth.slice(-32) : req.ip;
  };

  app.get('/config', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const { key } = parseInput(z.object({ key: z.string().min(4).max(100) }), req.query);
    const channel = await c.channels.byPublicKey(key);
    if (!channel || channel.status !== 'active') throw notFound('Widget');
    const bot = channel.botId ? await c.bots.get({ orgId: channel.organizationId }, channel.botId).catch(() => null) : null;
    // Only the names the owner typed: with no business name, the chat shows no business name at all.
    return {
      theme: channel.config.theme ?? {},
      greeting: openingGreeting(channel.config, bot),
      assistantName: bot?.config.persona.assistantName.trim() || DEFAULT_CHAT_NAME,
      companyName: bot?.config.persona.companyName ?? '',
      starters: bot ? offeredStarters(bot.config) : [],
    };
  });

  app.post('/sessions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const input = parseInput(z.object({ key: z.string().min(4).max(100), visitorId: z.string().optional() }), req.body);
    const channel = await c.channels.byPublicKey(input.key);
    if (!channel || channel.status !== 'active') throw notFound('Widget');
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : undefined;
    const allowed = channel.config.allowedOrigins ?? [];
    if (allowed.length && (!origin || !allowed.includes(origin))) throw forbidden('This website is not allowed to use this chat widget');
    const visitorId = input.visitorId && VISITOR_RE.test(input.visitorId) ? input.visitorId : crypto.randomUUID();
    const token = await c.tokens.signWidgetToken({ orgId: channel.organizationId, channelAccountId: channel.id, visitorId, origin });
    const open = await c.conversations.openForIdentity({ orgId: channel.organizationId }, channel.id, 'webchat', visitorId);
    // The visitor's address as the server sees it (TRUST_PROXY decides which forwarded address counts), never one they
    // send. A new visitor has no conversation yet: their first message records it.
    req.log.debug({ addresses: req.ips }, 'widget session addresses');
    const ip = normalizeIp(req.ip);
    if (open && ip) await c.conversations.recordVisitorIp({ orgId: channel.organizationId }, open.id, ip);
    const messages = open ? await c.conversations.messages({ orgId: channel.organizationId }, open.id, { limit: 50 }) : [];
    return {
      token,
      visitorId,
      conversationId: open?.id ?? null,
      status: open?.status ?? null,
      quiet: await quietOf(c, channel.organizationId, open?.botId ?? channel.botId ?? null, open),
      messages: messages.map(publicMessage),
    };
  });

  app.get('/messages', async (req) => {
    const claims = await requireWidget(c, req);
    const q = parseInput(z.object({ after: z.string().uuid().optional() }), req.query);
    const conv = await openConversation(c, claims);
    if (!conv) return { conversationId: null, messages: [] };
    const messages = await c.conversations.messages({ orgId: claims.orgId }, conv.id, { limit: 100, after: q.after });
    return { conversationId: conv.id, status: conv.status, quiet: await quietOf(c, claims.orgId, conv.botId, conv), messages: messages.map(publicMessage) };
  });

  app.post('/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: visitorKey } } }, async (req, reply) => {
    const claims = await requireWidget(c, req);
    const input = parseInput(
      z.object({
        content: z.string().trim().min(1).max(4000),
        clientMessageId: z.string().min(8).max(80).optional(),
        pageUrl: z.string().url().max(2000).optional(),
        /** Recorded by the widget on the visitor's first page load: landing page, referrer, UTM tags, click ids. */
        firstTouch: z.record(z.string(), z.unknown()).optional(),
        /** The browser's timezone, e.g. America/Vancouver. */
        timezone: z.string().max(64).optional(),
        /** The conversation starter the visitor clicked; the AI reply checks it against the bot's current starters. */
        starterId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const result = await c.conversations.receiveInbound({
      orgId: claims.orgId,
      channelAccountId: claims.channelAccountId,
      externalUserId: claims.visitorId,
      content: input.content,
      externalMessageId: input.clientMessageId,
      botIdOverride: claims.botId,
      metadata: {
        pageUrl: input.pageUrl,
        userAgent: req.headers['user-agent']?.slice(0, 300),
        ...(input.starterId ? { starterId: input.starterId } : {}),
      },
      firstTouch: input.firstTouch,
      timezone: input.timezone,
      visitorIp: req.ip,
    });
    // `aiQueued`: a reply is on its way (false when a person has the chat): the widget shows "typing" only then. `quiet`: the agent is off or stopped itself, so nobody will answer: the widget says so instead.
    const open = await openConversation(c, claims);
    const quiet = result.aiQueued ? await quietOf(c, claims.orgId, open?.botId ?? claims.botId ?? null, open) : null;
    return reply.status(result.duplicate ? 200 : 201).send({ conversationId: result.conversationId, message: publicMessage(result.message), aiQueued: result.aiQueued, quiet });
  });

  /**
   * Live replies: `message`, `ai.typing`, `ai.delta`, `ai.activity`, `ai.done`, `conversation.status`.
   * After (re)connecting, the widget fetches `/messages?after=` to fill any gap.
   */
  app.get('/stream', async (req, reply) => {
    const claims = await requireWidget(c, req);
    const q = parseInput(z.object({ conversationId: z.string().uuid() }), req.query);
    const conv = await openConversation(c, claims);
    if (!conv || conv.id !== q.conversationId) throw badRequest('Unknown conversation');
    const stream = openSse(req, reply);
    const unsubscribe = c.pubsub.subscribe(convChannel(conv.id), (raw) => {
      const out = widgetEvent(raw as RealtimeEvent);
      if (out) stream.send(out.type, out.data);
    });
    stream.onClose(unsubscribe);
  });
}

/** What the visitor's browser may receive: the widget's own events, without anything internal (handoff reasons, staff-only events). */
function widgetEvent(event: RealtimeEvent): { type: string; data: unknown } | null {
  switch (event.type) {
    case 'message':
      return { type: 'message', data: { type: 'message', message: publicMessage(event.message) } };
    case 'conversation.status':
      return { type: event.type, data: { type: event.type, conversationId: event.conversationId, status: event.status } };
    case 'ai.activity':
      // Record-keeping ("Saving your details…") is for staff: the visitor just sees the typing dots.
      return event.internal ? null : { type: event.type, data: event };
    case 'ai.typing':
    case 'ai.delta':
    case 'ai.done':
      return { type: event.type, data: event };
    default:
      return null;
  }
}

/** Whether nobody will answer the visitor's next message (the agent is off, or it stopped itself here). */
async function quietOf(
  c: Container,
  orgId: string,
  botId: string | null,
  conv: { status: string; metadata: Record<string, unknown> } | null,
): Promise<Quiet | null> {
  const [bot, org] = await Promise.all([
    botId ? c.bots.get({ orgId }, botId).catch(() => null) : null,
    c.tenancy.getOrganization(orgId).catch(() => null),
  ]);
  return quietReason(
    { status: conv?.status ?? 'ai_active', metadata: conv?.metadata, hasBot: Boolean(bot), botActive: Boolean(bot?.isActive), aiEnabled: org?.aiEnabled ?? true },
    new Date(),
  );
}

async function openConversation(c: Container, claims: { orgId: string; channelAccountId: string; visitorId: string }) {
  const channel = await c.channels.get({ orgId: claims.orgId }, claims.channelAccountId);
  return c.conversations.openForIdentity({ orgId: claims.orgId }, claims.channelAccountId, channel.channel, claims.visitorId);
}

/** What a visitor may see: no internal ids of staff, runs or sources beyond titles/links. */
function publicMessage(m: {
  id: string;
  direction: string;
  senderType: string;
  content: string;
  createdAt: Date;
  citations: Array<{ title: string; url?: string | null }>;
}) {
  return {
    id: m.id,
    role: m.direction === 'inbound' ? 'user' : m.senderType === 'human' ? 'agent' : 'assistant',
    content: m.content,
    createdAt: m.createdAt,
    sources: m.citations.filter((s) => s.url).map((s) => ({ title: s.title, url: s.url })),
  };
}
