import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, ts, updatedAt } from './_helpers';
import { organizations, users } from './core';

/**
 * Domain events. Written in the same transaction as the change they describe (outbox pattern),
 * then dispatched to webhook endpoints. Rows with a conversation id double as the conversation timeline.
 */
export const events = pgTable(
  'events',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    actor: text().$type<'ai' | 'user' | 'contact' | 'system'>().notNull().default('system'),
    actorUserId: uuid(),
    contactId: uuid(),
    conversationId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    dispatchedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('events_org_created_idx').on(t.organizationId, t.createdAt),
    index('events_conversation_idx').on(t.conversationId, t.createdAt),
    index('events_contact_idx').on(t.contactId, t.createdAt),
    index('events_undispatched_idx').on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    url: text().notNull(),
    secretEnc: text().notNull(),
    /** Event types to deliver; ['*'] = all. */
    eventTypes: text().array().notNull().default(sql`'{*}'::text[]`),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_endpoints_org_idx').on(t.organizationId)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid().notNull().references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: uuid().notNull().references(() => events.id, { onDelete: 'cascade' }),
    eventType: text().notNull(),
    status: text().$type<'pending' | 'success' | 'failed'>().notNull().default('pending'),
    attemptCount: integer().notNull().default(0),
    responseStatus: integer(),
    responseBody: text(),
    lastError: text(),
    deliveredAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_endpoint_event_uq').on(t.endpointId, t.eventId),
    index('webhook_deliveries_org_created_idx').on(t.organizationId, t.createdAt),
  ],
);

/** Where a workflow input's value comes from: what the model passes from the chat, or the contact record. */
export type WorkflowInputSource = 'chat' | 'contact.email' | 'contact.phone' | 'contact.name' | 'contact.id';

export interface WorkflowInputField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  /** Default `chat`. A record source is filled by the server; the model can't set it. */
  source?: WorkflowInputSource;
}

/** A named n8n (or any HTTP) workflow a bot may trigger through the `trigger_workflow` tool. */
export const workflows = pgTable(
  'workflows',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    name: text().notNull(),
    /** Tells the AI when to use it. */
    description: text().notNull(),
    url: text().notNull(),
    secretEnc: text().notNull(),
    mode: text().$type<'fire_and_forget' | 'request_response'>().notNull().default('fire_and_forget'),
    inputFields: jsonb().$type<WorkflowInputField[]>().notNull().default([]),
    timeoutMs: integer().notNull().default(10_000),
    /** Runs only for customers identified by the business's own systems (chat-API conversations), never a web-chat visitor. */
    identifiedOnly: boolean().notNull().default(false),
    /** The team approves each call first (F5b); with `identifiedOnly`, that also admits web-chat visitors. */
    askFirst: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('workflows_org_key_uq').on(t.organizationId, t.key)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null = visible to every member of the organization. */
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(''),
    link: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_org_created_idx').on(t.organizationId, t.createdAt.desc())],
);

/** Who has read an organization-wide notification (each member reads their own copy). */
export const notificationReads = pgTable(
  'notification_reads',
  {
    notificationId: uuid().notNull().references(() => notifications.id, { onDelete: 'cascade' }),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    readAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.notificationId, t.userId] })],
);
