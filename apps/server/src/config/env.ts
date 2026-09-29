import { existsSync } from 'node:fs';
import { z } from 'zod';

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const price = z.coerce.number().nonnegative().optional();
const effort = z.enum(['low', 'medium', 'high']).optional();

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me-0123456789';
// 32 zero bytes, base64. Only ever used outside production.
const DEV_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().default(4000),
    /**
     * The API's public address, for the widget embed code. Optional: when unset, the address each request came in on
     * is used (right locally, on staging and in production). Set it for a custom domain.
     */
    PUBLIC_API_URL: z.string().url().optional(),
    DASHBOARD_ORIGINS: z.string().default('http://localhost:5173'),
    /**
     * Which proxies in front of the API to believe about the client's address (X-Forwarded-For) and protocol:
     * `true` (default: all), `false` (none), or a comma-separated list of the proxies' addresses and ranges, including
     * `loopback`, `linklocal` and `uniquelocal` (private networks). Only listed proxies' forwarded addresses count, so a
     * visitor can't make up theirs. A number of hops isn't accepted: it can't tell a proxy from a visitor.
     */
    TRUST_PROXY: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || !/^\d+$/.test(v), 'TRUST_PROXY takes the proxies’ addresses or ranges (e.g. uniquelocal), not a number of hops'),

    DATABASE_URL: z.string().default('pglite://.data/pglite'),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    /** Run tenant queries as the RLS-restricted role. Disable only if your DB user cannot SET ROLE. */
    DB_ENFORCE_RLS: bool(true),
    AUTO_MIGRATE: bool(true),

    REDIS_URL: z.string().optional(),
    RUN_WORKERS_IN_API: bool(true),

    AUTH_MODE: z.enum(['local', 'supabase']).default('local'),
    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    JWT_TTL_HOURS: z.coerce.number().positive().default(12),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_JWT_SECRET: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    ENCRYPTION_KEY: z.string().default(DEV_ENCRYPTION_KEY),

    // ---- LLM: provider and model are configuration only; no model name lives in code ----
    /** openai | anthropic. Unset → placeholder replies (development only). */
    LLM_PROVIDER: z.enum(['openai', 'anthropic', 'mock']).optional(),
    /** The model every bot uses unless the bot sets an override. Required for real providers. */
    LLM_MODEL: z.string().trim().min(1).optional(),
    /** Sent only when set (and only valid for reasoning models). */
    LLM_REASONING_EFFORT: effort,
    /** Background work such as conversation summaries. Defaults to LLM_MODEL. */
    LLM_UTILITY_MODEL: z.string().trim().min(1).optional(),
    LLM_UTILITY_REASONING_EFFORT: effort,
    /** Only for an explicit gateway/compatible endpoint. Ambient *_BASE_URL variables are ignored. */
    LLM_BASE_URL: z.string().url().optional(),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(120_000),
    /** USD per 1M tokens for LLM_MODEL (cost tracking and monthly budgets). */
    LLM_PRICE_INPUT_PER_MTOK: price,
    LLM_PRICE_CACHED_INPUT_PER_MTOK: price,
    LLM_PRICE_CACHE_WRITE_PER_MTOK: price,
    LLM_PRICE_OUTPUT_PER_MTOK: price,
    /** Same, for LLM_UTILITY_MODEL when it differs from LLM_MODEL. */
    LLM_UTILITY_PRICE_INPUT_PER_MTOK: price,
    LLM_UTILITY_PRICE_CACHED_INPUT_PER_MTOK: price,
    LLM_UTILITY_PRICE_CACHE_WRITE_PER_MTOK: price,
    LLM_UTILITY_PRICE_OUTPUT_PER_MTOK: price,
    /** Optional JSON for any other model (e.g. per-bot overrides): {"<model>":{"input":1,"cachedInput":0.1,"cacheWrite":1.25,"output":4}} */
    LLM_MODEL_PRICES: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    /** Anthropic-only: server-side refusal fallbacks. Enable only for models that support them. */
    ANTHROPIC_REFUSAL_FALLBACKS: bool(false),
    AI_REPLY_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1200),
    AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(10).default(5),
    AI_HISTORY_MESSAGES: z.coerce.number().int().min(4).max(100).default(20),
    /** Longest a reply may take, model calls and tools included; a turn that runs out is retried like any provider error. */
    AI_TURN_TIMEOUT_MS: z.coerce.number().int().min(100).default(90_000),
    /** Recap a conversation after this many minutes without new messages (and when it's closed). 0 = no quiet-spell recaps. */
    AI_SUMMARY_IDLE_MINUTES: z.coerce.number().min(0).max(1440).default(30),

    EMBEDDINGS_PROVIDER: z.enum(['openai', 'local']).optional(),
    EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),

    STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.data/uploads'),
    SUPABASE_STORAGE_BUCKET: z.string().default('knowledge'),

    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Omnichannel AI <notifications@example.com>'),

    WIDGET_TOKEN_TTL_HOURS: z.coerce.number().positive().default(24),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(20),
  })
  .transform((env) => ({
    ...env,
    PUBLIC_API_URL: env.PUBLIC_API_URL?.replace(/\/+$/, ''),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    LLM_PROVIDER: env.LLM_PROVIDER ?? 'mock',
    EMBEDDINGS_PROVIDER: env.EMBEDDINGS_PROVIDER ?? (env.OPENAI_API_KEY ? 'openai' : 'local'),
    dashboardOrigins: env.DASHBOARD_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  }));

export type Env = z.infer<typeof EnvSchema>;

/** TRUST_PROXY as Fastify takes it; a bad address in a list fails at startup. */
function parseTrustProxy(raw: string | undefined): boolean | string {
  if (!raw || raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  if (existsSync('.env') && !process.env.SKIP_DOTENV) {
    process.loadEnvFile('.env');
  }
  // Blank values (`KEY=` in .env) mean "not set", so defaults apply instead of failing validation.
  const raw = Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const llmProblems: string[] = [];
  if (env.LLM_PROVIDER !== 'mock') {
    if (!env.LLM_MODEL) llmProblems.push(`LLM_MODEL is required when LLM_PROVIDER=${env.LLM_PROVIDER}`);
    if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) llmProblems.push('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
    if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) llmProblems.push('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
  }
  if (env.LLM_MODEL_PRICES) {
    try {
      JSON.parse(env.LLM_MODEL_PRICES);
    } catch {
      llmProblems.push('LLM_MODEL_PRICES must be valid JSON');
    }
  }
  if (llmProblems.length) throw new Error(`Invalid LLM configuration:\n  ${llmProblems.join('\n  ')}`);
  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (env.JWT_SECRET === DEV_JWT_SECRET) problems.push('JWT_SECRET must be set');
    if (env.ENCRYPTION_KEY === DEV_ENCRYPTION_KEY) problems.push('ENCRYPTION_KEY must be set');
    if (!env.REDIS_URL) problems.push('REDIS_URL is required (queues, locks, streaming)');
    if (env.DATABASE_URL.startsWith('pglite://')) problems.push('DATABASE_URL must point at Postgres');
    if (env.LLM_PROVIDER === 'mock') problems.push('LLM_PROVIDER must be set (openai or anthropic)');
    if (env.AUTH_MODE === 'supabase' && !env.SUPABASE_URL && !env.SUPABASE_JWT_SECRET) {
      problems.push('SUPABASE_URL or SUPABASE_JWT_SECRET is required when AUTH_MODE=supabase');
    }
    if (problems.length) throw new Error(`Refusing to start in production:\n  ${problems.join('\n  ')}`);
  }
  if (Buffer.from(env.ENCRYPTION_KEY, 'base64').length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  return env;
}
