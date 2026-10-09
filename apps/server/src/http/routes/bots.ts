import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { parseInput, parsePatch } from '../../lib/validation';
import { buildSystemPrompt } from '../../modules/ai/prompt';
import { CUSTOM_API_BUILTINS, offeredStarters } from '../../modules/bots/config';
import { BotCreateSchema, BotUpdateSchema } from '../../modules/bots/service';
import { openingGreeting } from '../../modules/channels/service';
import { hasAskFirst } from '../../modules/tools/types';
import { requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

const ApiTestSchema = z.object({
  api: z.record(z.string(), z.unknown()),
  secret: z.string().max(4000).optional(),
  inputs: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).default({}),
  builtins: z.partialRecord(z.enum(CUSTOM_API_BUILTINS), z.string().max(500)).default({}),
});

export async function registerBotRoutes(app: FastifyInstance, c: Container) {
  /** The server's LLM configuration: what bots use unless they override the model or effort. */
  app.get('/ai/config', async (req) => {
    await requireUser(c, req);
    const info = c.llm.info;
    return {
      ...info,
      pricing: { model: c.prices.has(info.model), utilityModel: c.prices.has(info.utilityModel) },
      reasoningEfforts: ['low', 'medium', 'high'],
    };
  });

  app.get('/bots', async (req) => {
    const auth = await requireUser(c, req);
    return c.bots.list({ orgId: auth.orgId });
  });

  app.get('/bots/:id', async (req) => {
    const auth = await requireUser(c, req);
    return c.bots.get({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/bots', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.bots.create({ orgId: auth.orgId }, parseInput(BotCreateSchema, req.body)));
  });

  app.patch('/bots/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.bots.update({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(BotUpdateSchema, req.body));
  });

  /** A copy of the bot, switched off: settings, API credentials and knowledge bases included. */
  app.post('/bots/:id/duplicate', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.bots.duplicate({ orgId: auth.orgId }, parseInput(Id, req.params).id));
  });

  /**
   * The API Call action's Test tab: sends a draft API definition with sample values and returns what came back.
   * Without a new credential, the bot's stored one for that API is used.
   */
  app.post('/bots/:id/custom-apis/test', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const botId = parseInput(Id, req.params).id;
    const body = parseInput(ApiTestSchema, req.body);
    await c.bots.get({ orgId: auth.orgId }, botId);
    return c.customApis.test({ orgId: auth.orgId }, { botId, api: body.api, secret: body.secret, inputs: body.inputs, builtins: body.builtins });
  });

  app.delete('/bots/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.bots.delete({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  /** The exact system prompt and tool list the model sees — for debugging bot behaviour. */
  app.get('/bots/:id/preview', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    const bot = await c.bots.get({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    const ctx = await c.toolExecutor.schemaContext(auth.orgId, bot);
    const tools = c.toolExecutor.prepare(ctx).specs;
    const knowledgeLanguages = await c.knowledge.languagesOf({ orgId: auth.orgId }, bot.knowledgeBaseIds);
    const org = await c.tenancy.getOrganization(auth.orgId);
    return {
      provider: c.llm.info.provider,
      model: bot.model ?? c.llm.info.model,
      reasoningEffort: bot.effort ?? c.llm.info.reasoningEffort,
      system: buildSystemPrompt(bot, {
        customFields: ctx.customFields,
        hasKnowledge: bot.knowledgeBaseIds.length > 0,
        knowledgeLanguages,
        organizationName: org.name,
        activeTools: tools.map((t) => t.name),
        asksFirst: hasAskFirst(ctx, tools.map((t) => t.name)),
      }),
      tools,
    };
  });

  /**
   * A fresh test chat with this bot. Returns a widget session token for the org's playground channel;
   * the dashboard then uses the same /widget/v1 endpoints the real widget uses.
   */
  app.post('/bots/:id/playground', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    const bot = await c.bots.get({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    const channel = await c.channels.ensureSystemChannel(auth.orgId, 'playground');
    const visitorId = `pg_${auth.userId.slice(0, 8)}_${crypto.randomUUID()}`;
    const token = await c.tokens.signWidgetToken({ orgId: auth.orgId, channelAccountId: channel.id, visitorId, botId: bot.id });
    return {
      token,
      visitorId,
      greeting: openingGreeting(channel.config, bot),
      botName: bot.config.persona.assistantName,
      starters: offeredStarters(bot.config),
    };
  });
}
