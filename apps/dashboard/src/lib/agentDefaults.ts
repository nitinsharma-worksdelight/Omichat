import type { BotConfig } from './types';

/**
 * "Start from Scratch" fills in nothing about the agent: no name, tone, reply length, greeting or emoji rule, so what the
 * owner writes in the prompt (or sets later) is all it goes by. The chat shows a plain "Hi! How can I help?" until a
 * greeting is set, and the agent's business name until it has a name. Safety settings (stay on topic, what to do when it
 * doesn't know) keep their defaults. Pure, so the server's tests can check it.
 */
export const SCRATCH_PERSONA: Partial<BotConfig['persona']> = { assistantName: '', tone: null, responseLength: null, greeting: '', useEmojis: null };
