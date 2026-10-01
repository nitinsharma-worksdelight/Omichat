import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, ts, updatedAt } from './_helpers';
import { organizations, users } from './core';
import type { ChannelType } from './channels';

export type QualificationStatus = 'not_started' | 'in_progress' | 'qualified' | 'disqualified';
export type LeadTier = 'hot' | 'warm' | 'cold';

export interface QualificationAnswer {
  value: string | number | boolean | string[];
  answeredAt: string;
  /** The bot whose question this answered (absent on answers recorded before bots were tracked). */
  botId?: string;
}

export interface ContactFact {
  /** Absent on facts saved before F2: those are identified by their text and time (`factId`). */
  id?: string;
  text: string;
  /** `ai`: the assistant noted it; `user`: the team did (staff, a shared note, or an integration). */
  source: 'ai' | 'user';
  createdAt: string;
}

/** Where a lead first came from: the website visit that started it (or what an integration reported). */
export interface FirstTouch {
  /** Origin + path, no query string. */
  landingPage?: string;
  /** Origin + path of the external page that sent them. */
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  /** Ad click ids: Google, Meta, Microsoft. */
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
  /** ISO time of the first visit. */
  at?: string;
}

export type ConsentPurpose = 'marketing';
/** chat: the customer answered in a conversation; staff: recorded by a team member; api: sent by an integration. */
export type ConsentSource = 'chat' | 'staff' | 'api';

/** Current answer per purpose (the latest record), kept on the contact for filtering. */
export interface ConsentState {
  granted: boolean;
  at: string;
  source: ConsentSource;
  textVersion: string | null;
}

export const contacts = pgTable(
  'contacts',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    firstName: text(),
    lastName: text(),
    email: text(),
    /** E.164, e.g. +14165550123 */
    phone: text(),
    company: text(),
    sourceChannel: text().$type<ChannelType>(),
    lifecycleStage: text().notNull().default('new'),
    leadScore: integer().notNull().default(0),
    leadTier: text().$type<LeadTier>(),
    qualificationStatus: text().$type<QualificationStatus>().notNull().default('not_started'),
    qualification: jsonb().$type<Record<string, QualificationAnswer>>().notNull().default({}),
    customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Long-term memory: durable facts the AI or staff noted about this person. */
    memory: jsonb().$type<ContactFact[]>().notNull().default([]),
    /** Set once, from the first visit or integration that reported one; never overwritten. */
    firstTouch: jsonb().$type<FirstTouch>(),
    /** Latest consent answer per purpose; the full history is in `contact_consents`. */
    consent: jsonb().$type<Partial<Record<ConsentPurpose, ConsentState>>>().notNull().default({}),
    timezone: text(),
    ownerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    isTest: boolean().notNull().default(false),
    /** Set when this contact was merged into another; merged rows are kept for audit. */
    mergedIntoId: uuid(),
    leadCapturedAt: ts(),
    lastActivityAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('contacts_org_created_idx').on(t.organizationId, t.createdAt.desc()),
    index('contacts_org_lead_captured_idx').on(t.organizationId, t.leadCapturedAt).where(sql`${t.leadCapturedAt} is not null`),
    index('contacts_org_activity_idx').on(t.organizationId, t.lastActivityAt.desc()),
    uniqueIndex('contacts_org_email_uq')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null and ${t.mergedIntoId} is null`),
    uniqueIndex('contacts_org_phone_uq')
      .on(t.organizationId, t.phone)
      .where(sql`${t.phone} is not null and ${t.mergedIntoId} is null`),
    index('contacts_custom_fields_gin').using('gin', t.customFields),
    index('contacts_first_touch_gin').using('gin', sql`${t.firstTouch} jsonb_path_ops`),
  ],
);

/** How a contact is known on each channel: widget visitor id, WhatsApp wa_id, Messenger PSID… */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text().$type<ChannelType>().notNull(),
    externalId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('contact_identities_uq').on(t.organizationId, t.channel, t.externalId),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

export type ContactField = 'email' | 'phone';
export type MergeCandidateStatus = 'pending' | 'merged' | 'dismissed';

/**
 * An email or phone someone gave in a chat that already belongs to another contact. Anyone can type someone
 * else's email, so these are never merged automatically: staff merge or dismiss them. While pending, the value
 * still counts as the visitor's own in their conversation (ContactsService.getForConversation).
 */
export const contactMergeCandidates = pgTable(
  'contact_merge_candidates',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    /** The contact who gave the email/phone (usually an anonymous visitor). */
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    /** The contact that already has it. */
    existingContactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    field: text().$type<ContactField>().notNull(),
    /** Normalized: lower-case email, E.164 phone. */
    value: text().notNull(),
    status: text().$type<MergeCandidateStatus>().notNull().default('pending'),
    conversationId: uuid(),
    resolvedByUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index('contact_merge_candidates_org_status_idx').on(t.organizationId, t.status, t.createdAt.desc()),
    index('contact_merge_candidates_contact_idx').on(t.contactId),
    index('contact_merge_candidates_existing_idx').on(t.existingContactId),
    uniqueIndex('contact_merge_candidates_pending_uq').on(t.contactId, t.field, t.value).where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Consent history, append-only: every grant, decline and withdrawal with what was shown and the proof.
 * A withdrawal is a new row with `granted = false`; the latest row per purpose is the answer.
 */
export const contactConsents = pgTable(
  'contact_consents',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    purpose: text().$type<ConsentPurpose>().notNull(),
    granted: boolean().notNull(),
    /** The exact wording the customer agreed or declined to. Null for a withdrawal in their own words. */
    text: text(),
    /** Short hash of `text`: records made against the same wording share it. */
    textVersion: text(),
    source: text().$type<ConsentSource>().notNull(),
    conversationId: uuid(),
    /** In a chat: the bot message that asked, and the customer message that answered. */
    requestMessageId: uuid(),
    evidenceMessageId: uuid(),
    /** Staff: why or how it was given ("agreed by phone on 5 October"). */
    note: text(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('contact_consents_contact_idx').on(t.contactId, t.purpose, t.createdAt.desc()),
    index('contact_consents_org_created_idx').on(t.organizationId, t.createdAt.desc()),
  ],
);

export type CustomFieldType = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'email' | 'phone' | 'url';

export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    label: text().notNull(),
    type: text().$type<CustomFieldType>().notNull().default('text'),
    options: text().array().notNull().default(sql`'{}'::text[]`),
    /** Tells the AI what this field means and when to fill it. */
    description: text().notNull().default(''),
    aiWritable: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('custom_field_defs_org_key_uq').on(t.organizationId, t.key)],
);

export const tags = pgTable(
  'tags',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    color: text().notNull().default('#64748b'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tags_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const contactTags = pgTable(
  'contact_tags',
  {
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid().notNull().references(() => tags.id, { onDelete: 'cascade' }),
    addedBy: text().$type<'ai' | 'user' | 'system'>().notNull().default('user'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] }), index('contact_tags_tag_idx').on(t.tagId)],
);

export const contactNotes = pgTable(
  'contact_notes',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    body: text().notNull(),
    source: text().$type<'ai' | 'user'>().notNull().default('user'),
    authorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('contact_notes_contact_idx').on(t.contactId, t.createdAt)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid().references(() => contacts.id, { onDelete: 'cascade' }),
    conversationId: uuid(),
    title: text().notNull(),
    description: text().notNull().default(''),
    dueAt: ts(),
    priority: text().$type<'low' | 'normal' | 'high'>().notNull().default('normal'),
    status: text().$type<'open' | 'done'>().notNull().default('open'),
    assigneeUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdBy: text().$type<'ai' | 'user'>().notNull().default('user'),
    completedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tasks_org_status_idx').on(t.organizationId, t.status, t.dueAt), index('tasks_contact_idx').on(t.contactId)],
);
