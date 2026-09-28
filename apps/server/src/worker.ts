import { loadEnv } from './config/env';
import { createContainer } from './container';

/** Queue workers (AI replies, ingestion, webhooks, notifications). Scale separately from the API. */
const env = loadEnv({ RUN_WORKERS_IN_API: 'true' });
if (!env.REDIS_URL) {
  console.error('The standalone worker needs REDIS_URL. Without Redis, the API runs the workers in-process.');
  process.exit(1);
}
const container = await createContainer(env);
container.startWorkers();
container.logger.info({ llm: container.llm.name, model: container.llm.info.model }, 'worker ready');

async function shutdown() {
  await container.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
