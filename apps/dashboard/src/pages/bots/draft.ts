import type { Bot, BotConfigSection } from '../../lib/types';
import { CONFIG_SECTIONS, type BotDraft } from './editorNav';

/** What the editors edit, and the smallest PATCH that saves it. Shared by the agent editor and the full settings editor. */

export function toDraft(bot: Bot): BotDraft {
  return {
    name: bot.name,
    isActive: bot.isActive,
    model: bot.model ?? '',
    effort: bot.effort ?? '',
    maxOutputTokens: bot.maxOutputTokens,
    knowledgeBaseIds: [...bot.knowledgeBaseIds],
    // A server from before conversation starters has none to send.
    config: structuredClone({ ...bot.config, conversationStarters: bot.config.conversationStarters ?? [] }),
  };
}

/** Key order doesn't count: an editor that rebuilds an object with the same values hasn't changed it. */
const sorted = (_key: string, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v;
export const same = (a: unknown, b: unknown) => JSON.stringify(a, sorted) === JSON.stringify(b, sorted);

/** Only what changed: top-level fields plus whole config sections (the server replaces a section wholesale). */
export function buildPatch(base: BotDraft, draft: BotDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== base.name) body.name = draft.name.trim();
  if (draft.isActive !== base.isActive) body.isActive = draft.isActive;
  if (draft.model.trim() !== base.model) body.model = draft.model.trim() || null;
  if (draft.effort !== base.effort) body.effort = draft.effort || null;
  if (draft.maxOutputTokens !== base.maxOutputTokens) body.maxOutputTokens = draft.maxOutputTokens;
  if (!same([...draft.knowledgeBaseIds].sort(), [...base.knowledgeBaseIds].sort())) body.knowledgeBaseIds = draft.knowledgeBaseIds;
  const config: Partial<Record<BotConfigSection, unknown>> = {};
  for (const s of CONFIG_SECTIONS) if (!same(draft.config[s], base.config[s])) config[s] = draft.config[s];
  if (Object.keys(config).length) body.config = config;
  return body;
}

