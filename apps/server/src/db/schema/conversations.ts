import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, ts, updatedAt } from './_helpers';
import { organizations, users } from './core';
import { contacts } from './crm';
import { channelAccounts, type ChannelType } from './channels';
import { bots } from './bots';

export type ConversationStatus = 'ai_active' | 'human_active' | 'closed';

export type SummaryTrigger = 'quiet' | 'closed' | 'handoff' | 'manual';
export type SummarySentiment = 'positive' | 'neutral' | 'negative';

/** The parts of the latest recap, which covered the whole conversation when it was written. Folds leave it alone. */
export interface SummaryDetails {
  /** What the customer wants. */
  intent: string | null;
  /** What was answered, done or agreed. */
  outcome: string | null;
  /** What's still open and who should act; null when nothing is. */
  nextStep: string | null;
  sentiment: SummarySentiment | null;
  /** Why it was written: after a quiet spell, on close, at handoff, or at a staff member's request. */
  trigger: SummaryTrigger;
  /** When it was written (ISO). */
  at: string;
  /** The last message it covers. */
  throughMessageId: string;
}

export const conversations = pgTable(
  'conversations',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    channelAccountId: uuid().notNull().references(() => channelAccounts.id, { onDelete: 'cascade' }),
    channel: text().$type<ChannelType>().notNull(),
    botId: uuid().references(() => bots.id, { onDelete: 'set null' }),
    status: text().$type<ConversationStatus>().notNull().default('ai_active'),
    assignedUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    handoffReason: text(),
    /** When it last moved to a person (null while the AI has it), and whether staff have answered since. */
    handedOffAt: ts(),
    firstStaffReplyAt: ts(),
    /** Set once the team was alerted (and the fallback ran) for waiting past the bot's limit. */
    handoffEscalatedAt: ts(),
    /** Rolling summary of older turns (memory beyond the recent-message window). */
    summary: text(),
    summarizedThroughMessageId: uuid(),
    /** Parts of the latest recap (what the customer wants, outcome, next step, mood), for staff and integrations. */
    summaryDetails: jsonb().$type<SummaryDetails>(),
    messageCount: integer().notNull().default(0),
    aiReplyCount: integer().notNull().default(0),
    lastMessageAt: ts(),
    lastInboundAt: ts(),
    isTest: boolean().notNull().default(false),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('conversations_org_status_idx').on(t.organizationId, t.status, t.lastMessageAt.desc()),
    index('conversations_contact_idx').on(t.contactId, t.lastMessageAt.desc()),
    // One open conversation per contact per channel account.
    uniqueIndex('conversations_open_uq').on(t.channelAccountId, t.contactId).where(sql`${t.status} <> 'closed'`),
  ],
);

export type MessageDirection = 'inbound' | 'outbound';
export type SenderType = 'contact' | 'ai' | 'human' | 'system';

export interface Citation {
  chunkId: string;
  documentId: string;
  title: string;
  url?: string | null;
}

export const messages = pgTable(
  'messages',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    direction: text().$type<MessageDirection>().notNull(),
    senderType: text().$type<SenderType>().notNull(),
    senderUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    content: text().notNull(),
    attachments: jsonb().$type<Array<{ url: string; type: string; name?: string }>>().notNull().default([]),
    citations: jsonb().$type<Citation[]>().notNull().default([]),
    aiRunId: uuid(),
    /** Idempotency key from the client (widget) or provider message id (WhatsApp wamid…). */
    externalId: text(),
    status: text().$type<'received' | 'sent' | 'delivered' | 'read' | 'failed'>().notNull().default('received'),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_external_uq').on(t.conversationId, t.externalId).where(sql`${t.externalId} is not null`),
  ],
);

export const aiRuns = pgTable(
  'ai_runs',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    botId: uuid().references(() => bots.id, { onDelete: 'set null' }),
    botVersion: integer(),
    triggerMessageId: uuid(),
    provider: text(),
    model: text().notNull(),
    status: text().$type<'completed' | 'failed' | 'skipped' | 'handoff'>().notNull(),
    stopReason: text(),
    iterations: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer().notNull().default(0),
    grounding: text().$type<'grounded' | 'weak' | 'none' | 'n/a'>().notNull().default('n/a'),
    retrievedChunkIds: jsonb().$type<string[]>().notNull().default([]),
    error: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_runs_org_created_idx').on(t.organizationId, t.createdAt),
    index('ai_runs_conversation_idx').on(t.conversationId, t.createdAt),
  ],
);

export const toolInvocations = pgTable(
  'tool_invocations',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    aiRunId: uuid().notNull().references(() => aiRuns.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    toolName: text().notNull(),
    input: jsonb().$type<unknown>().notNull(),
    output: jsonb().$type<unknown>(),
    /**
     * `replayed`: a retry of the turn reused an earlier attempt's result instead of acting again. `pending`: saved as a
     * request for the team (ask first) instead of acting.
     */
    status: text().$type<'success' | 'error' | 'rejected' | 'replayed' | 'pending'>().notNull(),
    error: text(),
    durationMs: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('tool_invocations_run_idx').on(t.aiRunId), index('tool_invocations_org_created_idx').on(t.organizationId, t.createdAt)],
);
