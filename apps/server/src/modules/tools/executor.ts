import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../../db/client';
import type { TenantDb } from '../../db/tenant';
import { withTimeout } from '../../lib/async';
import type { Logger } from '../../lib/logger';
import type { BotView } from '../bots/service';
import { recordApprovalRequest } from '../approvals/service';
import { DEFAULT_LIFECYCLE_STAGES } from '../tenancy/bootstrap';
import { asksFirst, ownerChoices, type ToolContext, type ToolDefinition, type ToolOutcome, type ToolSchemaContext } from './types';

/** Provider-neutral tool spec; the LLM provider maps it to its own wire format. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolCallResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface PreparedTools {
  specs: ToolSpec[];
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolCallResult>;
}

/** One attempt at answering one customer message. Retries of a turn share the conversation and trigger message. */
export interface TurnInfo {
  conversationId: string;
  triggerMessageId: string;
  /** This attempt's AI run. */
  runId: string;
}

const TOOL_TIMEOUT_MS = 25_000;

/** What the model is told when an action waits for the team. */
const WAITING =
  "Nothing has happened yet: the team must approve this first. Tell the customer you've asked the team and a team member will confirm it. Say it is requested or pending: never say it is booked, scheduled, confirmed or done, not even before adding that the team will confirm.";

/** Calls that waited for the team replay per tool (and repeat key), in order, like repeat-keyed ones. */
const askSlot = (def: ToolDefinition, input: unknown) => `ask:${def.key}:${def.repeatKey ? def.repeatKey(input) : ''}`;

function toJsonSchema(s: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * The trust boundary between the model and the business. The model only ever *requests* a tool;
 * this validates the request against the tool's schema, runs it with server-side identity, and
 * writes an audit row for every call — including rejected ones.
 */
export class ToolExecutor {
  constructor(
    private readonly definitions: ToolDefinition[],
    private readonly tenantDb: TenantDb,
    private readonly logger: Logger,
    /** Called once a new approval request is saved, so the team hears at once instead of when the turn ends. */
    private readonly onApprovalRequested: () => Promise<void> = async () => {},
  ) {}

  async schemaContext(orgId: string, bot: BotView): Promise<ToolSchemaContext> {
    return this.tenantDb.run(orgId, async (tx) => {
      const customFields = await tx
        .select({
          key: schema.customFieldDefs.key,
          label: schema.customFieldDefs.label,
          type: schema.customFieldDefs.type,
          options: schema.customFieldDefs.options,
          description: schema.customFieldDefs.description,
          aiWritable: schema.customFieldDefs.aiWritable,
        })
        .from(schema.customFieldDefs)
        .where(eq(schema.customFieldDefs.organizationId, orgId))
        .orderBy(schema.customFieldDefs.key);
      const workflows = bot.config.actions.workflowKeys.length
        ? await tx
            .select({
              key: schema.workflows.key,
              name: schema.workflows.name,
              description: schema.workflows.description,
              inputFields: schema.workflows.inputFields,
              askFirst: schema.workflows.askFirst,
            })
            .from(schema.workflows)
            .where(
              and(
                eq(schema.workflows.organizationId, orgId),
                eq(schema.workflows.isActive, true),
                inArray(schema.workflows.key, bot.config.actions.workflowKeys),
              ),
            )
            .orderBy(schema.workflows.key)
        : [];
      const { owners: ownerIds, deals, lifecycleStages: stages } = bot.config.actions;
      // A stage the organization has since dropped is no longer offered.
      const [org] = stages.length
        ? await tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId))
        : [];
      const known = org?.settings.lifecycleStages ?? DEFAULT_LIFECYCLE_STAGES;
      const members = ownerIds.length
        ? await tx
            .select({ userId: schema.memberships.userId, name: schema.users.name, email: schema.users.email })
            .from(schema.memberships)
            .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
            .where(and(eq(schema.memberships.organizationId, orgId), inArray(schema.memberships.userId, ownerIds)))
        : [];
      let pipeline: ToolSchemaContext['pipeline'] = null;
      if (deals.enabled) {
        const [p] = await tx
          .select({ id: schema.pipelines.id, name: schema.pipelines.name })
          .from(schema.pipelines)
          .where(and(eq(schema.pipelines.organizationId, orgId), deals.pipelineId ? eq(schema.pipelines.id, deals.pipelineId) : undefined))
          .orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt))
          .limit(1);
        if (p) {
          const stages = await tx
            .select({ id: schema.pipelineStages.id, name: schema.pipelineStages.name })
            .from(schema.pipelineStages)
            .where(eq(schema.pipelineStages.pipelineId, p.id))
            .orderBy(asc(schema.pipelineStages.position));
          pipeline = { ...p, stages };
        }
      }
      return {
        bot,
        customFields,
        workflows,
        allowedTags: [...bot.config.actions.allowedTags].sort(),
        lifecycleStages: stages.filter((s) => known.includes(s)),
        owners: ownerChoices(members, ownerIds),
        pipeline,
      };
    });
  }

  /**
   * Builds this bot's tool set. Order and schemas are deterministic so the prompt prefix stays cacheable.
   * With `turn`, tools that must not act twice replay what earlier attempts of the same turn already did.
   */
  prepare(ctx: ToolSchemaContext, turn?: TurnInfo): PreparedTools {
    const disabled = new Set(ctx.bot.config.actions.disabledTools);
    const active = this.definitions.filter((d) => !disabled.has(d.key) && d.enabled(ctx));
    const schemas = new Map(active.map((d) => [d.key, d.schema(ctx)]));
    const specs = active.map((d) => ({
      name: d.key,
      description: d.description(ctx),
      inputSchema: toJsonSchema(schemas.get(d.key)!),
    }));
    const byName = new Map(active.map((d) => [d.key as string, d]));

    // Replay state for this attempt: calls seen per slot, and (loaded on first need) earlier attempts' results.
    // A call that waits for the team is never asked twice either, whatever its tool.
    const seen = new Map<string, number>();
    let earlier: Promise<Map<string, unknown[]>> | null = null;
    const replayFor = async (orgId: string, def: ToolDefinition, input: unknown, ask: boolean): Promise<unknown> => {
      const slot = ask ? askSlot(def, input) : def.repeatKey ? `${def.key}:${def.repeatKey(input)}` : null;
      if (!turn || !slot) return undefined;
      const nth = seen.get(slot) ?? 0;
      seen.set(slot, nth + 1);
      earlier ??= this.earlierResults(orgId, turn, byName);
      return (await earlier).get(slot)?.[nth];
    };

    const execute = async (call: ToolCall, tctx: ToolContext): Promise<ToolCallResult> => {
      const started = Date.now();
      const def = byName.get(call.name);
      let status: 'success' | 'error' | 'rejected' | 'replayed' | 'pending';
      let output: unknown;
      let error: string | null = null;

      if (!def) {
        status = 'rejected';
        error = `Unknown or disabled tool "${call.name}"`;
      } else {
        const parsed = schemas.get(def.key)!.safeParse(call.input);
        if (!parsed.success) {
          status = 'rejected';
          error = `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
        } else {
          const ask = asksFirst(ctx, def.key, parsed.data);
          const replayed = await replayFor(tctx.orgId, def, parsed.data, ask);
          if (replayed !== undefined) {
            // An earlier attempt of this turn already did this: hand the model that result, don't do it again.
            status = 'replayed';
            output = replayed;
          } else if (ask) {
            // Saved as a request for the team instead of happening now.
            const request = await this.tenantDb.run(tctx.orgId, (tx) =>
              recordApprovalRequest(tx, {
                orgId: tctx.orgId,
                conversationId: tctx.conversationId,
                contactId: tctx.contactId,
                botId: tctx.bot.id,
                aiRunId: tctx.aiRunId,
                toolName: def.key,
                input: parsed.data as Record<string, unknown>,
                now: tctx.now,
              }),
            );
            status = 'pending';
            if (request.created) await this.onApprovalRequested().catch((err) => this.logger.warn({ err }, 'approval alert nudge failed'));
            output = { waiting_for_team: true, request_id: request.id, ...(request.created ? {} : { already_asked: true }), note: WAITING };
          } else {
            if (def.activity) await tctx.activity(def.activity, { internal: def.activityInternal }).catch(() => {});
            try {
              const outcome = await withTimeout(def.run(parsed.data, tctx), TOOL_TIMEOUT_MS, `${call.name} timed out`);
              output = outcome.ok ? outcome.data : { error: outcome.error, ...(outcome.data ?? {}) };
              status = outcome.ok ? 'success' : 'error';
              if (!outcome.ok) error = outcome.error;
            } catch (err) {
              this.logger.error({ err, tool: call.name, conversationId: tctx.conversationId }, 'tool crashed');
              status = 'error';
              error = 'This action failed because of a system problem. Apologize, and offer to have the team follow up.';
            }
          }
        }
      }

      await this.tenantDb
        .run(tctx.orgId, (tx) =>
          tx.insert(schema.toolInvocations).values({
            organizationId: tctx.orgId,
            aiRunId: tctx.aiRunId,
            conversationId: tctx.conversationId,
            toolName: call.name,
            input: call.input ?? {},
            output: output ?? null,
            status,
            error,
            durationMs: Date.now() - started,
          }),
        )
        .catch((err) => this.logger.error({ err }, 'failed to write tool audit row'));

      const ok = status === 'success' || status === 'replayed' || status === 'pending';
      const content = ok ? JSON.stringify(output) : JSON.stringify(output ?? { error });
      return { toolCallId: call.id, content, isError: !ok };
    };

    return { specs, execute };
  }

  /**
   * Runs a call the team approved, as the bot's settings are now: an action since switched off, or a request that no
   * longer fits (a stage or owner removed from the bot's lists), is refused instead.
   */
  async runApproved(ctx: ToolSchemaContext, toolName: string, input: unknown, tctx: ToolContext): Promise<ToolOutcome> {
    const def = this.definitions.find((d) => d.key === toolName);
    if (!def || ctx.bot.config.actions.disabledTools.includes(def.key) || !def.enabled(ctx)) {
      return { ok: false, error: "This action is now switched off for the assistant, so it can't be approved. Decline it instead." };
    }
    const parsed = def.schema(ctx).safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: `This request no longer fits the assistant's settings (${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}).` };
    }
    try {
      return await withTimeout(def.run(parsed.data, tctx), TOOL_TIMEOUT_MS, `${toolName} timed out`);
    } catch (err) {
      this.logger.error({ err, tool: toolName, conversationId: tctx.conversationId }, 'approved action crashed');
      return { ok: false, error: 'This action failed because of a system problem. Try again, or decline it.' };
    }
  }

  /** Successful calls to repeat-keyed tools in earlier attempts of this turn, per slot, in the order they ran. */
  private async earlierResults(orgId: string, turn: TurnInfo, byName: Map<string, ToolDefinition>): Promise<Map<string, unknown[]>> {
    const bySlot = new Map<string, unknown[]>();
    await this.tenantDb.run(orgId, async (tx) => {
      const runs = await tx
        .select({ id: schema.aiRuns.id })
        .from(schema.aiRuns)
        .where(
          and(
            eq(schema.aiRuns.organizationId, orgId),
            eq(schema.aiRuns.conversationId, turn.conversationId),
            eq(schema.aiRuns.triggerMessageId, turn.triggerMessageId),
            ne(schema.aiRuns.id, turn.runId),
          ),
        );
      if (!runs.length) return;
      const calls = await tx
        .select({ toolName: schema.toolInvocations.toolName, input: schema.toolInvocations.input, output: schema.toolInvocations.output, status: schema.toolInvocations.status })
        .from(schema.toolInvocations)
        .where(and(inArray(schema.toolInvocations.aiRunId, runs.map((r) => r.id)), inArray(schema.toolInvocations.status, ['success', 'pending'])))
        .orderBy(asc(schema.toolInvocations.createdAt), asc(schema.toolInvocations.id));
      for (const call of calls) {
        const def = byName.get(call.toolName);
        if (!def) continue;
        const slot = call.status === 'pending' ? askSlot(def, call.input) : def.repeatKey ? `${def.key}:${def.repeatKey(call.input)}` : null;
        if (!slot) continue;
        bySlot.set(slot, [...(bySlot.get(slot) ?? []), call.output]);
      }
    });
    return bySlot;
  }
}
