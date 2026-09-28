import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts } from './_helpers';
import { bots } from './bots';
import { aiRuns, conversations } from './conversations';
import { organizations, users } from './core';
import { contacts } from './crm';

/**
 * `running` only while an approved action is being carried out. A pending request past `expiresAt` is expired: it
 * can't be decided any more.
 */
export type ApprovalStatus = 'pending' | 'running' | 'approved' | 'rejected';

/** An action the assistant asked to take, waiting for (or decided by) the team. */
export const actionApprovals = pgTable(
  'action_approvals',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    botId: uuid().references(() => bots.id, { onDelete: 'set null' }),
    aiRunId: uuid().references(() => aiRuns.id, { onDelete: 'set null' }),
    toolName: text().notNull(),
    /** The validated request, run exactly as asked once approved. */
    input: jsonb().$type<Record<string, unknown>>().notNull(),
    /** What it does, in words, for the team and the assistant ("Move the customer to the “customer” stage"). */
    summary: text().notNull(),
    status: text().$type<ApprovalStatus>().notNull().default('pending'),
    /** What the action returned once approved. */
    result: jsonb().$type<Record<string, unknown>>(),
    /** Why the team declined. */
    reason: text(),
    decidedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('action_approvals_org_status_idx').on(t.organizationId, t.status, t.createdAt), index('action_approvals_conversation_idx').on(t.conversationId)],
);
