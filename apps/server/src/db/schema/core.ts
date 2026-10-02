import { boolean, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, ts, updatedAt } from './_helpers';

export interface OrgSettings {
  /** Emails that receive staff notifications (handoffs, qualified leads, bookings). */
  notificationEmails?: string[];
  /** Lifecycle stages shown in the CRM, in order. */
  lifecycleStages?: string[];
  /** ISO-3166 alpha-2 country used to interpret phone numbers typed without a +country code. */
  defaultCountry?: string;
  /** ISO 4217 currency for deal values (default USD). */
  currency?: string;
  /** Whether website visitors' IP addresses are recorded. Missing = yes (organizations from before the setting); new organizations start with false. */
  recordVisitorIp?: boolean;
  /** When the team is around (in the organization's timezone). Off or missing = always. */
  teamHours?: { enabled: boolean; weekly: Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', Array<{ start: string; end: string }>>> };
}

export const organizations = pgTable('organizations', {
  id: pk(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  timezone: text().notNull().default('UTC'),
  aiEnabled: boolean().notNull().default(true),
  monthlyAiBudgetUsd: numeric({ precision: 10, scale: 2 }),
  settings: jsonb().$type<OrgSettings>().notNull().default({}),
  /** Link to the LeadsMagnet account (owner user_id) once integrated. */
  externalAccountId: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    name: text().notNull().default(''),
    passwordHash: text(),
    authProvider: text().$type<'local' | 'supabase'>().notNull().default('local'),
    externalAuthId: text().unique(),
    lastLoginAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text().$type<Role>().notNull().default('agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('memberships_org_user_uq').on(t.organizationId, t.userId), index('memberships_user_idx').on(t.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    prefix: text().notNull(),
    keyHash: text().notNull().unique(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    createdByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: ts(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_org_idx').on(t.organizationId)],
);
