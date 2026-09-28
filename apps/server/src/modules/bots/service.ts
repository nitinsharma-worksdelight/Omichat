import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '../../db/client';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import { badRequest, notFound } from '../../lib/errors';
import { DEFAULT_LIFECYCLE_STAGES } from '../tenancy/bootstrap';
import { BotConfigSchema, EffortSchema, STANDARD_LEAD_FIELDS, validateBotConfig, type BotConfig, type Effort } from './config';

/**
 * A model id for the configured provider. Deliberately not tied to any vendor's naming: the provider
 * rejects unknown models when it is called. Null / omitted = use the server's LLM_MODEL.
 */
const ModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:/@-]+$/, 'must be a model id, e.g. the value used for LLM_MODEL');

export const BotCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  model: ModelSchema.nullable().optional(),
  effort: EffortSchema.nullable().optional(),
  maxOutputTokens: z.number().int().min(1024).max(64_000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  knowledgeBaseIds: z.array(z.string().uuid()).max(20).optional(),
});

export const BotUpdateSchema = BotCreateSchema.partial().extend({ isActive: z.boolean().optional() });

type BotRow = typeof schema.bots.$inferSelect;

export interface BotView {
  id: string;
  name: string;
  isActive: boolean;
  version: number;
  /** Override of the server's LLM_MODEL; null = follow the server configuration. */
  model: string | null;
  /** Override of the server's reasoning effort; null = follow the server configuration. */
  effort: Effort | null;
  maxOutputTokens: number;
  config: BotConfig;
  knowledgeBaseIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export class BotsService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(scope: Scope): Promise<BotView[]> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx.select().from(schema.bots).where(eq(schema.bots.organizationId, scope.orgId)).orderBy(asc(schema.bots.createdAt));
      const links = rows.length
        ? await tx
            .select()
            .from(schema.botKnowledgeBases)
            .where(inArray(schema.botKnowledgeBases.botId, rows.map((r) => r.id)))
        : [];
      return rows.map((r) => this.view(r, links.filter((l) => l.botId === r.id).map((l) => l.knowledgeBaseId)));
    });
  }

  async get(scope: Scope, id: string): Promise<BotView> {
    return inScope(this.tenantDb, scope, (tx) => this.load(tx, scope.orgId, id));
  }

  async load(tx: Db, orgId: string, id: string): Promise<BotView> {
    const [row] = await tx.select().from(schema.bots).where(and(eq(schema.bots.id, id), eq(schema.bots.organizationId, orgId)));
    if (!row) throw notFound('Bot');
    const links = await tx.select().from(schema.botKnowledgeBases).where(eq(schema.botKnowledgeBases.botId, id));
    return this.view(row, links.map((l) => l.knowledgeBaseId));
  }

  async create(scope: Scope, input: z.infer<typeof BotCreateSchema>): Promise<BotView> {
    const config = this.parseConfig(input.config ?? {});
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.checkReferences(tx, scope.orgId, config, input.knowledgeBaseIds ?? []);
      const [row] = await tx
        .insert(schema.bots)
        .values({
          organizationId: scope.orgId,
          name: input.name,
          model: input.model ?? null,
          effort: input.effort ?? null,
          maxOutputTokens: input.maxOutputTokens,
          config,
        })
        .returning();
      await this.setKnowledgeBases(tx, scope.orgId, row!.id, input.knowledgeBaseIds ?? []);
      return this.load(tx, scope.orgId, row!.id);
    });
  }

  /**
   * Config sections given in the update replace those sections wholesale; omitted sections are kept.
   * Every change bumps `version`, which AI runs record for auditability.
   */
  async update(scope: Scope, id: string, input: z.infer<typeof BotUpdateSchema>): Promise<BotView> {
    return inScope(this.tenantDb, scope, async (tx) => {
      const current = await this.load(tx, scope.orgId, id);
      const config = input.config ? this.parseConfig({ ...current.config, ...input.config }) : current.config;
      const kbIds = input.knowledgeBaseIds ?? current.knowledgeBaseIds;
      await this.checkReferences(tx, scope.orgId, config, kbIds);
      await tx
        .update(schema.bots)
        .set({
          name: input.name,
          isActive: input.isActive,
          model: input.model,
          effort: input.effort,
          maxOutputTokens: input.maxOutputTokens,
          config,
          version: current.version + 1,
        })
        .where(eq(schema.bots.id, id));
      if (input.knowledgeBaseIds) await this.setKnowledgeBases(tx, scope.orgId, id, input.knowledgeBaseIds);
      return this.load(tx, scope.orgId, id);
    });
  }

  async delete(scope: Scope, id: string): Promise<void> {
    await inScope(this.tenantDb, scope, async (tx) => {
      const deleted = await tx
        .delete(schema.bots)
        .where(and(eq(schema.bots.id, id), eq(schema.bots.organizationId, scope.orgId)))
        .returning({ id: schema.bots.id });
      if (!deleted.length) throw notFound('Bot');
    });
  }

  private parseConfig(raw: unknown): BotConfig {
    const parsed = BotConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(
        'Invalid bot configuration',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const problems = validateBotConfig(parsed.data);
    if (problems.length) throw badRequest('Invalid bot configuration', problems.map((message) => ({ path: 'config', message })));
    return parsed.data;
  }

  private async checkReferences(tx: Db, orgId: string, config: BotConfig, kbIds: string[]) {
    const problems: string[] = [];
    if (config.booking.calendarId) {
      const [cal] = await tx
        .select({ id: schema.calendars.id })
        .from(schema.calendars)
        .where(and(eq(schema.calendars.id, config.booking.calendarId), eq(schema.calendars.organizationId, orgId)));
      if (!cal) problems.push('booking.calendarId does not exist');
    }
    if (kbIds.length) {
      const found = await tx
        .select({ id: schema.knowledgeBases.id })
        .from(schema.knowledgeBases)
        .where(and(eq(schema.knowledgeBases.organizationId, orgId), inArray(schema.knowledgeBases.id, kbIds)));
      if (found.length !== new Set(kbIds).size) problems.push('knowledgeBaseIds contains an unknown knowledge base');
    }
    if (config.actions.workflowKeys.length) {
      const found = await tx
        .select({ key: schema.workflows.key })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.organizationId, orgId), inArray(schema.workflows.key, config.actions.workflowKeys)));
      const missing = config.actions.workflowKeys.filter((k) => !found.some((f) => f.key === k));
      if (missing.length) problems.push(`unknown workflow keys: ${missing.join(', ')}`);
    }
    const { lifecycleStages, owners, deals } = config.actions;
    if (lifecycleStages.length) {
      const [org] = await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
      const known = org?.settings.lifecycleStages ?? DEFAULT_LIFECYCLE_STAGES;
      const unknown = lifecycleStages.filter((s) => !known.includes(s));
      if (unknown.length) problems.push(`actions.lifecycleStages: not one of your lifecycle stages: ${unknown.join(', ')}`);
    }
    if (owners.length) {
      const members = await tx
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(and(eq(schema.memberships.organizationId, orgId), inArray(schema.memberships.userId, owners)));
      if (members.length !== new Set(owners).size) problems.push('actions.owners: every owner must be a member of your team');
    }
    if (deals.pipelineId) {
      const [pipeline] = await tx
        .select({ id: schema.pipelines.id })
        .from(schema.pipelines)
        .where(and(eq(schema.pipelines.id, deals.pipelineId), eq(schema.pipelines.organizationId, orgId)));
      if (!pipeline) problems.push('actions.deals.pipelineId does not exist');
    }
    const customKeys = [
      ...config.leadCapture.fields.map((f) => f.field).filter((f) => !(STANDARD_LEAD_FIELDS as readonly string[]).includes(f)),
      ...config.qualification.questions.map((q) => q.saveToCustomField).filter((k): k is string => Boolean(k)),
    ];
    if (customKeys.length) {
      const defs = await tx
        .select({ key: schema.customFieldDefs.key })
        .from(schema.customFieldDefs)
        .where(and(eq(schema.customFieldDefs.organizationId, orgId), inArray(schema.customFieldDefs.key, customKeys)));
      const missing = customKeys.filter((k) => !defs.some((d) => d.key === k));
      if (missing.length) problems.push(`unknown custom fields: ${[...new Set(missing)].join(', ')}`);
    }
    if (problems.length) throw badRequest('Invalid bot configuration', problems.map((message) => ({ path: 'config', message })));
  }

  private async setKnowledgeBases(tx: Db, orgId: string, botId: string, kbIds: string[]) {
    await tx.delete(schema.botKnowledgeBases).where(eq(schema.botKnowledgeBases.botId, botId));
    if (kbIds.length) {
      await tx
        .insert(schema.botKnowledgeBases)
        .values([...new Set(kbIds)].map((knowledgeBaseId) => ({ organizationId: orgId, botId, knowledgeBaseId })));
    }
  }

  private view(row: BotRow, knowledgeBaseIds: string[]): BotView {
    return {
      id: row.id,
      name: row.name,
      isActive: row.isActive,
      version: row.version,
      model: row.model,
      effort: row.effort,
      maxOutputTokens: row.maxOutputTokens,
      // Parse on read so rows written before a new config field existed get its default.
      config: BotConfigSchema.parse(row.config),
      knowledgeBaseIds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
