import { Redis } from 'ioredis';
import pg from 'pg';
import { loadEnv } from '../src/config/env';
import { createContainer, type Container } from '../src/container';
import { MockLlmProvider } from '../src/modules/ai/llm/mock';
import { PriceBook } from '../src/modules/ai/pricing';
import { LocalHashEmbeddingProvider } from '../src/modules/knowledge/embeddings';

process.env.SKIP_DOTENV = '1';

/**
 * The integration tier runs against a real Postgres (with pgvector) and Redis, the way production does:
 *   INTEGRATION_DATABASE_URL=postgres://user@host:port/postgres  (a role that may create databases)
 *   INTEGRATION_REDIS_URL=redis://host:port/15                   (a database it may flush)
 * Without both, every integration test is skipped.
 */
export const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
export const REDIS_URL = process.env.INTEGRATION_REDIS_URL;
export const enabled = Boolean(DATABASE_URL && REDIS_URL);

/** A new, empty database for one test file; `drop()` removes it. */
export async function freshDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `omni_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin((c) => c.query(`create database ${name}`));
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin((c) => c.query(`drop database if exists ${name} with (force)`)).then(() => undefined),
  };
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Empties the integration Redis database (files run one at a time, so nothing else is using it). */
export async function flushRedis(): Promise<void> {
  const redis = new Redis(REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
}

export function redisClient(): Redis {
  return new Redis(REDIS_URL!, { maxRetriesPerRequest: 3 });
}

export interface IntegrationEnv {
  c: Container;
  llm: MockLlmProvider;
  close(): Promise<void>;
}

/** A container on its own fresh Postgres database and the shared Redis: BullMQ queues, Redis locks and pub/sub. */
export async function createIntegrationEnv(opts: { now?: Date; workers?: boolean } = {}): Promise<IntegrationEnv> {
  const database = await freshDatabase();
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    REDIS_URL: REDIS_URL!,
    AI_REPLY_DEBOUNCE_MS: '0',
    AI_SUMMARY_IDLE_MINUTES: '0',
    STORAGE_LOCAL_DIR: `.data/it-uploads-${process.pid}`,
    LOG_LEVEL: 'silent',
  });
  const llm = new MockLlmProvider();
  const now = opts.now ?? new Date('2026-09-28T13:00:00Z'); // Monday 09:00 in Toronto
  const c = await createContainer(env, {
    llm,
    embeddings: new LocalHashEmbeddingProvider(),
    clock: () => now,
    prices: new PriceBook({ mock: { input: 1, cachedInput: 0.1, output: 5 } }),
  });
  if (opts.workers !== false) c.startWorkers();
  return {
    c,
    llm,
    async close() {
      await c.close();
      await database.drop();
    },
  };
}

/** Polls until `check` passes (or throws its last failure after `timeoutMs`). */
export async function eventually(check: () => Promise<void> | void, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
