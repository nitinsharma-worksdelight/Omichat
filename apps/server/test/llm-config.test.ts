import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { schema } from '../src/db/client';
import { createLlmProvider } from '../src/modules/ai/llm/registry';
import { PriceBook } from '../src/modules/ai/pricing';
import { LocalHashEmbeddingProvider } from '../src/modules/knowledge/embeddings';
import { authHeaders, createOrg, createTestEnv, text, type TestEnv } from './helpers';

process.env.SKIP_DOTENV = '1';
const base = { NODE_ENV: 'test', DATABASE_URL: 'pglite://memory' };

describe('LLM configuration', () => {
  it('requires a model and the matching key for real providers', () => {
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' })).toThrow(/LLM_MODEL is required/);
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'any-model' })).toThrow(/OPENAI_API_KEY is required/);
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'anthropic', LLM_MODEL: 'any-model' })).toThrow(/ANTHROPIC_API_KEY is required/);
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'nope' })).toThrow(/LLM_PROVIDER/);
    expect(() => loadEnv({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'm', OPENAI_API_KEY: 'k', LLM_MODEL_PRICES: '{oops' })).toThrow(/valid JSON/);
  });

  it('refuses the placeholder provider in production', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
    ).toThrow(/LLM_PROVIDER must be set/);
  });

  it('treats blank .env values as unset', () => {
    const env = loadEnv({ ...base, JWT_SECRET: '', ENCRYPTION_KEY: '', LLM_PROVIDER: '', LLM_MODEL: '' });
    expect(env.LLM_PROVIDER).toBe('mock');
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('builds whichever provider is configured, with the configured model', () => {
    const openai = createLlmProvider(loadEnv({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'model-a', OPENAI_API_KEY: 'k', LLM_REASONING_EFFORT: 'low' }));
    expect(openai.name).toBe('openai');
    expect(openai.info).toEqual({ provider: 'openai', model: 'model-a', reasoningEffort: 'low', utilityModel: 'model-a', utilityReasoningEffort: 'low' });
    const anthropic = createLlmProvider(
      loadEnv({ ...base, LLM_PROVIDER: 'anthropic', LLM_MODEL: 'model-b', ANTHROPIC_API_KEY: 'k', LLM_UTILITY_MODEL: 'model-c' }),
    );
    expect(anthropic.name).toBe('anthropic');
    expect(anthropic.info).toMatchObject({ model: 'model-b', utilityModel: 'model-c', utilityReasoningEffort: null });
  });

  it('prices only what configuration names', () => {
    const missing: string[] = [];
    const env = loadEnv({
      ...base,
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'k',
      LLM_MODEL: 'model-a',
      LLM_PRICE_INPUT_PER_MTOK: '0.15',
      LLM_PRICE_CACHED_INPUT_PER_MTOK: '0.075',
      LLM_PRICE_OUTPUT_PER_MTOK: '0.60',
      LLM_MODEL_PRICES: JSON.stringify({ 'override-model': { input: 2, output: 10 } }),
    });
    const book = PriceBook.fromEnv(env, (m) => missing.push(m));
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };
    expect(book.costUsd('model-a', usage)).toBeCloseTo(0.15 + 0.075 + 0.6);
    expect(book.costUsd('override-model', { ...usage, cacheReadTokens: 0 })).toBeCloseTo(12);
    expect(book.costUsd('unknown', usage)).toBe(0);
    book.costUsd('unknown', usage);
    expect(missing).toEqual(['unknown']); // reported once
  });
});

describe('bots follow the configured model unless overridden', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await createTestEnv();
  });
  afterAll(() => t.close());

  it('new bots store no model; overrides can be set and cleared', async () => {
    const org = await createOrg(t.c);
    expect(org.bot).toMatchObject({ model: null, effort: null });
    const h = authHeaders(org.token);
    const cfg = await t.app.inject({ method: 'GET', url: '/v1/ai/config', headers: h });
    expect(cfg.json()).toMatchObject({ provider: 'mock', model: 'mock', reasoningEfforts: ['low', 'medium', 'high'] });

    t.llm.setScript([text('one'), text('two')]);
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'm1', content: 'hi' });
    await t.c.queue.drain();
    expect(t.llm.requests[0]).toMatchObject({ tier: 'reply', model: undefined, reasoningEffort: undefined });

    const patched = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: h, payload: { model: 'some-other-model', effort: 'medium' } });
    expect(patched.json()).toMatchObject({ model: 'some-other-model', effort: 'medium' });
    await t.c.conversations.receiveInbound({ orgId: org.orgId, channelAccountId: org.webchat.id, externalUserId: 'm1', content: 'again' });
    await t.c.queue.drain();
    expect(t.llm.requests.at(-1)).toMatchObject({ model: 'some-other-model', reasoningEffort: 'medium' });
    const runs = await t.c.tenantDb.run(org.orgId, (tx) => tx.select().from(schema.aiRuns));
    expect(runs.map((r) => [r.provider, r.model]).sort()).toEqual([
      ['mock', 'mock'],
      ['mock', 'some-other-model'],
    ]);

    const cleared = await t.app.inject({ method: 'PATCH', url: `/v1/bots/${org.bot.id}`, headers: h, payload: { model: null, effort: null } });
    expect(cleared.json()).toMatchObject({ model: null, effort: null });
    const preview = await t.app.inject({ method: 'GET', url: `/v1/bots/${org.bot.id}/preview`, headers: h });
    expect(preview.json()).toMatchObject({ provider: 'mock', model: 'mock' });
  });

  it('re-embeds documents that were embedded with a different model', async () => {
    const org = await createOrg(t.c);
    await t.c.knowledge.createTextDocument(org.scope, org.kb.id, { title: 'Hours', category: 'general', content: 'We open at 9am on weekdays.' });
    await t.c.queue.drain();
    // Simulate chunks left over from a previous embedding model.
    await t.c.db.update(schema.documentChunks).set({ embeddingModel: 'old-embedding-model' });
    const before = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'when do you open weekdays' });
    // Old vectors are ignored; keyword search still finds the document.
    expect(before.chunks[0]?.similarity ?? null).toBeNull();
    expect(await t.c.knowledge.reembedStale(t.c.db)).toBeGreaterThan(0);
    await t.c.queue.drain();
    const chunks = await t.c.db.select().from(schema.documentChunks);
    expect(new Set(chunks.map((c) => c.embeddingModel))).toEqual(new Set([new LocalHashEmbeddingProvider().model]));
    const after = await t.c.knowledge.search(org.scope, { knowledgeBaseIds: [org.kb.id], query: 'when do you open weekdays' });
    expect(after.chunks[0]!.similarity).toBeGreaterThan(0);
  });
});
