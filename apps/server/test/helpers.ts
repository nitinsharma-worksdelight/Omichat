import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../src/config/env';
import { createContainer, type Container } from '../src/container';
import { buildApp } from '../src/http/app';
import type { LockService } from '../src/infra/lock';
import { MockLlmProvider } from '../src/modules/ai/llm/mock';
import { PriceBook } from '../src/modules/ai/pricing';
import type { LlmContentBlock, LlmRequest } from '../src/modules/ai/llm/types';
import { LocalHashEmbeddingProvider } from '../src/modules/knowledge/embeddings';

process.env.SKIP_DOTENV = '1';

export interface TestEnv {
  c: Container;
  llm: MockLlmProvider;
  app: FastifyInstance;
  now: { value: Date };
  close(): Promise<void>;
}

/** A fresh in-memory Postgres (PGlite) with migrations applied, in-process queues and a scripted LLM. */
export async function createTestEnv(opts: { now?: Date; env?: Record<string, string>; locks?: LockService } = {}): Promise<TestEnv> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    REDIS_URL: '',
    AI_REPLY_DEBOUNCE_MS: '0',
    // Quiet-spell recaps are delayed jobs the queue drain would wait for; tests turn them on explicitly.
    AI_SUMMARY_IDLE_MINUTES: '0',
    STORAGE_LOCAL_DIR: `.data/test-uploads-${process.pid}`,
    LOG_LEVEL: 'silent',
    ...opts.env,
  });
  env.REDIS_URL = undefined;
  const llm = new MockLlmProvider();
  const now = { value: opts.now ?? new Date('2026-09-28T13:00:00Z') }; // Monday 09:00 in Toronto
  const c = await createContainer(env, {
    llm,
    locks: opts.locks,
    embeddings: new LocalHashEmbeddingProvider(),
    clock: () => now.value,
    // Prices come from configuration; give the placeholder model one so cost tracking is exercised.
    prices: new PriceBook({ mock: { input: 1, cachedInput: 0.1, output: 5 } }),
    inlineQueueTimeScale: Number(opts.env?.AI_REPLY_DEBOUNCE_MS ?? 0) > 0 ? 1 : 0.01,
  });
  c.startWorkers();
  const app = await buildApp(c);
  await app.ready();
  return {
    c,
    llm,
    app,
    now,
    async close() {
      await app.close();
      await c.close();
    },
  };
}

let counter = 0;

export async function createOrg(c: Container, name = 'Test Co', timezone = 'America/Toronto') {
  counter++;
  const result = await c.auth.signup({
    email: `owner${counter}-${Date.now()}@example.com`,
    password: 'password-123',
    name: 'Owner',
    organizationName: name,
    timezone,
  });
  const scope = { orgId: result.organization.id };
  const [bot] = await c.bots.list(scope);
  const channels = await c.channels.list(scope);
  const [kb] = await c.knowledge.listKnowledgeBases(scope);
  const [calendar] = await c.scheduling.listCalendars(scope);
  return {
    token: result.token,
    orgId: result.organization.id,
    scope,
    bot: bot!,
    webchat: channels.find((ch) => ch.channel === 'webchat')!,
    kb: kb!,
    calendar: calendar!,
  };
}

// ---- mock LLM script helpers ----

export const text = (t: string) => (_req?: LlmRequest, _call?: number) => ({ content: [{ type: 'text' as const, text: t }], stopReason: 'end_turn' as const });

export const tools =
  (...calls: Array<{ name: string; input: unknown; say?: string }>) =>
  (_req: LlmRequest, call: number) => ({
    content: [
      ...(calls[0]?.say ? [{ type: 'text' as const, text: calls[0].say }] : []),
      ...calls.map<LlmContentBlock>((c, i) => ({ type: 'tool_use', id: `toolu_${call}_${i}`, name: c.name, input: c.input })),
    ],
    stopReason: 'tool_use' as const,
  });

/** The tool results the orchestrator sent back in the most recent request. */
export function lastToolResults(llm: MockLlmProvider): Array<{ content: unknown; isError: boolean }> {
  const req = llm.requests[llm.requests.length - 1]!;
  const last = req.messages[req.messages.length - 1]!;
  return last.content
    .filter((b): b is Extract<LlmContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
    .map((b) => ({ content: JSON.parse(b.content), isError: b.isError }));
}

export function authHeaders(token: string, orgId?: string) {
  return { authorization: `Bearer ${token}`, ...(orgId ? { 'x-org-id': orgId } : {}) };
}
