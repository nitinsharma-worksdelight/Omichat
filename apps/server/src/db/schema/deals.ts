import { date, index, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_helpers';
import { conversations } from './conversations';
import { organizations, users } from './core';
import { contacts } from './crm';

/** A sales pipeline: ordered stages that open deals move through. Won and lost are statuses, not stages. */
export const pipelines = pgTable(
  'pipelines',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('pipelines_org_idx').on(t.organizationId, t.position)],
);

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    pipelineId: uuid().notNull().references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('pipeline_stages_pipeline_idx').on(t.pipelineId, t.position)],
);

export type DealStatus = 'open' | 'won' | 'lost';
/** Who created the deal: the team in the dashboard, an integration (API key), or (later) the AI. */
export type DealSource = 'user' | 'api' | 'ai';

export const deals = pgTable(
  'deals',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    // No cascade: a pipeline or stage that still has deals can't be removed (the service moves them first).
    pipelineId: uuid().notNull().references(() => pipelines.id),
    stageId: uuid().notNull().references(() => pipelineStages.id),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    value: numeric({ precision: 14, scale: 2 }),
    /** ISO 4217, from the organization's setting when the deal was created. */
    currency: text().notNull().default('USD'),
    status: text().$type<DealStatus>().notNull().default('open'),
    lostReason: text(),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    expectedCloseOn: date(),
    /** The conversation it came from, if any. */
    conversationId: uuid().references(() => conversations.id, { onDelete: 'set null' }),
    createdBy: text().$type<DealSource>().notNull().default('user'),
    /** When it was won or lost; null while open. */
    closedAt: ts(),
    stageChangedAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('deals_board_idx').on(t.organizationId, t.pipelineId, t.stageId, t.status), index('deals_contact_idx').on(t.contactId)],
);
