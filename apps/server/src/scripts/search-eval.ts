/**
 * Knowledge-base search quality on a fixed question set: how often the right document comes first, and in the
 * top 5, per language.
 *   npm run search-eval -w @omni/server
 * Uses the configured embedder: OpenAI when EMBEDDINGS_PROVIDER=openai and OPENAI_API_KEY are set (a few thousand
 * tokens of text-embedding-3-small, well under $0.01 a run), otherwise the local keyword embedder (free).
 * Runs on a throwaway in-memory database with the demo knowledge base plus a small Spanish and Hindi FAQ.
 */
import { loadEnv } from '../config/env';
import { createContainer } from '../container';
import { evaluateSearch, formatScores, seedSearchSet, SEARCH_SET } from '../../test/fixtures/search-set';

const env = loadEnv({
  DATABASE_URL: 'pglite://memory',
  REDIS_URL: '',
  LLM_PROVIDER: 'mock',
  AI_REPLY_DEBOUNCE_MS: '0',
  AI_SUMMARY_IDLE_MINUTES: '0',
  LOG_LEVEL: 'warn',
});
env.REDIS_URL = undefined;
const c = await createContainer(env);
c.startWorkers();
try {
  const seeded = await seedSearchSet(c);
  const { scores, misses } = await evaluateSearch(c, seeded);
  console.log(`\nSearch quality · embedder ${c.embeddings.model} · ${SEARCH_SET.length} questions\n`);
  console.log(formatScores(scores));
  console.log(misses.length ? `\nNot first:\n${misses.map((m) => `- ${m}`).join('\n')}` : '\nEvery question found its document first.');
} finally {
  await c.close();
}
