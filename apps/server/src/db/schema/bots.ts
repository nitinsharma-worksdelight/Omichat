import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import type { BotConfig, Effort } from '../../modules/bots/config';
import { createdAt, pk, updatedAt } from './_helpers';
import { organizations } from './core';
import { knowledgeBases } from './knowledge';

export const bots = pgTable(
  'bots',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    isActive: boolean().notNull().default(true),
    /** Bumped on every config change; recorded on each AI run for auditing and cache keys. */
    version: integer().notNull().default(1),
    /** Per-bot override; null = use the server's configured LLM_MODEL. */
    model: text(),
    /** Per-bot override; null = use the server's configured reasoning effort (if any). */
    effort: text().$type<Effort>(),
    maxOutputTokens: integer().notNull().default(16000),
    config: jsonb().$type<BotConfig>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('bots_org_idx').on(t.organizationId)],
);

export const botKnowledgeBases = pgTable(
  'bot_knowledge_bases',
  {
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    botId: uuid().notNull().references(() => bots.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid().notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.botId, t.knowledgeBaseId] })],
);
