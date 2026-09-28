import type { Env } from '../../config/env';
import type { LlmUsage } from './llm/types';

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  cachedInput?: number;
  cacheWrite?: number;
  output: number;
}

/**
 * Prices come only from configuration (LLM_PRICE_*, LLM_UTILITY_PRICE_*, LLM_MODEL_PRICES), so no
 * model names or prices live in code. A model without a price is costed at $0 and reported once, so
 * the operator knows cost tracking and budgets are not in effect for it.
 */
export class PriceBook {
  private readonly prices = new Map<string, ModelPrice>();
  private readonly warned = new Set<string>();

  constructor(
    entries: Record<string, ModelPrice>,
    private readonly onMissing: (model: string) => void = () => {},
  ) {
    for (const [model, price] of Object.entries(entries)) this.prices.set(model, price);
  }

  static fromEnv(env: Env, onMissing?: (model: string) => void): PriceBook {
    const entries: Record<string, ModelPrice> = {};
    if (env.LLM_MODEL_PRICES) {
      for (const [model, p] of Object.entries(JSON.parse(env.LLM_MODEL_PRICES) as Record<string, ModelPrice>)) {
        if (typeof p?.input === 'number' && typeof p?.output === 'number') entries[model] = p;
      }
    }
    const fromVars = (input?: number, cachedInput?: number, cacheWrite?: number, output?: number): ModelPrice | null =>
      input !== undefined && output !== undefined ? { input, cachedInput, cacheWrite, output } : null;
    const utility = fromVars(
      env.LLM_UTILITY_PRICE_INPUT_PER_MTOK,
      env.LLM_UTILITY_PRICE_CACHED_INPUT_PER_MTOK,
      env.LLM_UTILITY_PRICE_CACHE_WRITE_PER_MTOK,
      env.LLM_UTILITY_PRICE_OUTPUT_PER_MTOK,
    );
    if (env.LLM_UTILITY_MODEL && utility) entries[env.LLM_UTILITY_MODEL] = utility;
    const main = fromVars(env.LLM_PRICE_INPUT_PER_MTOK, env.LLM_PRICE_CACHED_INPUT_PER_MTOK, env.LLM_PRICE_CACHE_WRITE_PER_MTOK, env.LLM_PRICE_OUTPUT_PER_MTOK);
    if (env.LLM_MODEL && main) entries[env.LLM_MODEL] = main;
    return new PriceBook(entries, onMissing);
  }

  has(model: string): boolean {
    return this.prices.has(model);
  }

  /** Cache reads/writes fall back to the input price when their own price isn't configured. */
  costUsd(model: string, usage: LlmUsage): number {
    const price = this.prices.get(model);
    if (!price) {
      if (!this.warned.has(model)) {
        this.warned.add(model);
        this.onMissing(model);
      }
      return 0;
    }
    const perToken = (usd: number) => usd / 1_000_000;
    return (
      usage.inputTokens * perToken(price.input) +
      usage.cacheReadTokens * perToken(price.cachedInput ?? price.input) +
      usage.cacheWriteTokens * perToken(price.cacheWrite ?? price.input) +
      usage.outputTokens * perToken(price.output)
    );
  }
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
