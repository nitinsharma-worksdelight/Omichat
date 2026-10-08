import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { Container } from '../container';
import { pingDatabase } from '../db/client';
import { AppError } from '../lib/errors';
import { DEMO_HEADERS, DEMO_HTML, DEMO_JS } from './demo-page';
import { registerApprovalRoutes } from './routes/approvals';
import { registerAuthRoutes } from './routes/auth';
import { registerAutomationRoutes } from './routes/automation';
import { registerBotRoutes } from './routes/bots';
import { registerChannelRoutes } from './routes/channels';
import { registerContactRoutes } from './routes/contacts';
import { registerConversationRoutes } from './routes/conversations';
import { registerDealRoutes } from './routes/deals';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerOrgRoutes } from './routes/org';
import { registerPublicApiRoutes } from './routes/public-api';
import { registerSchedulingRoutes } from './routes/scheduling';
import { registerWidgetRoutes } from './routes/widget';

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: c.logger as FastifyBaseLogger,
    bodyLimit: 1_000_000,
    trustProxy: c.env.trustProxy,
  });

  // Widget endpoints are called from customer websites (origin checked per channel at session start);
  // everything else only from the dashboard.
  await app.register(cors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      const url = req.url ?? '';
      if (url.startsWith('/widget') || url === '/widget.js') {
        cb(null, { origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['authorization', 'content-type'] });
        return;
      }
      cb(null, {
        origin: origin ? c.env.dashboardOrigins.includes(origin) : false,
        credentials: false,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['authorization', 'content-type', 'x-org-id'],
        exposedHeaders: ['x-total-count', 'x-server-time'],
      });
    },
  });
  // The server's clock, so the dashboard can show "just now" for something just created even when the browser's clock
  // is a minute off (it measures the difference from this header).
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-server-time', String(c.now().getTime()));
  });
  const limiterRedis = c.env.REDIS_URL ? new Redis(c.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }) : undefined;
  limiterRedis?.on('error', (err) => c.logger.warn({ err }, 'rate limiter: Redis unavailable, requests are not being limited'));
  await app.register(rateLimit, {
    global: false,
    // If Redis can't be reached, let requests through rather than failing every limited route.
    skipOnError: true,
    ...(limiterRedis ? { redis: limiterRedis } : {}),
  });
  await app.register(multipart, { limits: { fileSize: c.env.MAX_UPLOAD_MB * 1_000_000, files: 1, fields: 10 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) {
      void reply.status(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: e.message } });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    void reply.status(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.get('/', async () => ({ service: 'omnichannel-ai', docs: 'docs/API.md', health: '/health', widget: '/widget.js' }));

  app.get('/health', async (_req, reply) => {
    const db = await pingDatabase(c.db);
    return reply
      .status(db ? 200 : 503)
      .send({ status: db ? 'ok' : 'degraded', db, llm: c.llm.name, model: c.llm.info.model, embeddings: c.embeddings.model });
  });

  // The embeddable widget bundle, served from the API origin so the snippet is a single <script> tag.
  const widgetPath = process.env.WIDGET_BUNDLE_PATH ?? path.resolve(process.cwd(), '../widget/dist/widget.js');
  app.get('/widget.js', async (_req, reply) => {
    if (!existsSync(widgetPath)) return reply.status(404).type('text/plain').send('// widget not built: npm run build -w @omni/widget');
    return reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', c.env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache')
      .send(readFileSync(widgetPath));
  });

  // The testers' demo page (/demo?key=pk_…): on this address, never next to the dashboard where the login is kept.
  app.get('/demo', async (_req, reply) => reply.headers(DEMO_HEADERS).type('text/html; charset=utf-8').send(DEMO_HTML));
  app.get('/demo.js', async (_req, reply) => reply.headers(DEMO_HEADERS).type('application/javascript; charset=utf-8').send(DEMO_JS));

  await app.register(
    async (v1) => {
      await registerAuthRoutes(v1, c);
      await registerOrgRoutes(v1, c);
      await registerBotRoutes(v1, c);
      await registerChannelRoutes(v1, c);
      await registerContactRoutes(v1, c);
      await registerConversationRoutes(v1, c);
      await registerDealRoutes(v1, c);
      await registerApprovalRoutes(v1, c);
      await registerKnowledgeRoutes(v1, c);
      await registerSchedulingRoutes(v1, c);
      await registerAutomationRoutes(v1, c);
      await registerPublicApiRoutes(v1, c);
    },
    { prefix: '/v1' },
  );
  await app.register(async (w) => registerWidgetRoutes(w, c), { prefix: '/widget/v1' });

  return app;
}
