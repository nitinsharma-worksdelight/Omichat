import type { Env } from '../../../config/env';
import { AnthropicProvider } from './anthropic';
import { MockLlmProvider } from './mock';
import { OpenAIProvider } from './openai';
import type { LlmDefaults, LlmProvider } from './types';

/**
 * The one place that maps `LLM_PROVIDER` to an implementation. Switching providers or models is a
 * configuration change; adding a provider is one class plus one entry here.
 */
const FACTORIES: Record<Env['LLM_PROVIDER'], (env: Env, defaults: LlmDefaults) => LlmProvider> = {
  openai: (env, defaults) =>
    new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY!,
      // Pinned: an ambient OPENAI_BASE_URL in the shell must not redirect traffic.
      baseURL: env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
      timeoutMs: env.LLM_TIMEOUT_MS,
      defaults,
    }),
  anthropic: (env, defaults) =>
    new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY!,
      baseURL: env.LLM_BASE_URL ?? 'https://api.anthropic.com',
      timeoutMs: env.LLM_TIMEOUT_MS,
      defaults,
      refusalFallbacks: env.ANTHROPIC_REFUSAL_FALLBACKS,
    }),
  mock: (_env, defaults) => new MockLlmProvider(defaults),
};

export function createLlmProvider(env: Env): LlmProvider {
  const defaults: LlmDefaults = {
    model: env.LLM_MODEL ?? 'mock',
    reasoningEffort: env.LLM_REASONING_EFFORT,
    utilityModel: env.LLM_UTILITY_MODEL,
    utilityReasoningEffort: env.LLM_UTILITY_REASONING_EFFORT,
  };
  return FACTORIES[env.LLM_PROVIDER](env, defaults);
}
