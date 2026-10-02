import { loadEnv } from './config/env';
import { createContainer } from './container';
import { buildApp } from './http/app';

const env = loadEnv();
const container = await createContainer(env);
if (env.RUN_WORKERS_IN_API) container.startWorkers();
const app = await buildApp(container);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  container.logger.info({ signal }, 'shutting down');
  await app.close();
  await container.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });
container.logger.info(
  {
    url: env.PUBLIC_API_URL ?? 'from each request',
    database: container.database.kind,
    queue: env.REDIS_URL ? 'bullmq' : 'inline',
    llm: container.llm.name,
    model: container.llm.info.model,
    utilityModel: container.llm.info.utilityModel,
    embeddings: container.embeddings.model,
    workers: env.RUN_WORKERS_IN_API ? 'in-process' : 'separate',
  },
  'API ready',
);
if (env.NODE_ENV === 'production' && env.PUBLIC_API_URL && /\/\/(localhost|127\.0\.0\.1)(:|$)/.test(env.PUBLIC_API_URL)) {
  container.logger.warn(`PUBLIC_API_URL is ${env.PUBLIC_API_URL}: embed codes will point there. Unset it to use the address the API is reached at.`);
}
if (env.NODE_ENV === 'production' && !env.TRUST_PROXY) {
  container.logger.warn(
    'TRUST_PROXY is not set: forwarded client addresses are ignored, so behind a load balancer every visitor shares its address for rate limits. Set it to the proxy\'s address range.',
  );
}
if (container.llm.name === 'mock') {
  container.logger.warn('No LLM provider configured: the assistant replies with placeholder text. Set LLM_PROVIDER, LLM_MODEL and the API key in apps/server/.env.');
} else {
  void container.llm.verify?.().then((r) => (r.ok ? container.logger.info(r.message) : container.logger.error(`LLM check failed — ${r.message}`)));
}
