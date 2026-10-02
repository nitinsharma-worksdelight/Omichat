import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { rowsOf, schema, type Db } from '../../db/client';
import type {
  ChannelType,
  ConsentPurpose,
  ConsentSource,
  ConsentState,
  ContactFact,
  ContactField,
  CustomFieldType,
  FirstTouch,
  MergeCandidateStatus,
} from '../../db/schema';
import { assertContactInOrg, assertConversationInOrg } from '../../db/ownership';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { newId } from '../../lib/ids';
import { canonicalTimezone } from '../../lib/timezone';
import { queryBool } from '../../lib/validation';
import { recordEvent } from '../automation/events';
import { consentVersion, earlierTouch, normalizeTouch } from '../leads/attribution';
import { coerceCustomField, displayName, isPlaceholder, normalizeEmail, normalizePhone, phoneError, splitName } from '../leads/capture';

type ContactRow = typeof schema.contacts.$inferSelect;
type Actor = 'ai' | 'user' | 'contact' | 'system';

export interface ContactTag {
  id: string;
  name: string;
  color: string;
}

export type ContactDetail = ReturnType<typeof toContactView> & { tags: ContactTag[] };

export type ConsentView = ReturnType<typeof toConsentView>;

export function toConsentView(r: typeof schema.contactConsents.$inferSelect) {
  return {
    id: r.id,
    purpose: r.purpose,
    granted: r.granted,
    text: r.text,
    textVersion: r.textVersion,
    source: r.source,
    conversationId: r.conversationId,
    requestMessageId: r.requestMessageId,
    evidenceMessageId: r.evidenceMessageId,
    note: r.note,
    actorUserId: r.actorUserId,
    createdAt: r.createdAt,
  };
}

/** A fact's ID: its own, or for facts saved before they had one, a stable ID from its text and time. */
export function factId(fact: ContactFact): string {
  return fact.id ?? `f_${sha256(`${fact.createdAt}\n${fact.text}`).slice(0, 16)}`;
}

/** Memory keeps at most 50 facts; when trimming, the AI's oldest go before anything the team noted. */
export function trimMemory(facts: ContactFact[], max = 50): ContactFact[] {
  const out = [...facts];
  while (out.length > max) {
    const oldestAi = out.findIndex((f) => f.source !== 'user');
    out.splice(oldestAi === -1 ? 0 : oldestAi, 1);
  }
  return out;
}

export function toContactView(c: ContactRow) {
  return {
    id: c.id,
    name: displayName(c),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    company: c.company,
    sourceChannel: c.sourceChannel,
    lifecycleStage: c.lifecycleStage,
    leadScore: c.leadScore,
    leadTier: c.leadTier,
    qualificationStatus: c.qualificationStatus,
    qualification: c.qualification,
    customFields: c.customFields,
    memory: c.memory.map((f) => ({ ...f, id: factId(f) })),
    firstTouch: c.firstTouch ?? null,
    consent: c.consent,
    timezone: c.timezone,
    ownerUserId: c.ownerUserId,
    isTest: c.isTest,
    leadCapturedAt: c.leadCapturedAt,
    lastActivityAt: c.lastActivityAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export const ContactInputSchema = z.object({
  firstName: z.string().trim().max(100).nullable().optional(),
  lastName: z.string().trim().max(100).nullable().optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  lifecycleStage: z.string().trim().min(1).max(40).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  /** IANA name, e.g. America/Vancouver; used to show booking times in the customer's own time. */
  timezone: z.string().trim().max(64).nullable().optional(),
});

export const ContactListSchema = z.object({
  search: z.string().trim().max(200).optional(),
  lifecycleStage: z.string().max(40).optional(),
  leadTier: z.enum(['hot', 'warm', 'cold']).optional(),
  qualificationStatus: z.enum(['not_started', 'in_progress', 'qualified', 'disqualified']).optional(),
  tagId: z.string().uuid().optional(),
  utmSource: z.string().trim().min(1).max(200).optional(),
  utmMedium: z.string().trim().min(1).max(200).optional(),
  utmCampaign: z.string().trim().min(1).max(200).optional(),
  /** granted / declined (said no or withdrew) / none (never answered). */
  marketingConsent: z.enum(['granted', 'declined', 'none']).optional(),
  leadsOnly: queryBool.optional(),
  includeTest: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const CustomFieldDefSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'use lowercase letters, digits and underscores')
    // Keys can't be changed later (values, bots and webhooks refer to them), so they start out clean.
    .refine((k) => !/^_|_$|__/.test(k), "can't start or end with an underscore, or have two in a row"),
  label: z.string().trim().min(1).max(100),
  type: z.enum(['text', 'number', 'boolean', 'date', 'select', 'email', 'phone', 'url']).default('text'),
  options: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  description: z.string().max(500).default(''),
  aiWritable: z.boolean().default(true),
});

/** What the AI (or a form) captured in one go. Every key is optional. */
export interface CaptureInput {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  /** IANA name, e.g. America/Vancouver (the customer said where they are). */
  timezone?: string | null;
  customFields?: Record<string, unknown>;
}

const PLACEHOLDER_FIELDS = [
  ['name', 'name'],
  ['firstName', 'first name'],
  ['lastName', 'last name'],
  ['email', 'email'],
  ['phone', 'phone number'],
  ['company', 'company'],
] as const;

export interface CaptureOptions {
  /**
   * `verified`: the details come from an authenticated source (an integration using an API key), so an email or
   * phone that already belongs to another contact merges this contact into that one.
   * `unverified` (the default): the person typed them in a chat, where anyone can type someone else's email. A
   * conflicting email/phone is never merged or stored on this contact; it becomes a merge candidate for staff.
   */
  trust?: 'verified' | 'unverified';
  /** Where the details were given; kept on merge candidates for staff. */
  conversationId?: string | null;
}

export interface CaptureResult {
  contactId: string;
  changed: string[];
  /** Emails/phones that belong to another contact, kept as pending merge candidates instead of being saved. */
  claimed: ContactField[];
  errors: string[];
  /** Set when a verified email/phone belonged to an existing contact and this one was merged into it. */
  mergedIntoId?: string;
  leadCaptured: boolean;
}

export interface ContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isTest: boolean;
  createdAt: Date;
}

export interface MergeCandidateView {
  id: string;
  field: ContactField;
  value: string;
  status: MergeCandidateStatus;
  conversationId: string | null;
  createdAt: Date;
  /** The contact who gave the email/phone. */
  claimant: ContactSummary;
  /** The contact that already had it. */
  existing: ContactSummary;
}

const UNIQUE_VIOLATION = '23505';

/** Postgres error code, looking through driver wrappers (drizzle nests the driver error as `cause`). */
function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function summarize(c: ContactRow): ContactSummary {
  return { id: c.id, name: displayName(c), email: c.email, phone: c.phone, isTest: c.isTest, createdAt: c.createdAt };
}

export class ContactsService {
  constructor(private readonly tenantDb: TenantDb) {}

  // ---------- reads ----------

  async get(scope: Scope, contactId: string): Promise<ContactDetail> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const row = await this.row(tx, scope.orgId, contactId);
      return { ...toContactView(row), tags: await this.tagsFor(tx, contactId) };
    });
  }

  /**
   * The contact as the AI sees it in a conversation: their own record, plus any email/phone they gave that is
   * waiting for staff review because it belongs to another contact. Nothing from that other contact is included.
   */
  async getForConversation(scope: Scope, contactId: string): Promise<ContactDetail> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const row = await this.row(tx, scope.orgId, contactId);
      const mc = schema.contactMergeCandidates;
      const claims = await tx
        .select({ field: mc.field, value: mc.value })
        .from(mc)
        .where(and(eq(mc.organizationId, scope.orgId), eq(mc.contactId, row.id), eq(mc.status, 'pending')))
        .orderBy(desc(mc.createdAt));
      const claimed = (field: ContactField) => claims.find((c) => c.field === field)?.value ?? null;
      return {
        ...toContactView(row),
        email: row.email ?? claimed('email'),
        phone: row.phone ?? claimed('phone'),
        tags: await this.tagsFor(tx, row.id),
      };
    });
  }

  /** Follows merge links so a stale id (e.g. from an old conversation) resolves to the surviving contact. */
  async resolveId(tx: Db, orgId: string, contactId: string): Promise<string> {
    let id = contactId;
    for (let i = 0; i < 5; i++) {
      const [row] = await tx
        .select({ mergedIntoId: schema.contacts.mergedIntoId })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.organizationId, orgId)));
      if (!row) throw notFound('Contact');
      if (!row.mergedIntoId) return id;
      id = row.mergedIntoId;
    }
    return id;
  }

  async list(scope: Scope, filters: z.infer<typeof ContactListSchema>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const c = schema.contacts;
      const where: SQL[] = [eq(c.organizationId, scope.orgId), isNull(c.mergedIntoId)];
      if (!filters.includeTest) where.push(eq(c.isTest, false));
      if (filters.lifecycleStage) where.push(eq(c.lifecycleStage, filters.lifecycleStage));
      if (filters.leadTier) where.push(eq(c.leadTier, filters.leadTier));
      if (filters.qualificationStatus) where.push(eq(c.qualificationStatus, filters.qualificationStatus));
      if (filters.leadsOnly) {
        // A visitor whose email/phone is waiting for a duplicate review is a lead too.
        where.push(
          sql`(${c.email} is not null or ${c.phone} is not null or exists (select 1 from ${schema.contactMergeCandidates} mc where mc.contact_id = ${c.id} and mc.status = 'pending'))`,
        );
      }
      if (filters.tagId) {
        where.push(
          sql`exists (select 1 from ${schema.contactTags} ct where ct.contact_id = ${c.id} and ct.tag_id = ${filters.tagId})`,
        );
      }
      const touch = Object.fromEntries(
        Object.entries({ utmSource: filters.utmSource, utmMedium: filters.utmMedium, utmCampaign: filters.utmCampaign }).filter(([, v]) => v),
      );
      // Containment, so the GIN index on first_touch serves it.
      if (Object.keys(touch).length) where.push(sql`${c.firstTouch} @> ${JSON.stringify(touch)}::jsonb`);
      if (filters.marketingConsent === 'none') where.push(sql`(${c.consent} -> 'marketing') is null`);
      else if (filters.marketingConsent) {
        where.push(sql`(${c.consent} -> 'marketing' ->> 'granted') = ${filters.marketingConsent === 'granted' ? 'true' : 'false'}`);
      }
      if (filters.search) {
        const q = `%${filters.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        where.push(
          or(ilike(c.firstName, q), ilike(c.lastName, q), ilike(c.email, q), ilike(c.phone, q), ilike(c.company, q))!,
        );
      }
      const rows = await tx
        .select()
        .from(c)
        .where(and(...where))
        .orderBy(desc(sql`coalesce(${c.lastActivityAt}, ${c.createdAt})`))
        .limit(filters.limit)
        .offset(filters.offset);
      const [{ total } = { total: 0 }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(c)
        .where(and(...where));
      const tagMap = await this.tagsForMany(tx, rows.map((r) => r.id));
      const pendingMerge = await this.pendingMergeIds(tx, scope.orgId, rows.map((r) => r.id));
      return {
        items: rows.map((r) => ({ ...toContactView(r), tags: tagMap.get(r.id) ?? [], hasPendingMerge: pendingMerge.has(r.id) })),
        total,
      };
    });
  }

  // ---------- identity ----------

  /** Channel identity → contact; creates an anonymous contact on first contact. */
  async findOrCreateByIdentity(
    scope: Scope,
    input: { channel: ChannelType; externalId: string; isTest?: boolean },
  ): Promise<{ contactId: string; created: boolean }> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const found = await this.findByIdentity(tx, scope.orgId, input.channel, input.externalId);
      if (found) return { contactId: await this.resolveId(tx, scope.orgId, found), created: false };
      const [contact] = await tx
        .insert(schema.contacts)
        .values({ organizationId: scope.orgId, sourceChannel: input.channel, isTest: input.isTest ?? false, lastActivityAt: new Date() })
        .returning({ id: schema.contacts.id });
      const inserted = await tx
        .insert(schema.contactIdentities)
        .values({ organizationId: scope.orgId, contactId: contact!.id, channel: input.channel, externalId: input.externalId })
        .onConflictDoNothing()
        .returning({ id: schema.contactIdentities.id });
      if (!inserted.length) {
        // Lost a race with a concurrent first message from the same visitor: use the winner's contact.
        await tx.delete(schema.contacts).where(eq(schema.contacts.id, contact!.id));
        const winner = await this.findByIdentity(tx, scope.orgId, input.channel, input.externalId);
        return { contactId: winner!, created: false };
      }
      return { contactId: contact!.id, created: true };
    });
  }

  async findByIdentity(tx: Db, orgId: string, channel: ChannelType, externalId: string): Promise<string | null> {
    const [row] = await tx
      .select({ contactId: schema.contactIdentities.contactId })
      .from(schema.contactIdentities)
      .where(
        and(
          eq(schema.contactIdentities.organizationId, orgId),
          eq(schema.contactIdentities.channel, channel),
          eq(schema.contactIdentities.externalId, externalId),
        ),
      );
    return row?.contactId ?? null;
  }

  // ---------- where a lead came from ----------

  /** Stores the first touch the first time one is reported; later touches never overwrite it. */
  async recordFirstTouch(scope: Scope, contactId: string, touch: unknown): Promise<boolean> {
    const normalized = normalizeTouch(touch);
    if (!normalized) return false;
    return inScope(this.tenantDb, scope, async (tx) => {
      const updated = await tx
        .update(schema.contacts)
        .set({ firstTouch: normalized })
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, scope.orgId), isNull(schema.contacts.firstTouch)))
        .returning({ id: schema.contacts.id });
      return updated.length > 0;
    });
  }

  /** The UTM values in use, for the contacts list's source filters. */
  /** The visitor's timezone as their browser reports it: kept only when none is known yet. Invalid values are ignored. */
  async recordTimezone(scope: Scope, contactId: string, value: unknown): Promise<boolean> {
    const timezone = canonicalTimezone(value);
    if (!timezone) return false;
    return inScope(this.tenantDb, scope, async (tx) => {
      const id = await this.resolveId(tx, scope.orgId, contactId);
      const rows = await tx
        .update(schema.contacts)
        .set({ timezone })
        .where(and(eq(schema.contacts.id, id), eq(schema.contacts.organizationId, scope.orgId), isNull(schema.contacts.timezone)))
        .returning({ id: schema.contacts.id });
      return rows.length > 0;
    });
  }

  async sourceOptions(scope: Scope): Promise<{ utmSource: string[]; utmMedium: string[]; utmCampaign: string[] }> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const c = schema.contacts;
      const values = async (key: 'utmSource' | 'utmMedium' | 'utmCampaign') =>
        rowsOf<{ v: string }>(
          await tx.execute(sql`
            select distinct ${c.firstTouch} ->> ${key} as v from ${c}
            where ${c.organizationId} = ${scope.orgId} and ${c.mergedIntoId} is null and ${c.firstTouch} ->> ${key} is not null
            order by 1 limit 200`),
        ).map((r) => r.v);
      return { utmSource: await values('utmSource'), utmMedium: await values('utmMedium'), utmCampaign: await values('utmCampaign') };
    });
  }

  // ---------- consent ----------

  /**
   * Appends a consent record (grant, decline or withdrawal) and makes it the contact's current answer for
   * that purpose. Records are never edited: a change of mind is a new record.
   */
  async recordConsent(
    scope: Scope,
    contactId: string,
    input: {
      purpose: ConsentPurpose;
      granted: boolean;
      /** The exact wording shown; required for a grant, except in a chat, where it comes from the posted question. */
      text?: string | null;
      source: ConsentSource;
      conversationId?: string | null;
      requestMessageId?: string | null;
      evidenceMessageId?: string | null;
      note?: string | null;
      actorUserId?: string | null;
    },
  ): Promise<ConsentView> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const id = await this.resolveId(tx, scope.orgId, contactId);
      const current = await this.row(tx, scope.orgId, id);
      const text = input.text?.trim() || null;
      const [row] = await tx
        .insert(schema.contactConsents)
        .values({
          organizationId: scope.orgId,
          contactId: id,
          purpose: input.purpose,
          granted: input.granted,
          text,
          textVersion: text ? consentVersion(text) : null,
          source: input.source,
          conversationId: input.conversationId ?? null,
          requestMessageId: input.requestMessageId ?? null,
          evidenceMessageId: input.evidenceMessageId ?? null,
          note: input.note?.trim() || null,
          actorUserId: input.actorUserId ?? null,
        })
        .returning();
      const state: ConsentState = { granted: row!.granted, at: row!.createdAt.toISOString(), source: row!.source, textVersion: row!.textVersion };
      await tx
        .update(schema.contacts)
        .set({ consent: { ...current.consent, [input.purpose]: state } })
        .where(eq(schema.contacts.id, id));
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'contact.consent_updated',
        actor: input.source === 'staff' ? 'user' : input.source === 'chat' ? 'ai' : 'system',
        actorUserId: input.actorUserId ?? null,
        contactId: id,
        conversationId: input.conversationId ?? null,
        payload: { purpose: input.purpose, granted: row!.granted, source: row!.source, textVersion: row!.textVersion },
      });
      return toConsentView(row!);
    });
  }

  /** The contact's consent history, newest first. */
  async listConsents(scope: Scope, contactId: string): Promise<ConsentView[]> {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.row(tx, scope.orgId, contactId);
      const k = schema.contactConsents;
      const rows = await tx
        .select()
        .from(k)
        .where(and(eq(k.organizationId, scope.orgId), eq(k.contactId, contactId)))
        .orderBy(desc(k.createdAt), desc(k.id));
      return rows.map(toConsentView);
    });
  }

  /**
   * In a conversation: the latest consent question the bot posted for this purpose, the customer's answer
   * (their latest message after it), and their latest message at all.
   */
  async consentQuestion(scope: Scope, conversationId: string, purpose: ConsentPurpose) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const m = schema.messages;
      const inConversation = and(eq(m.organizationId, scope.orgId), eq(m.conversationId, conversationId));
      const [request] = await tx
        .select({ id: m.id, content: m.content, createdAt: m.createdAt })
        .from(m)
        .where(and(inConversation, eq(m.direction, 'outbound'), sql`${m.metadata} -> 'consentRequest' ->> 'purpose' = ${purpose}`))
        .orderBy(desc(m.createdAt))
        .limit(1);
      const [latest] = await tx
        .select({ id: m.id, content: m.content, createdAt: m.createdAt })
        .from(m)
        .where(and(inConversation, eq(m.direction, 'inbound')))
        .orderBy(desc(m.createdAt))
        .limit(1);
      return {
        request: request ?? null,
        answer: request && latest && latest.createdAt > request.createdAt ? latest : null,
        latestInbound: latest ?? null,
      };
    });
  }

  // ---------- lead capture ----------

  /**
   * The lead-capture write path used by the AI and by forms. Validates and normalizes each field,
   * reports per-field errors instead of failing the whole call, and merges into an existing contact
   * when the email/phone already belongs to someone (returning visitor on a new device).
   */
  async captureDetails(scope: Scope, contactId: string, input: CaptureInput, actor: Actor, opts: CaptureOptions = {}): Promise<CaptureResult> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      const trust = opts.trust ?? 'unverified';
      let current = await this.row(tx, orgId, await this.resolveId(tx, orgId, contactId));
      const { defaultCountry } = await this.orgSettings(tx, orgId);
      const errors: string[] = [];
      const patch: Partial<ContactRow> = {};

      // Stand-ins such as "unknown" (a model copying its context, a form's "N/A") are never saved as details.
      input = { ...input };
      for (const [key, label] of PLACEHOLDER_FIELDS) {
        const value = input[key];
        if (typeof value === 'string' && isPlaceholder(value)) {
          errors.push(`"${value}" is a placeholder, not the customer's ${label}: save only details they actually gave`);
          delete input[key];
        }
      }

      if (input.name) {
        const { firstName, lastName } = splitName(input.name);
        patch.firstName = firstName;
        if (lastName) patch.lastName = lastName;
      }
      if (input.firstName) patch.firstName = input.firstName.trim().slice(0, 100);
      if (input.lastName) patch.lastName = input.lastName.trim().slice(0, 100);
      if (input.company) patch.company = input.company.trim().slice(0, 200);
      if (input.timezone) {
        const timezone = canonicalTimezone(input.timezone);
        if (timezone) patch.timezone = timezone;
        else errors.push(`"${input.timezone}" is not a timezone: use an IANA name such as America/Vancouver`);
      }
      if (input.email) {
        const email = normalizeEmail(input.email);
        if (email) patch.email = email;
        else errors.push(`"${input.email}" is not a valid email address`);
      }
      if (input.phone) {
        const phone = normalizePhone(input.phone, defaultCountry);
        if (phone) patch.phone = phone;
        else errors.push(phoneError(input.phone, defaultCountry));
      }

      let mergedIntoId: string | undefined;
      const claimed: ContactField[] = [];
      /** Keeps an email/phone that belongs to someone else for staff review instead of saving it here. */
      const claim = async (key: ContactField, ownerId: string, value: string) => {
        delete patch[key];
        claimed.push(key);
        await this.recordClaim(tx, orgId, { contactId: current.id, existingContactId: ownerId, field: key, value, conversationId: opts.conversationId }, actor);
      };
      const owned: Array<{ key: 'email' | 'phone'; ownerId: string; value: string }> = [];
      for (const key of ['email', 'phone'] as const) {
        const value = patch[key];
        if (!value || value === current[key]) continue;
        const owner = await this.findByField(tx, orgId, key, value, current.id);
        if (owner) owned.push({ key, ownerId: owner.id, value });
      }
      const owners = new Set(owned.map((o) => o.ownerId));
      if (trust === 'verified' && owners.size === 1) {
        // A verified detail identifies an existing person: fold this contact into theirs (once, even when the email
        // and the phone both belong to them).
        const [ownerId] = owners;
        await this.mergeInto(tx, orgId, ownerId!, current.id);
        mergedIntoId = ownerId;
        current = await this.row(tx, orgId, ownerId!);
      } else {
        // Typed in a chat, where anyone can type someone else's email: never link this visitor to that contact or show
        // them its data. Staff decide whether they are the same person. Verified details that belong to two different
        // people are reviewed too: merging into both would fold two unrelated contacts together.
        for (const { key, ownerId, value } of owned) await claim(key, ownerId, value);
      }

      if (input.customFields && Object.keys(input.customFields).length) {
        const { values, errors: fieldErrors } = await this.coerceCustomFields(tx, orgId, input.customFields, {
          aiOnly: actor === 'ai',
          defaultCountry,
        });
        errors.push(...fieldErrors);
        if (Object.keys(values).length) patch.customFields = { ...current.customFields, ...values };
      }

      const write = async () => {
        const changed = (Object.keys(patch) as Array<keyof ContactRow>).filter(
          (k) => JSON.stringify(patch[k]) !== JSON.stringify(current[k]),
        );
        const next = { ...current, ...patch };
        const becameLead = !current.leadCapturedAt && Boolean(next.firstName) && Boolean(next.email || next.phone);
        if (changed.length || becameLead) {
          // A savepoint, so a clash with a concurrent capture can be handled below instead of aborting everything.
          await tx.transaction(async (sp) => {
            await sp
              .update(schema.contacts)
              .set({
                ...Object.fromEntries(changed.map((k) => [k, patch[k]])),
                ...(becameLead ? { leadCapturedAt: new Date(), lifecycleStage: current.lifecycleStage === 'new' ? 'engaged' : current.lifecycleStage } : {}),
                lastActivityAt: new Date(),
              })
              .where(eq(schema.contacts.id, current.id));
          });
        }
        return { changed, next, becameLead };
      };
      let written: Awaited<ReturnType<typeof write>>;
      try {
        written = await write();
      } catch (err) {
        if (pgCode(err) !== UNIQUE_VIOLATION) throw err;
        // Another contact took this email/phone between the check above and the write (a concurrent capture).
        // Rare enough that it becomes a staff review whatever the trust level.
        for (const key of ['email', 'phone'] as const) {
          const value = patch[key];
          if (!value || value === current[key]) continue;
          const owner = await this.findByField(tx, orgId, key, value, current.id);
          if (owner) await claim(key, owner.id, value);
        }
        written = await write();
      }
      const { changed, next, becameLead } = written;
      if (changed.length) {
        await recordEvent(tx, {
          orgId,
          type: 'contact.updated',
          actor,
          contactId: current.id,
          payload: { changed, source: 'capture' },
        });
      }
      if (becameLead) {
        await recordEvent(tx, {
          orgId,
          type: 'lead.captured',
          actor,
          contactId: current.id,
          payload: { name: displayName(next), email: next.email, phone: next.phone, company: next.company, sourceChannel: next.sourceChannel },
        });
      }
      return { contactId: current.id, changed: changed.map(String), claimed, errors, mergedIntoId, leadCaptured: becameLead };
    });
  }

  /** Dashboard/API edit. Unlike capture, a clash with another contact's email/phone is an error, not a merge. */
  async update(scope: Scope, contactId: string, input: z.infer<typeof ContactInputSchema>, actorUserId?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      const current = await this.row(tx, orgId, contactId);
      const { defaultCountry } = await this.orgSettings(tx, orgId);
      const patch: Partial<ContactRow> = {};
      if (input.firstName !== undefined) patch.firstName = input.firstName || null;
      if (input.lastName !== undefined) patch.lastName = input.lastName || null;
      if (input.company !== undefined) patch.company = input.company || null;
      if (input.lifecycleStage !== undefined) patch.lifecycleStage = input.lifecycleStage;
      if (input.ownerUserId !== undefined) {
        if (input.ownerUserId) {
          const [member] = await tx
            .select({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, input.ownerUserId)));
          if (!member) throw badRequest('The owner must be a member of your team');
        }
        patch.ownerUserId = input.ownerUserId;
      }
      if (input.timezone !== undefined) {
        patch.timezone = input.timezone ? canonicalTimezone(input.timezone) : null;
        if (input.timezone && !patch.timezone) throw badRequest('Unknown timezone: use an IANA name such as America/Vancouver');
      }
      if (input.email !== undefined) {
        patch.email = input.email ? normalizeEmail(input.email) : null;
        if (input.email && !patch.email) throw badRequest('Invalid email address', [{ path: 'email', message: 'Enter a valid email address' }]);
      }
      if (input.phone !== undefined) {
        patch.phone = input.phone ? normalizePhone(input.phone, defaultCountry) : null;
        if (input.phone && !patch.phone) throw badRequest('Invalid phone number', [{ path: 'phone', message: 'Enter a valid phone number, with the country code if it is from another country' }]);
      }
      for (const key of ['email', 'phone'] as const) {
        const value = patch[key];
        if (value && value !== current[key] && (await this.findByField(tx, orgId, key, value, contactId))) {
          throw conflict(`Another contact already has this ${key}`);
        }
      }
      if (input.customFields) {
        const { values, errors } = await this.coerceCustomFields(tx, orgId, input.customFields, { aiOnly: false, defaultCountry });
        if (errors.length) throw badRequest('Invalid custom fields', errors);
        patch.customFields = { ...current.customFields, ...values };
      }
      if (Object.keys(patch).length === 0) return { ...toContactView(current), tags: await this.tagsFor(tx, contactId) };
      const [row] = await tx.update(schema.contacts).set(patch).where(eq(schema.contacts.id, contactId)).returning();
      await recordEvent(tx, {
        orgId,
        type: 'contact.updated',
        actor: 'user',
        actorUserId,
        contactId,
        payload: { changed: Object.keys(patch), source: 'dashboard' },
      });
      return { ...toContactView(row!), tags: await this.tagsFor(tx, contactId) };
    });
  }

  /** A contact created by staff (`actorUserId`) has no source channel; one created with an API key has `api`. */
  async create(scope: Scope, input: z.infer<typeof ContactInputSchema>, actorUserId?: string, opts: { source?: unknown } = {}) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .insert(schema.contacts)
        .values({
          organizationId: scope.orgId,
          sourceChannel: actorUserId ? null : 'api',
          firstTouch: normalizeTouch(opts.source),
          lastActivityAt: new Date(),
        })
        .returning({ id: schema.contacts.id });
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.created', actor: 'user', actorUserId, contactId: row!.id });
      return this.update({ orgId: scope.orgId, tx }, row!.id, input, actorUserId);
    });
  }

  async delete(scope: Scope, contactId: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const result = await tx
        .delete(schema.contacts)
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, scope.orgId)))
        .returning({ id: schema.contacts.id });
      if (!result.length) throw notFound('Contact');
      // Merged-away duplicates hold the same person's history.
      await tx.delete(schema.contacts).where(eq(schema.contacts.mergedIntoId, contactId));
    });
  }

  /** The assistant making a team member the contact's owner (a member of the organization, checked here). */
  async setOwner(scope: Scope, contactId: string, ownerUserId: string, actor: Actor, conversationId?: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const [member] = await tx
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, scope.orgId), eq(schema.memberships.userId, ownerUserId)));
      if (!member) throw badRequest('The owner must be a member of your team');
      await tx
        .update(schema.contacts)
        .set({ ownerUserId })
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, scope.orgId)));
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.updated', actor, contactId, conversationId, payload: { changed: ['ownerUserId'], ownerUserId } });
    });
  }

  async setLifecycleStage(scope: Scope, contactId: string, stage: string, actor: Actor, conversationId?: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      await tx
        .update(schema.contacts)
        .set({ lifecycleStage: stage })
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, scope.orgId)));
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'contact.updated',
        actor,
        contactId,
        conversationId,
        payload: { changed: ['lifecycleStage'], lifecycleStage: stage },
      });
    });
  }

  async touch(scope: Scope, contactId: string) {
    await inScope(this.tenantDb, scope, (tx) =>
      tx.update(schema.contacts).set({ lastActivityAt: new Date() }).where(eq(schema.contacts.id, contactId)),
    );
  }

  // ---------- merge ----------

  /** Folds `duplicateId` into `primaryId`. The duplicate row stays (mergedIntoId) for audit. */
  async mergeInto(
    tx: Db,
    orgId: string,
    primaryId: string,
    duplicateId: string,
    opts: { actor?: Actor; actorUserId?: string } = {},
  ): Promise<void> {
    if (primaryId === duplicateId) return;
    const primary = await this.row(tx, orgId, primaryId);
    const dup = await this.row(tx, orgId, duplicateId);

    // Retire the duplicate first so the partial unique indexes on email/phone stop covering it.
    await tx.update(schema.contacts).set({ mergedIntoId: primaryId }).where(eq(schema.contacts.id, duplicateId));

    // One open conversation per contact and channel account: close the primary's older one where both have one.
    const dupOpen = await tx
      .select({ channelAccountId: schema.conversations.channelAccountId })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.contactId, duplicateId), ne(schema.conversations.status, 'closed')));
    if (dupOpen.length) {
      await tx
        .update(schema.conversations)
        .set({ status: 'closed' })
        .where(
          and(
            eq(schema.conversations.contactId, primaryId),
            ne(schema.conversations.status, 'closed'),
            inArray(schema.conversations.channelAccountId, dupOpen.map((c) => c.channelAccountId)),
          ),
        );
    }
    const move = { contactId: primaryId };
    await tx.update(schema.contactIdentities).set(move).where(eq(schema.contactIdentities.contactId, duplicateId));
    await tx.update(schema.conversations).set(move).where(eq(schema.conversations.contactId, duplicateId));
    await tx.update(schema.appointments).set(move).where(eq(schema.appointments.contactId, duplicateId));
    await tx.update(schema.contactNotes).set(move).where(eq(schema.contactNotes.contactId, duplicateId));
    await tx.update(schema.tasks).set(move).where(eq(schema.tasks.contactId, duplicateId));
    await tx.update(schema.deals).set(move).where(eq(schema.deals.contactId, duplicateId));
    await tx.update(schema.events).set(move).where(eq(schema.events.contactId, duplicateId));
    await tx.update(schema.contactConsents).set(move).where(eq(schema.contactConsents.contactId, duplicateId));
    await tx.execute(sql`
      insert into contact_tags (organization_id, contact_id, tag_id, added_by, created_at)
      select organization_id, ${primaryId}, tag_id, added_by, created_at from contact_tags where contact_id = ${duplicateId}
      on conflict do nothing`);
    await tx.delete(schema.contactTags).where(eq(schema.contactTags.contactId, duplicateId));

    const dupHasQualification = dup.qualificationStatus !== 'not_started';
    await tx
      .update(schema.contacts)
      .set({
        firstName: primary.firstName ?? dup.firstName,
        lastName: primary.lastName ?? dup.lastName,
        email: primary.email ?? dup.email,
        phone: primary.phone ?? dup.phone,
        company: primary.company ?? dup.company,
        customFields: { ...primary.customFields, ...dup.customFields },
        qualification: { ...primary.qualification, ...dup.qualification },
        qualificationStatus: dupHasQualification ? dup.qualificationStatus : primary.qualificationStatus,
        leadScore: dupHasQualification ? dup.leadScore : primary.leadScore,
        leadTier: dupHasQualification ? dup.leadTier : primary.leadTier,
        memory: trimMemory([...primary.memory, ...dup.memory]),
        sourceChannel: primary.sourceChannel ?? dup.sourceChannel,
        // Where the person first came from is the earlier of the two visits; for consent, the latest answer stands.
        firstTouch: earlierTouch(primary.firstTouch, dup.firstTouch),
        consent: latestConsent(primary.consent, dup.consent),
        leadCapturedAt: primary.leadCapturedAt ?? dup.leadCapturedAt,
        isTest: primary.isTest && dup.isTest,
        lastActivityAt: new Date(),
      })
      .where(eq(schema.contacts.id, primaryId));
    // Duplicate reviews follow the person; a review between these two contacts is settled by this merge.
    const mc = schema.contactMergeCandidates;
    await tx
      .update(mc)
      .set({ status: 'merged', resolvedAt: new Date(), resolvedByUserId: opts.actorUserId ?? null })
      .where(
        and(
          eq(mc.status, 'pending'),
          or(
            and(eq(mc.contactId, duplicateId), eq(mc.existingContactId, primaryId)),
            and(eq(mc.contactId, primaryId), eq(mc.existingContactId, duplicateId)),
          ),
        ),
      );
    // Drop the duplicate's reviews that the primary already has, so moving the rest can't clash.
    await tx.execute(sql`
      delete from ${mc} d
      where d.contact_id = ${duplicateId} and d.status = 'pending'
        and exists (select 1 from ${mc} p where p.contact_id = ${primaryId} and p.status = 'pending' and p.field = d.field and p.value = d.value)`);
    await tx.update(mc).set({ contactId: primaryId }).where(and(eq(mc.contactId, duplicateId), eq(mc.status, 'pending')));
    await tx.update(mc).set({ existingContactId: primaryId }).where(and(eq(mc.existingContactId, duplicateId), eq(mc.status, 'pending')));

    await recordEvent(tx, {
      orgId,
      type: 'contact.merged',
      actor: opts.actor ?? 'system',
      actorUserId: opts.actorUserId,
      contactId: primaryId,
      payload: { mergedContactId: duplicateId },
    });
  }

  // ---------- duplicate reviews ----------

  /** Stores an email/phone that belongs to another contact for staff review. Announced once per claim. */
  private async recordClaim(
    tx: Db,
    orgId: string,
    claim: { contactId: string; existingContactId: string; field: ContactField; value: string; conversationId?: string | null },
    actor: Actor,
  ): Promise<void> {
    const [row] = await tx
      .insert(schema.contactMergeCandidates)
      .values({
        organizationId: orgId,
        contactId: claim.contactId,
        existingContactId: claim.existingContactId,
        field: claim.field,
        value: claim.value,
        conversationId: claim.conversationId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.contactMergeCandidates.id });
    if (!row) return; // Same claim already waiting for review.
    await recordEvent(tx, {
      orgId,
      type: 'contact.duplicate_detected',
      actor,
      contactId: claim.contactId,
      conversationId: claim.conversationId,
      payload: { candidateId: row.id, existingContactId: claim.existingContactId, field: claim.field, value: claim.value },
    });
  }

  /** Pending reviews involving this contact, in either direction, with both contacts summarized. */
  async listMergeCandidates(scope: Scope, contactId: string): Promise<MergeCandidateView[]> {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.row(tx, scope.orgId, contactId);
      const mc = schema.contactMergeCandidates;
      const rows = await tx
        .select()
        .from(mc)
        .where(and(eq(mc.organizationId, scope.orgId), eq(mc.status, 'pending'), or(eq(mc.contactId, contactId), eq(mc.existingContactId, contactId))))
        .orderBy(desc(mc.createdAt));
      if (!rows.length) return [];
      const people = await tx
        .select()
        .from(schema.contacts)
        .where(and(eq(schema.contacts.organizationId, scope.orgId), inArray(schema.contacts.id, [...new Set(rows.flatMap((r) => [r.contactId, r.existingContactId]))])));
      const byId = new Map(people.map((p) => [p.id, summarize(p)]));
      return rows.map((r) => ({
        id: r.id,
        field: r.field,
        value: r.value,
        status: r.status,
        conversationId: r.conversationId,
        createdAt: r.createdAt,
        claimant: byId.get(r.contactId)!,
        existing: byId.get(r.existingContactId)!,
      }));
    });
  }

  /** Staff merge: folds `duplicateId` into `primaryId` and settles any duplicate reviews between them. */
  async mergeContacts(scope: Scope, input: { duplicateId: string; primaryId: string }, actorUserId?: string): Promise<ContactDetail> {
    if (input.duplicateId === input.primaryId) throw badRequest('A contact cannot be merged into itself');
    return inScope(this.tenantDb, scope, async (tx) => {
      const duplicate = await this.row(tx, scope.orgId, input.duplicateId);
      const primary = await this.row(tx, scope.orgId, input.primaryId);
      if (duplicate.mergedIntoId || primary.mergedIntoId) throw conflict('One of these contacts was already merged into another');
      if (duplicate.isTest !== primary.isTest) throw badRequest('Test contacts cannot be merged with real contacts');
      await this.mergeInto(tx, scope.orgId, primary.id, duplicate.id, { actor: 'user', actorUserId });
      return { ...toContactView(await this.row(tx, scope.orgId, primary.id)), tags: await this.tagsFor(tx, primary.id) };
    });
  }

  /** "Not the same person": closes the review. The claimed email/phone stops counting as the visitor's own. */
  async dismissMergeCandidate(scope: Scope, candidateId: string, actorUserId?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const mc = schema.contactMergeCandidates;
      const [row] = await tx
        .update(mc)
        .set({ status: 'dismissed', resolvedAt: new Date(), resolvedByUserId: actorUserId ?? null })
        .where(and(eq(mc.id, candidateId), eq(mc.organizationId, scope.orgId), eq(mc.status, 'pending')))
        .returning();
      if (!row) throw notFound('Pending duplicate review');
      return row;
    });
  }

  private async pendingMergeIds(tx: Db, orgId: string, contactIds: string[]): Promise<Set<string>> {
    if (!contactIds.length) return new Set();
    const mc = schema.contactMergeCandidates;
    const rows = await tx
      .select({ contactId: mc.contactId, existingContactId: mc.existingContactId })
      .from(mc)
      .where(and(eq(mc.organizationId, orgId), eq(mc.status, 'pending'), or(inArray(mc.contactId, contactIds), inArray(mc.existingContactId, contactIds))));
    return new Set(rows.flatMap((r) => [r.contactId, r.existingContactId]));
  }

  // ---------- tags ----------

  async listTags(scope: Scope) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx.select().from(schema.tags).where(eq(schema.tags.organizationId, scope.orgId)).orderBy(asc(schema.tags.name)),
    );
  }

  async createTag(scope: Scope, input: { name: string; color?: string }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const existing = await this.tagByName(tx, scope.orgId, input.name);
      if (existing) throw conflict('Tag already exists');
      const [row] = await tx
        .insert(schema.tags)
        .values({ organizationId: scope.orgId, name: input.name.trim(), color: input.color ?? '#64748b' })
        .returning();
      return row!;
    });
  }

  async deleteTag(scope: Scope, tagId: string) {
    await inScope(this.tenantDb, scope, (tx) =>
      tx.delete(schema.tags).where(and(eq(schema.tags.id, tagId), eq(schema.tags.organizationId, scope.orgId))),
    );
  }

  /**
   * Applies tags by name. `allowed` (non-empty) restricts which tags may be applied;
   * `allowCreate` lets unknown names be created on the fly.
   */
  async addTags(
    scope: Scope,
    contactId: string,
    names: string[],
    opts: { addedBy: 'ai' | 'user' | 'system'; allowCreate: boolean; allowed?: string[] },
  ): Promise<{ added: string[]; skipped: string[] }> {
    return inScope(this.tenantDb, scope, async (tx) => {
      await assertContactInOrg(tx, scope.orgId, contactId);
      const added: string[] = [];
      const skipped: string[] = [];
      const allowed = (opts.allowed ?? []).map((a) => a.toLowerCase());
      for (const raw of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
        if (allowed.length && !allowed.includes(raw.toLowerCase())) {
          skipped.push(`${raw} (not an allowed tag)`);
          continue;
        }
        let tag = await this.tagByName(tx, scope.orgId, raw);
        if (!tag) {
          if (!opts.allowCreate) {
            skipped.push(`${raw} (tag does not exist)`);
            continue;
          }
          const [created] = await tx.insert(schema.tags).values({ organizationId: scope.orgId, name: raw.slice(0, 60) }).returning();
          tag = created!;
        }
        const inserted = await tx
          .insert(schema.contactTags)
          .values({ organizationId: scope.orgId, contactId, tagId: tag!.id, addedBy: opts.addedBy })
          .onConflictDoNothing()
          .returning({ tagId: schema.contactTags.tagId });
        if (inserted.length) added.push(tag!.name);
      }
      if (added.length) {
        await recordEvent(tx, { orgId: scope.orgId, type: 'contact.tagged', actor: opts.addedBy, contactId, payload: { tags: added } });
      }
      return { added, skipped };
    });
  }

  async removeTag(scope: Scope, contactId: string, tagId: string, actorUserId?: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const removed = await tx
        .delete(schema.contactTags)
        .where(
          and(
            eq(schema.contactTags.contactId, contactId),
            eq(schema.contactTags.tagId, tagId),
            eq(schema.contactTags.organizationId, scope.orgId),
          ),
        )
        .returning({ tagId: schema.contactTags.tagId });
      if (!removed.length) return;
      const [tag] = await tx.select({ name: schema.tags.name }).from(schema.tags).where(eq(schema.tags.id, tagId));
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.untagged', actor: 'user', actorUserId, contactId, payload: { tags: [tag?.name ?? tagId] } });
    });
  }

  /**
   * The assistant removing tags by name: only `allowed` ones when the bot has a list, otherwise only tags the assistant
   * added itself (never the team's). Returns what went and why the rest stayed.
   */
  async removeTagsByName(scope: Scope, contactId: string, names: string[], opts: { allowed: string[]; actor: Actor; conversationId?: string }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const removed: string[] = [];
      const skipped: string[] = [];
      const allowed = opts.allowed.map((a) => a.toLowerCase());
      for (const raw of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
        if (allowed.length && !allowed.includes(raw.toLowerCase())) {
          skipped.push(`${raw} (not a tag you may remove)`);
          continue;
        }
        const [link] = await tx
          .select({ tagId: schema.contactTags.tagId, addedBy: schema.contactTags.addedBy, name: schema.tags.name })
          .from(schema.contactTags)
          .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
          .where(and(eq(schema.contactTags.contactId, contactId), eq(schema.contactTags.organizationId, scope.orgId), sql`lower(${schema.tags.name}) = ${raw.toLowerCase()}`));
        if (!link) {
          skipped.push(`${raw} (not on this customer)`);
          continue;
        }
        if (!allowed.length && link.addedBy !== 'ai') {
          skipped.push(`${link.name} (added by the team)`);
          continue;
        }
        await tx.delete(schema.contactTags).where(and(eq(schema.contactTags.contactId, contactId), eq(schema.contactTags.tagId, link.tagId)));
        removed.push(link.name);
      }
      if (removed.length) {
        await recordEvent(tx, { orgId: scope.orgId, type: 'contact.untagged', actor: opts.actor, contactId, conversationId: opts.conversationId, payload: { tags: removed } });
      }
      return { removed, skipped };
    });
  }

  // ---------- notes & memory ----------

  /**
   * AI notes double as long-term memory surfaced in future conversations. Staff notes stay internal unless
   * `shareWithAssistant` is set; then they're also remembered as a team fact.
   */
  async addNote(scope: Scope, contactId: string, body: string, source: 'ai' | 'user', authorUserId?: string, opts: { shareWithAssistant?: boolean } = {}) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await assertContactInOrg(tx, scope.orgId, contactId);
      const [row] = await tx
        .insert(schema.contactNotes)
        .values({ organizationId: scope.orgId, contactId, body: body.slice(0, 4000), source, authorUserId: authorUserId ?? null })
        .returning();
      if (source === 'ai' || opts.shareWithAssistant) await this.remember(tx, scope.orgId, contactId, body, source);
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.note_added', actor: source, actorUserId: authorUserId, contactId, payload: { noteId: row!.id } });
      return row!;
    });
  }

  /** Adds a fact to what the AI remembers about this contact, noted by the team. */
  async addFact(scope: Scope, contactId: string, text: string, actorUserId?: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const fact = await this.remember(tx, scope.orgId, contactId, text, 'user');
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.updated', actor: 'user', actorUserId, contactId, payload: { changed: ['memory'] } });
      return { ...fact, id: factId(fact) };
    });
  }

  /** Removes a wrong or outdated fact, whoever noted it. */
  async removeFact(scope: Scope, contactId: string, id: string, actorUserId?: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const current = await this.row(tx, scope.orgId, contactId);
      const memory = current.memory.filter((f) => factId(f) !== id);
      if (memory.length === current.memory.length) throw notFound('Fact');
      await tx.update(schema.contacts).set({ memory }).where(eq(schema.contacts.id, current.id));
      await recordEvent(tx, { orgId: scope.orgId, type: 'contact.updated', actor: 'user', actorUserId, contactId: current.id, payload: { changed: ['memory'] } });
    });
  }

  private async remember(tx: Db, orgId: string, contactId: string, text: string, source: ContactFact['source']): Promise<ContactFact> {
    const current = await this.row(tx, orgId, contactId);
    const fact: ContactFact = { id: newId(), text: text.trim().slice(0, 500), source, createdAt: new Date().toISOString() };
    await tx
      .update(schema.contacts)
      .set({ memory: trimMemory([...current.memory, fact]) })
      .where(eq(schema.contacts.id, current.id));
    return fact;
  }

  async listNotes(scope: Scope, contactId: string) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.contactNotes)
        .where(and(eq(schema.contactNotes.contactId, contactId), eq(schema.contactNotes.organizationId, scope.orgId)))
        .orderBy(desc(schema.contactNotes.createdAt))
        .limit(100),
    );
  }

  // ---------- tasks ----------

  async createTask(
    scope: Scope,
    input: {
      title: string;
      description?: string;
      contactId?: string | null;
      conversationId?: string | null;
      dueAt?: Date | null;
      priority?: 'low' | 'normal' | 'high';
      assigneeUserId?: string | null;
      createdBy: 'ai' | 'user';
    },
  ) {
    return inScope(this.tenantDb, scope, async (tx) => {
      if (input.contactId) await assertContactInOrg(tx, scope.orgId, input.contactId);
      if (input.conversationId) await assertConversationInOrg(tx, scope.orgId, input.conversationId);
      const [row] = await tx
        .insert(schema.tasks)
        .values({
          organizationId: scope.orgId,
          title: input.title.slice(0, 200),
          description: (input.description ?? '').slice(0, 4000),
          contactId: input.contactId ?? null,
          conversationId: input.conversationId ?? null,
          dueAt: input.dueAt ?? null,
          priority: input.priority ?? 'normal',
          assigneeUserId: input.assigneeUserId ?? null,
          createdBy: input.createdBy,
        })
        .returning();
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'task.created',
        actor: input.createdBy,
        contactId: input.contactId,
        conversationId: input.conversationId,
        payload: { taskId: row!.id, title: row!.title, priority: row!.priority, dueAt: row!.dueAt },
      });
      return row!;
    });
  }

  async listTasks(scope: Scope, filters: { status?: 'open' | 'done'; contactId?: string }) {
    return inScope(this.tenantDb, scope, (tx) => {
      const where: SQL[] = [eq(schema.tasks.organizationId, scope.orgId)];
      if (filters.status) where.push(eq(schema.tasks.status, filters.status));
      if (filters.contactId) where.push(eq(schema.tasks.contactId, filters.contactId));
      return tx
        .select()
        .from(schema.tasks)
        .where(and(...where))
        .orderBy(asc(schema.tasks.status), asc(sql`coalesce(${schema.tasks.dueAt}, 'infinity'::timestamptz)`))
        .limit(200);
    });
  }

  async updateTask(scope: Scope, taskId: string, input: { status?: 'open' | 'done'; title?: string; dueAt?: Date | null; assigneeUserId?: string | null }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(schema.tasks)
        .set({
          ...input,
          completedAt: input.status === 'done' ? new Date() : input.status === 'open' ? null : undefined,
        })
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.organizationId, scope.orgId)))
        .returning();
      if (!row) throw notFound('Task');
      return row;
    });
  }

  // ---------- custom fields ----------

  async listFieldDefs(scope: Scope) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.customFieldDefs)
        .where(eq(schema.customFieldDefs.organizationId, scope.orgId))
        .orderBy(asc(schema.customFieldDefs.createdAt)),
    );
  }

  async createFieldDef(scope: Scope, input: z.infer<typeof CustomFieldDefSchema>) {
    if (input.type === 'select' && input.options.length === 0) throw badRequest('Select fields need options');
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .insert(schema.customFieldDefs)
        .values({ organizationId: scope.orgId, ...input })
        .onConflictDoNothing()
        .returning();
      if (!row) throw conflict(`A field with key "${input.key}" already exists`);
      return row;
    });
  }

  async updateFieldDef(scope: Scope, id: string, input: Partial<Omit<z.infer<typeof CustomFieldDefSchema>, 'key'>>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(schema.customFieldDefs)
        .set(input)
        .where(and(eq(schema.customFieldDefs.id, id), eq(schema.customFieldDefs.organizationId, scope.orgId)))
        .returning();
      if (!row) throw notFound('Custom field');
      return row;
    });
  }

  async deleteFieldDef(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, (tx) =>
      tx
        .delete(schema.customFieldDefs)
        .where(and(eq(schema.customFieldDefs.id, id), eq(schema.customFieldDefs.organizationId, scope.orgId))),
    );
  }

  async coerceCustomFields(
    tx: Db,
    orgId: string,
    input: Record<string, unknown>,
    opts: { aiOnly: boolean; defaultCountry: string },
  ): Promise<{ values: Record<string, unknown>; errors: string[] }> {
    const defs = await tx.select().from(schema.customFieldDefs).where(eq(schema.customFieldDefs.organizationId, orgId));
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const values: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const [key, raw] of Object.entries(input)) {
      const def = byKey.get(key);
      if (!def) {
        errors.push(`Unknown custom field "${key}"`);
        continue;
      }
      if (opts.aiOnly && !def.aiWritable) {
        errors.push(`Custom field "${key}" can only be edited by staff`);
        continue;
      }
      const result = coerceCustomField({ type: def.type as CustomFieldType, options: def.options, label: def.label }, raw, opts.defaultCountry);
      if (result.ok) values[key] = result.value;
      else errors.push(result.error);
    }
    return { values, errors };
  }

  // ---------- internals ----------

  async row(tx: Db, orgId: string, contactId: string): Promise<ContactRow> {
    const [row] = await tx
      .select()
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, orgId)));
    if (!row) throw notFound('Contact');
    return row;
  }

  async orgSettings(tx: Db, orgId: string) {
    const [org] = await tx
      .select({ settings: schema.organizations.settings, timezone: schema.organizations.timezone })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    return { defaultCountry: org?.settings.defaultCountry ?? 'US', timezone: org?.timezone ?? 'UTC' };
  }

  private async findByField(tx: Db, orgId: string, field: 'email' | 'phone', value: string, excludeId: string) {
    const column = field === 'email' ? sql`lower(${schema.contacts.email})` : schema.contacts.phone;
    const [row] = await tx
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.organizationId, orgId),
          isNull(schema.contacts.mergedIntoId),
          ne(schema.contacts.id, excludeId),
          sql`${column} = ${value}`,
        ),
      );
    return row ?? null;
  }

  private async tagByName(tx: Db, orgId: string, name: string) {
    const [row] = await tx
      .select()
      .from(schema.tags)
      .where(and(eq(schema.tags.organizationId, orgId), sql`lower(${schema.tags.name}) = ${name.trim().toLowerCase()}`));
    return row ?? null;
  }

  async tagsFor(tx: Db, contactId: string): Promise<ContactTag[]> {
    return (await this.tagsForMany(tx, [contactId])).get(contactId) ?? [];
  }

  private async tagsForMany(tx: Db, contactIds: string[]): Promise<Map<string, ContactTag[]>> {
    const map = new Map<string, ContactTag[]>();
    if (!contactIds.length) return map;
    const rows = await tx
      .select({ contactId: schema.contactTags.contactId, id: schema.tags.id, name: schema.tags.name, color: schema.tags.color })
      .from(schema.contactTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
      .where(inArray(schema.contactTags.contactId, contactIds));
    for (const r of rows) {
      const list = map.get(r.contactId) ?? [];
      list.push({ id: r.id, name: r.name, color: r.color });
      map.set(r.contactId, list);
    }
    return map;
  }
}

/** Per purpose, the more recent of two consent answers. */
function latestConsent(
  a: Partial<Record<ConsentPurpose, ConsentState>>,
  b: Partial<Record<ConsentPurpose, ConsentState>>,
): Partial<Record<ConsentPurpose, ConsentState>> {
  const out = { ...a };
  for (const [purpose, state] of Object.entries(b) as Array<[ConsentPurpose, ConsentState]>) {
    const mine = out[purpose];
    if (!mine || state.at > mine.at) out[purpose] = state;
  }
  return out;
}

export type { FirstTouch };
