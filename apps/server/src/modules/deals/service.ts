import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { rowsOf, schema, type Db } from '../../db/client';
import type { DealSource } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { queryBool } from '../../lib/validation';
import { recordEvent, type NewEvent } from '../automation/events';
import { displayName } from '../leads/capture';

export const DEFAULT_PIPELINE = { name: 'Sales', stages: ['New', 'Qualified', 'Proposal', 'Negotiation'] } as const;
export const DEFAULT_CURRENCY = 'USD';

const StageName = z.string().trim().min(1).max(60);
/** Fits `numeric(14, 2)`: up to 999,999,999,999.99. */
const Money = z.number().nonnegative().max(999_999_999_999.99);
const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => DateTime.fromISO(d, { zone: 'utc' }).isValid, 'invalid date');

export const PipelineCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  stages: z.array(z.object({ name: StageName })).min(1).max(20),
});

export const PipelineUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** The full ordered list: existing stages by id (renamed or moved), new ones without; a stage left out is removed. */
  stages: z.array(z.object({ id: z.string().uuid().optional(), name: StageName })).min(1).max(20).optional(),
  /** Where the deals of a removed stage go: `{ removedStageId: keptStageId }`. */
  moveDealsTo: z.record(z.string().uuid(), z.string().uuid()).optional(),
});

export const DealCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  contactId: z.string().uuid(),
  /** Defaults to the first pipeline; `stageId` alone picks its pipeline. */
  pipelineId: z.string().uuid().optional(),
  /** Defaults to the pipeline's first stage. */
  stageId: z.string().uuid().optional(),
  value: Money.nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  expectedCloseOn: Day.nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
});

export const DealUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  value: Money.nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  expectedCloseOn: Day.nullable().optional(),
  /** Moving to another pipeline needs one of its stages. */
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  /** Won and lost record when; back to open clears it. */
  status: z.enum(['open', 'won', 'lost']).optional(),
  lostReason: z.string().trim().max(500).nullable().optional(),
});

export const DealListSchema = z.object({
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  contactId: z.string().uuid().optional(),
  ownerUserId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
  /** Test (playground) contacts' deals are left out unless asked for, or when listing one contact's deals. */
  includeTest: queryBool.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const DealSummarySchema = z.object({
  pipelineId: z.string().uuid(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  ownerUserId: z.string().uuid().optional(),
  includeTest: queryBool.optional(),
});

type DealRow = typeof schema.deals.$inferSelect;
type StageRow = typeof schema.pipelineStages.$inferSelect;
type ContactBits = { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
/** Who acted: a staff member, an integration's API key, or the assistant. */
export interface DealActor {
  userId?: string;
  source: DealSource;
}

export type DealView = ReturnType<typeof toDealView>;

function toDealView(r: DealRow, c: ContactBits | null) {
  return {
    id: r.id,
    title: r.title,
    contactId: r.contactId,
    contact: c ? { id: r.contactId, name: displayName(c), email: c.email, phone: c.phone } : null,
    pipelineId: r.pipelineId,
    stageId: r.stageId,
    value: r.value === null ? null : Number(r.value),
    currency: r.currency,
    status: r.status,
    lostReason: r.lostReason,
    ownerUserId: r.ownerUserId,
    expectedCloseOn: r.expectedCloseOn,
    conversationId: r.conversationId,
    createdBy: r.createdBy,
    closedAt: r.closedAt,
    stageChangedAt: r.stageChangedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The "Sales" pipeline every organization starts with (at sign-up; older ones on first use). */
export async function createDefaultPipeline(tx: Db, orgId: string) {
  const [pipeline] = await tx.insert(schema.pipelines).values({ organizationId: orgId, name: DEFAULT_PIPELINE.name, position: 0 }).returning();
  await tx
    .insert(schema.pipelineStages)
    .values(DEFAULT_PIPELINE.stages.map((name, position) => ({ organizationId: orgId, pipelineId: pipeline!.id, name, position })));
  return pipeline!;
}

/**
 * Deals (opportunities) and the pipelines they move through. Every change records an event, so webhooks and the
 * activity feed follow the deal: created, updated (which fields), stage changed, won, lost, deleted.
 */
export class DealsService {
  constructor(private readonly tenantDb: TenantDb) {}

  // ---------- pipelines ----------

  async listPipelines(scope: Scope) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.ensurePipeline(tx, scope.orgId);
      return this.pipelineViews(tx, scope.orgId);
    });
  }

  async createPipeline(scope: Scope, input: z.infer<typeof PipelineCreateSchema>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.ensurePipeline(tx, scope.orgId);
      const [{ next } = { next: 0 }] = await tx
        .select({ next: sql<number>`coalesce(max(${schema.pipelines.position}), -1)::int + 1` })
        .from(schema.pipelines)
        .where(eq(schema.pipelines.organizationId, scope.orgId));
      const [pipeline] = await tx.insert(schema.pipelines).values({ organizationId: scope.orgId, name: input.name, position: next }).returning();
      await tx
        .insert(schema.pipelineStages)
        .values(input.stages.map((s, position) => ({ organizationId: scope.orgId, pipelineId: pipeline!.id, name: s.name, position })));
      return (await this.pipelineViews(tx, scope.orgId)).find((p) => p.id === pipeline!.id)!;
    });
  }

  /** Rename, and rename, reorder, add or remove stages. A removed stage's deals move where `moveDealsTo` says. */
  async updatePipeline(scope: Scope, id: string, input: z.infer<typeof PipelineUpdateSchema>, actor: DealActor) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      const [pipeline] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.id, id), eq(schema.pipelines.organizationId, orgId)));
      if (!pipeline) throw notFound('Pipeline');
      if (input.name && input.name !== pipeline.name) await tx.update(schema.pipelines).set({ name: input.name }).where(eq(schema.pipelines.id, id));
      if (input.stages) {
        const current = await tx.select().from(schema.pipelineStages).where(eq(schema.pipelineStages.pipelineId, id));
        const byId = new Map(current.map((s) => [s.id, s]));
        const keptIds = input.stages.flatMap((s) => (s.id ? [s.id] : []));
        if (keptIds.some((sid) => !byId.has(sid))) throw badRequest('A listed stage is not in this pipeline');
        if (new Set(keptIds).size !== keptIds.length) throw badRequest('A stage is listed twice');
        const removed = current.filter((s) => !keptIds.includes(s.id));
        for (const stage of removed) {
          const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.deals).where(eq(schema.deals.stageId, stage.id));
          if (!n) continue;
          const target = input.moveDealsTo?.[stage.id];
          if (!target) throw conflict(`Stage "${stage.name}" has ${n} deal${n === 1 ? '' : 's'}: choose a stage to move ${n === 1 ? 'it' : 'them'} to`);
          if (!keptIds.includes(target)) throw badRequest(`Deals from "${stage.name}" can only move to a stage that stays in this pipeline`);
          const moved = await tx
            .update(schema.deals)
            .set({ stageId: target, stageChangedAt: new Date() })
            .where(eq(schema.deals.stageId, stage.id))
            .returning();
          for (const deal of moved) await this.recordStageChange(tx, orgId, deal, stage, byId.get(target)!, actor);
        }
        if (removed.length) await tx.delete(schema.pipelineStages).where(inArray(schema.pipelineStages.id, removed.map((s) => s.id)));
        for (const [position, s] of input.stages.entries()) {
          if (s.id) await tx.update(schema.pipelineStages).set({ name: s.name, position }).where(eq(schema.pipelineStages.id, s.id));
          else await tx.insert(schema.pipelineStages).values({ organizationId: orgId, pipelineId: id, name: s.name, position });
        }
      }
      return (await this.pipelineViews(tx, orgId)).find((p) => p.id === id)!;
    });
  }

  async deletePipeline(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const [pipeline] = await tx.select().from(schema.pipelines).where(and(eq(schema.pipelines.id, id), eq(schema.pipelines.organizationId, scope.orgId)));
      if (!pipeline) throw notFound('Pipeline');
      const [{ n: pipelines } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.pipelines).where(eq(schema.pipelines.organizationId, scope.orgId));
      if (pipelines <= 1) throw conflict('An organization needs at least one pipeline');
      const [{ n: deals } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.deals).where(eq(schema.deals.pipelineId, id));
      if (deals) throw conflict(`This pipeline has ${deals} deal${deals === 1 ? '' : 's'}: move or delete ${deals === 1 ? 'it' : 'them'} first`);
      await tx.delete(schema.pipelines).where(eq(schema.pipelines.id, id));
    });
  }

  /** Organizations from before deals existed get the default pipeline on first use; concurrent first uses make one. */
  private async ensurePipeline(tx: Db, orgId: string) {
    const exists = async () => (await tx.select({ id: schema.pipelines.id }).from(schema.pipelines).where(eq(schema.pipelines.organizationId, orgId)).limit(1)).length > 0;
    if (await exists()) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pipelines:${orgId}`}, 0))`);
    if (!(await exists())) await createDefaultPipeline(tx, orgId);
  }

  private async pipelineViews(tx: Db, orgId: string) {
    const pipelines = await tx
      .select()
      .from(schema.pipelines)
      .where(eq(schema.pipelines.organizationId, orgId))
      .orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt));
    const stages = pipelines.length
      ? await tx
          .select()
          .from(schema.pipelineStages)
          .where(inArray(schema.pipelineStages.pipelineId, pipelines.map((p) => p.id)))
          .orderBy(asc(schema.pipelineStages.position), asc(schema.pipelineStages.createdAt))
      : [];
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      stages: stages.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name, position: s.position })),
    }));
  }

  // ---------- deals ----------

  async list(scope: Scope, filters: z.infer<typeof DealListSchema>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const where = await this.filters(tx, scope.orgId, filters);
      const [{ total } = { total: 0 }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.deals)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.deals.contactId))
        .where(and(...where));
      const rows = await tx
        .select({ deal: schema.deals, contact: { firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, email: schema.contacts.email, phone: schema.contacts.phone } })
        .from(schema.deals)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.deals.contactId))
        .where(and(...where))
        .orderBy(desc(schema.deals.updatedAt), desc(schema.deals.id))
        .limit(filters.limit)
        .offset(filters.offset);
      return Object.assign(
        rows.map((r) => toDealView(r.deal, r.contact)),
        { total },
      );
    });
  }

  /** Per stage of a pipeline: how many deals, and their total value per currency (deals without a value count, not add). */
  async summary(scope: Scope, input: z.infer<typeof DealSummarySchema>) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const stages = await tx
        .select()
        .from(schema.pipelineStages)
        .where(and(eq(schema.pipelineStages.pipelineId, input.pipelineId), eq(schema.pipelineStages.organizationId, scope.orgId)))
        .orderBy(asc(schema.pipelineStages.position));
      if (!stages.length) throw notFound('Pipeline');
      const d = schema.deals;
      const rows = await tx
        .select({ stageId: d.stageId, currency: d.currency, n: sql<number>`count(*)::int`, valued: sql<number>`count(${d.value})::int`, total: sql<string | null>`sum(${d.value})` })
        .from(d)
        .innerJoin(schema.contacts, eq(schema.contacts.id, d.contactId))
        .where(
          and(
            eq(d.organizationId, scope.orgId),
            eq(d.pipelineId, input.pipelineId),
            input.status ? eq(d.status, input.status) : undefined,
            input.ownerUserId ? eq(d.ownerUserId, input.ownerUserId) : undefined,
            input.includeTest ? undefined : eq(schema.contacts.isTest, false),
          ),
        )
        .groupBy(d.stageId, d.currency);
      return stages.map((s) => {
        const mine = rows.filter((r) => r.stageId === s.id);
        return {
          stageId: s.id,
          count: mine.reduce((sum, r) => sum + r.n, 0),
          totals: mine.filter((r) => r.valued > 0).map((r) => ({ currency: r.currency, value: Number(r.total) })),
        };
      });
    });
  }

  async get(scope: Scope, id: string) {
    return inScope(this.tenantDb, scope, async (tx) => this.view(tx, await this.row(tx, scope.orgId, id)));
  }

  async create(scope: Scope, input: z.infer<typeof DealCreateSchema>, actor: DealActor) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      await this.ensurePipeline(tx, orgId);
      const contactId = await this.contactId(tx, orgId, input.contactId);
      let pipelineId = input.pipelineId;
      let stageId = input.stageId;
      if (stageId) {
        const stage = await this.stage(tx, orgId, stageId);
        if (pipelineId && stage.pipelineId !== pipelineId) throw badRequest('That stage belongs to another pipeline');
        pipelineId = stage.pipelineId;
      } else {
        if (!pipelineId) {
          const [first] = await tx
            .select({ id: schema.pipelines.id })
            .from(schema.pipelines)
            .where(eq(schema.pipelines.organizationId, orgId))
            .orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt))
            .limit(1);
          pipelineId = first!.id;
        }
        const [firstStage] = await tx
          .select({ id: schema.pipelineStages.id })
          .from(schema.pipelineStages)
          .where(and(eq(schema.pipelineStages.pipelineId, pipelineId), eq(schema.pipelineStages.organizationId, orgId)))
          .orderBy(asc(schema.pipelineStages.position))
          .limit(1);
        if (!firstStage) throw badRequest('Unknown pipeline');
        stageId = firstStage.id;
      }
      if (input.ownerUserId) await this.assertMember(tx, orgId, input.ownerUserId);
      if (input.conversationId) await this.assertConversation(tx, orgId, input.conversationId);
      await this.assertNoOpenDeal(tx, orgId, contactId, pipelineId!);
      const [org] = await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
      const [row] = await tx
        .insert(schema.deals)
        .values({
          organizationId: orgId,
          pipelineId,
          stageId,
          contactId,
          title: input.title,
          value: input.value === null || input.value === undefined ? null : input.value.toFixed(2),
          currency: org?.settings.currency ?? DEFAULT_CURRENCY,
          ownerUserId: input.ownerUserId ?? null,
          expectedCloseOn: input.expectedCloseOn ?? null,
          conversationId: input.conversationId ?? null,
          createdBy: actor.source,
        })
        .returning();
      await this.record(tx, orgId, 'deal.created', row!, actor, { deal: await this.snapshot(tx, row!) });
      return this.view(tx, row!);
    });
  }

  async update(scope: Scope, id: string, input: z.infer<typeof DealUpdateSchema>, actor: DealActor) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const orgId = scope.orgId;
      const deal = await this.row(tx, orgId, id);
      const patch: Partial<DealRow> = {};
      const changed: string[] = [];
      if (input.title !== undefined && input.title !== deal.title) {
        patch.title = input.title;
        changed.push('title');
      }
      if (input.value !== undefined) {
        const value = input.value === null ? null : input.value.toFixed(2);
        if (value !== deal.value) {
          patch.value = value;
          changed.push('value');
        }
      }
      if (input.ownerUserId !== undefined && input.ownerUserId !== deal.ownerUserId) {
        if (input.ownerUserId) await this.assertMember(tx, orgId, input.ownerUserId);
        patch.ownerUserId = input.ownerUserId;
        changed.push('owner');
      }
      if (input.expectedCloseOn !== undefined && input.expectedCloseOn !== deal.expectedCloseOn) {
        patch.expectedCloseOn = input.expectedCloseOn;
        changed.push('expectedCloseOn');
      }

      let stageChange: { from: StageRow; to: StageRow } | null = null;
      if (input.pipelineId !== undefined || input.stageId !== undefined) {
        const pipelineId = input.pipelineId ?? deal.pipelineId;
        if (pipelineId !== deal.pipelineId && !input.stageId) throw badRequest('Moving a deal to another pipeline needs one of its stages (stageId)');
        const to = await this.stage(tx, orgId, input.stageId ?? deal.stageId);
        if (to.pipelineId !== pipelineId) throw badRequest('That stage belongs to another pipeline');
        if (to.id !== deal.stageId) {
          stageChange = { from: await this.stage(tx, orgId, deal.stageId), to };
          patch.pipelineId = to.pipelineId;
          patch.stageId = to.id;
          patch.stageChangedAt = new Date();
        }
      }

      let closed: 'won' | 'lost' | null = null;
      if (input.status !== undefined && input.status !== deal.status) {
        patch.status = input.status;
        if (input.status === 'open') {
          patch.closedAt = null;
          patch.lostReason = null;
          changed.push('status');
        } else {
          patch.closedAt = new Date();
          patch.lostReason = input.status === 'lost' ? (input.lostReason ?? null) : null;
          closed = input.status;
        }
      } else if (input.lostReason !== undefined && deal.status === 'lost' && (input.lostReason ?? null) !== deal.lostReason) {
        patch.lostReason = input.lostReason ?? null;
        changed.push('lostReason');
      }

      if (!Object.keys(patch).length) return this.view(tx, deal);
      // Becoming open (reopened, or moved into another pipeline while open) must not make a second open deal.
      const finalStatus = patch.status ?? deal.status;
      if (finalStatus === 'open' && (patch.status === 'open' || (patch.pipelineId && patch.pipelineId !== deal.pipelineId))) {
        await this.assertNoOpenDeal(tx, orgId, deal.contactId, patch.pipelineId ?? deal.pipelineId, deal.id);
      }
      const [row] = await tx.update(schema.deals).set(patch).where(eq(schema.deals.id, deal.id)).returning();
      const snapshot = await this.snapshot(tx, row!);
      if (changed.length) await this.record(tx, orgId, 'deal.updated', row!, actor, { changed, deal: snapshot });
      if (stageChange) await this.recordStageChange(tx, orgId, row!, stageChange.from, stageChange.to, actor, snapshot);
      if (closed === 'won') await this.record(tx, orgId, 'deal.won', row!, actor, { deal: snapshot });
      if (closed === 'lost') await this.record(tx, orgId, 'deal.lost', row!, actor, { reason: row!.lostReason, deal: snapshot });
      return this.view(tx, row!);
    });
  }

  async delete(scope: Scope, id: string, actor: DealActor) {
    await inScope(this.tenantDb, scope, async (tx) => {
      const deal = await this.row(tx, scope.orgId, id);
      const snapshot = await this.snapshot(tx, deal);
      await tx.delete(schema.deals).where(eq(schema.deals.id, deal.id));
      await this.record(tx, scope.orgId, 'deal.deleted', deal, actor, { deal: snapshot });
    });
  }

  // ---------- helpers ----------

  private async filters(tx: Db, orgId: string, f: z.infer<typeof DealListSchema>): Promise<SQL[]> {
    const d = schema.deals;
    const where: SQL[] = [eq(d.organizationId, orgId)];
    if (f.pipelineId) where.push(eq(d.pipelineId, f.pipelineId));
    if (f.stageId) where.push(eq(d.stageId, f.stageId));
    if (f.status) where.push(eq(d.status, f.status));
    if (f.ownerUserId) where.push(eq(d.ownerUserId, f.ownerUserId));
    if (f.contactId) where.push(eq(d.contactId, await this.contactId(tx, orgId, f.contactId)));
    else if (!f.includeTest) where.push(eq(schema.contacts.isTest, false));
    if (f.search) {
      const q = `%${f.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      const c = schema.contacts;
      where.push(or(ilike(d.title, q), ilike(c.firstName, q), ilike(c.lastName, q), ilike(c.email, q))!);
    }
    return where;
  }

  /**
   * A contact has one open deal per pipeline. Their row is locked first, so two requests at once can't both pass.
   * The error names the deal in the way, so the dashboard can take staff to it.
   */
  private async assertNoOpenDeal(tx: Db, orgId: string, contactId: string, pipelineId: string, exceptDealId?: string) {
    await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organizationId, orgId))).for('update');
    const d = schema.deals;
    const [open] = await tx
      .select({ id: d.id })
      .from(d)
      .where(and(eq(d.organizationId, orgId), eq(d.contactId, contactId), eq(d.pipelineId, pipelineId), eq(d.status, 'open'), exceptDealId ? ne(d.id, exceptDealId) : undefined))
      .limit(1);
    if (open) {
      throw conflict('This contact already has an open deal in this pipeline', [
        { path: 'contactId', message: 'This contact already has an open deal in this pipeline' },
        { path: 'openDealId', message: open.id },
      ]);
    }
  }

  private async row(tx: Db, orgId: string, id: string): Promise<DealRow> {
    const [row] = await tx.select().from(schema.deals).where(and(eq(schema.deals.id, id), eq(schema.deals.organizationId, orgId)));
    if (!row) throw notFound('Deal');
    return row;
  }

  private async view(tx: Db, row: DealRow) {
    const [c] = await tx
      .select({ firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, email: schema.contacts.email, phone: schema.contacts.phone })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, row.contactId));
    return toDealView(row, c ?? null);
  }

  private async stage(tx: Db, orgId: string, id: string): Promise<StageRow> {
    const [stage] = await tx.select().from(schema.pipelineStages).where(and(eq(schema.pipelineStages.id, id), eq(schema.pipelineStages.organizationId, orgId)));
    if (!stage) throw badRequest('Unknown stage');
    return stage;
  }

  /** The contact's current id: a merged-away duplicate resolves to the contact it was merged into. */
  private async contactId(tx: Db, orgId: string, id: string): Promise<string> {
    let current = id;
    for (let i = 0; i < 5; i++) {
      const [row] = await tx
        .select({ mergedIntoId: schema.contacts.mergedIntoId })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, current), eq(schema.contacts.organizationId, orgId)));
      if (!row) throw notFound('Contact');
      if (!row.mergedIntoId) return current;
      current = row.mergedIntoId;
    }
    return current;
  }

  private async assertMember(tx: Db, orgId: string, userId: string) {
    const [m] = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)));
    if (!m) throw badRequest('The owner must be a member of your team');
  }

  private async assertConversation(tx: Db, orgId: string, id: string) {
    const [c] = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, id), eq(schema.conversations.organizationId, orgId)));
    if (!c) throw badRequest('Unknown conversation');
  }

  /** What webhooks and the activity feed see of a deal, with its pipeline and stage names. */
  private async snapshot(tx: Db, row: DealRow) {
    const [names] = rowsOf<{ pipeline: string; stage: string }>(
      await tx.execute(sql`select p.name as pipeline, s.name as stage from pipeline_stages s join pipelines p on p.id = s.pipeline_id where s.id = ${row.stageId}`),
    );
    return {
      id: row.id,
      title: row.title,
      value: row.value === null ? null : Number(row.value),
      currency: row.currency,
      status: row.status,
      pipelineId: row.pipelineId,
      pipeline: names?.pipeline ?? null,
      stageId: row.stageId,
      stage: names?.stage ?? null,
      ownerUserId: row.ownerUserId,
      expectedCloseOn: row.expectedCloseOn,
      lostReason: row.lostReason,
      closedAt: row.closedAt,
    };
  }

  private async recordStageChange(tx: Db, orgId: string, row: DealRow, from: StageRow, to: StageRow, actor: DealActor, snapshot?: Awaited<ReturnType<DealsService['snapshot']>>) {
    await this.record(tx, orgId, 'deal.stage_changed', row, actor, {
      from: { stageId: from.id, stage: from.name },
      to: { stageId: to.id, stage: to.name },
      deal: snapshot ?? (await this.snapshot(tx, row)),
    });
  }

  private async record(tx: Db, orgId: string, type: NewEvent['type'], row: DealRow, actor: DealActor, payload: Record<string, unknown>) {
    await recordEvent(tx, {
      orgId,
      type,
      actor: actor.source === 'ai' ? 'ai' : 'user',
      actorUserId: actor.userId ?? null,
      contactId: row.contactId,
      conversationId: row.conversationId,
      payload,
    });
  }
}
