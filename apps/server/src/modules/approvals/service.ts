import { and, count, desc, eq, gt, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { schema, type Db } from '../../db/client';
import type { ApprovalStatus } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import type { QueueDriver } from '../../infra/queue';
import { AppError, conflict, notFound } from '../../lib/errors';
import { recordEvent } from '../automation/events';
import type { BotsService } from '../bots/service';
import type { ConversationsService } from '../conversations/service';
import { displayName } from '../leads/capture';
import type { ToolExecutor } from '../tools/executor';
import type { ToolContext, ToolOutcome } from '../tools/types';

/** How long the team has to answer before a request expires. */
export const APPROVAL_TTL_MS = 7 * 86_400_000;
/** An approval still "running" after this was interrupted (a crash mid-action): it can be decided again. */
const STUCK_MS = 5 * 60_000;

export const ApprovalListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  conversationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ApproveSchema = z.object({ message: z.string().trim().min(1).max(4000).optional() });
export const RejectSchema = z.object({ reason: z.string().trim().min(1).max(500).optional(), message: z.string().trim().min(1).max(4000).optional() });

/** What the team and the API see: a running request is still pending, and one past its time is expired. */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalView {
  id: string;
  conversationId: string;
  contact: { id: string; name: string | null; email: string | null; phone: string | null; isTest: boolean };
  botId: string | null;
  tool: string;
  summary: string;
  input: Record<string, unknown>;
  status: ApprovalState;
  reason: string | null;
  result: Record<string, unknown> | null;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: { id: string; name: string } | null;
}

type ApprovalRow = typeof schema.actionApprovals.$inferSelect;

export const approvalState = (row: { status: ApprovalStatus; expiresAt: Date }, now: Date): ApprovalState =>
  row.status === 'running' ? 'pending' : row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status;

/** What an action does, in words: for the team deciding on it and for the assistant's memory of it. */
export function actionSummary(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
  // A slot's start is local time to the calendar ("2026-10-08T09:30"): written out the way people read it.
  const when = (v: unknown) => {
    const at = DateTime.fromISO(s(v), { zone: 'utc' });
    return at.isValid ? at.toFormat("ccc d LLL yyyy 'at' h:mm a") : s(v).replace('T', ' at ');
  };
  switch (tool) {
    case 'book_appointment':
      return `Book an appointment on ${when(input.start)}`;
    case 'reschedule_appointment':
      return `Move an appointment to ${when(input.new_start)}`;
    case 'cancel_appointment':
      return `Cancel an appointment${input.reason ? ` (${s(input.reason)})` : ''}`;
    case 'add_tags':
      return `Tag the customer: ${list(input.tags)}`;
    case 'remove_tags':
      return `Remove the customer's tags: ${list(input.tags)}`;
    case 'set_lifecycle_stage':
      return `Move the customer to the “${s(input.stage)}” stage`;
    case 'assign_owner':
      return `Make ${s(input.owner)} the customer's owner`;
    case 'create_deal':
      return `Open a deal: ${s(input.title)}${input.value !== undefined ? ` (value ${s(input.value)})` : ''}`;
    case 'update_deal': {
      const changes = [
        input.stage ? `stage ${s(input.stage)}` : '',
        input.value !== undefined ? `value ${s(input.value)}` : '',
        input.expected_close_on ? `expected to close ${s(input.expected_close_on)}` : '',
        input.status ? `mark it ${s(input.status)}${input.lost_reason ? ` (${s(input.lost_reason)})` : ''}` : '',
      ].filter(Boolean);
      return `Update the deal${changes.length ? `: ${changes.join(', ')}` : ''}`;
    }
    case 'trigger_workflow': {
      const inputs = Object.entries((input.inputs ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}: ${s(v)}`);
      return `Run the “${s(input.workflow_key)}” workflow${inputs.length ? ` (${inputs.join(', ')})` : ''}`;
    }
    case 'call_api': {
      const inputs = Object.entries((input.inputs ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}: ${s(v)}`);
      return `Call the “${s(input.api)}” API${inputs.length ? ` (${inputs.join(', ')})` : ''}`;
    }
    default:
      return tool;
  }
}

/**
 * Saves an ask-first call as a request for the team, and tells them. The same request still waiting in this
 * conversation is returned instead of asking twice.
 */
export async function recordApprovalRequest(
  tx: Db,
  req: { orgId: string; conversationId: string; contactId: string; botId: string; aiRunId: string; toolName: string; input: Record<string, unknown>; now: Date },
): Promise<{ id: string; created: boolean }> {
  const a = schema.actionApprovals;
  const [same] = await tx
    .select({ id: a.id })
    .from(a)
    .where(
      and(
        eq(a.organizationId, req.orgId),
        eq(a.conversationId, req.conversationId),
        eq(a.toolName, req.toolName),
        inArray(a.status, ['pending', 'running']),
        gt(a.expiresAt, req.now),
        sql`${a.input} = ${JSON.stringify(req.input)}::jsonb`,
      ),
    )
    .limit(1);
  if (same) return { id: same.id, created: false };
  const summary = actionSummary(req.toolName, req.input);
  const [row] = await tx
    .insert(a)
    .values({
      organizationId: req.orgId,
      conversationId: req.conversationId,
      contactId: req.contactId,
      botId: req.botId,
      aiRunId: req.aiRunId,
      toolName: req.toolName,
      input: req.input,
      summary,
      expiresAt: new Date(req.now.getTime() + APPROVAL_TTL_MS),
    })
    .returning({ id: a.id });
  await recordEvent(tx, {
    orgId: req.orgId,
    type: 'action.approval_requested',
    actor: 'ai',
    contactId: req.contactId,
    conversationId: req.conversationId,
    payload: { approvalId: row!.id, tool: req.toolName, summary, botId: req.botId },
  });
  return { id: row!.id, created: true };
}

/**
 * The team's side of "ask the team first": the requests, and approving (the action runs once, exactly as asked,
 * against the current state) or declining them, either with a message to the customer.
 */
export class ApprovalsService {
  constructor(
    private readonly deps: {
      tenantDb: TenantDb;
      tools: ToolExecutor;
      bots: BotsService;
      conversations: ConversationsService;
      /** Sends recorded events on (webhooks, notifications) without waiting for the timer. */
      kick: () => Promise<void>;
      queue: QueueDriver;
      clock?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.clock?.() ?? new Date();
  }

  async list(scope: Scope, filters: z.infer<typeof ApprovalListSchema>): Promise<ApprovalView[] & { total: number }> {
    const now = this.now();
    return inScope(this.deps.tenantDb, scope, async (tx) => {
      const a = schema.actionApprovals;
      const where: SQL[] = [eq(a.organizationId, scope.orgId)];
      if (filters.conversationId) where.push(eq(a.conversationId, filters.conversationId));
      if (filters.status === 'pending') where.push(inArray(a.status, ['pending', 'running']), gt(a.expiresAt, now));
      if (filters.status === 'expired') where.push(eq(a.status, 'pending'), lte(a.expiresAt, now));
      if (filters.status === 'approved' || filters.status === 'rejected') where.push(eq(a.status, filters.status));
      const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(a).where(and(...where));
      const rows = await tx.select().from(a).where(and(...where)).orderBy(desc(a.createdAt), desc(a.id)).limit(filters.limit).offset(filters.offset);
      return Object.assign(await this.views(tx, rows, now), { total });
    });
  }

  async get(scope: Scope, id: string): Promise<ApprovalView> {
    const now = this.now();
    return inScope(this.deps.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.actionApprovals)
        .where(and(eq(schema.actionApprovals.id, id), eq(schema.actionApprovals.organizationId, scope.orgId)));
      if (!row) throw notFound('Request');
      return (await this.views(tx, [row], now))[0]!;
    });
  }

  async approve(scope: Scope, id: string, userId: string, input: z.infer<typeof ApproveSchema>): Promise<ApprovalView> {
    const now = this.now();
    const a = schema.actionApprovals;
    // Claimed first, so two people approving at once run it once, and never after it expired.
    const claimed = await inScope(this.deps.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(a)
        .set({ status: 'running', decidedByUserId: userId, decidedAt: now })
        .where(and(eq(a.id, id), eq(a.organizationId, scope.orgId), this.decidable(now), gt(a.expiresAt, now)))
        .returning();
      return row ?? this.refuse(tx, scope.orgId, id, now);
    });
    let outcome: ToolOutcome;
    try {
      outcome = await this.run(scope, claimed, userId, now);
    } catch (err) {
      await this.release(scope, id);
      throw err;
    }
    if (!outcome.ok) {
      // Nothing happened: it stays pending, so the team can fix what's in the way or decline it.
      await this.release(scope, id);
      throw new AppError(422, 'action_failed', outcome.error);
    }
    await inScope(this.deps.tenantDb, scope, async (tx) => {
      await tx.update(a).set({ status: 'approved', result: outcome.data }).where(eq(a.id, id));
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'action.approved',
        actor: 'user',
        actorUserId: userId,
        contactId: claimed.contactId,
        conversationId: claimed.conversationId,
        payload: { approvalId: id, tool: claimed.toolName, summary: claimed.summary },
      });
    });
    if (input.message) await this.message(scope, claimed.conversationId, userId, input.message);
    else await this.tellCustomer(scope.orgId, id);
    await this.deps.kick();
    return this.get(scope, id);
  }

  /** The teammate wrote nothing to the customer: the assistant tells them what happened. */
  private async tellCustomer(orgId: string, approvalId: string) {
    await this.deps.queue.add('approval-followup', { orgId, approvalId }, { jobId: `approval_followup_${approvalId}`, attempts: 1 }).catch(() => {});
  }

  async reject(scope: Scope, id: string, userId: string, input: z.infer<typeof RejectSchema>): Promise<ApprovalView> {
    const now = this.now();
    const a = schema.actionApprovals;
    const row = await inScope(this.deps.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(a)
        .set({ status: 'rejected', reason: input.reason ?? null, decidedByUserId: userId, decidedAt: now })
        .where(and(eq(a.id, id), eq(a.organizationId, scope.orgId), this.decidable(now), gt(a.expiresAt, now)))
        .returning();
      if (!row) return this.refuse(tx, scope.orgId, id, now);
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'action.rejected',
        actor: 'user',
        actorUserId: userId,
        contactId: row.contactId,
        conversationId: row.conversationId,
        payload: { approvalId: id, tool: row.toolName, summary: row.summary, reason: input.reason ?? null },
      });
      return row;
    });
    if (input.message) await this.message(scope, row.conversationId, userId, input.message);
    else await this.tellCustomer(scope.orgId, id);
    await this.deps.kick();
    return this.get(scope, id);
  }

  /** Waiting for an answer: pending, or an approval that was interrupted mid-action. */
  private decidable(now: Date) {
    const a = schema.actionApprovals;
    return or(eq(a.status, 'pending'), and(eq(a.status, 'running'), lt(a.decidedAt, new Date(now.getTime() - STUCK_MS))))!;
  }

  /** Why a request can't be decided (it isn't there, it expired, or it was already decided). */
  private async refuse(tx: Db, orgId: string, id: string, now: Date): Promise<never> {
    const a = schema.actionApprovals;
    const [row] = await tx.select({ status: a.status, expiresAt: a.expiresAt }).from(a).where(and(eq(a.id, id), eq(a.organizationId, orgId)));
    if (!row) throw notFound('Request');
    if (row.status === 'pending' && row.expiresAt <= now) throw new AppError(409, 'expired', 'This request expired: nobody answered it within 7 days.');
    if (row.status === 'running') throw conflict('Someone is approving this request right now.');
    throw conflict(`This request was already ${row.status === 'approved' ? 'approved' : 'declined'}.`);
  }

  /** Back to pending after an approval that didn't go through. */
  private async release(scope: Scope, id: string) {
    const a = schema.actionApprovals;
    await inScope(this.deps.tenantDb, scope, (tx) =>
      tx.update(a).set({ status: 'pending', decidedByUserId: null, decidedAt: null }).where(and(eq(a.id, id), eq(a.status, 'running'))),
    );
  }

  /** Runs the approved call as the bot that asked, with its settings and the conversation as they are now. */
  private async run(scope: Scope, row: ApprovalRow, userId: string, now: Date): Promise<ToolOutcome> {
    const bot = row.botId ? await this.deps.bots.get(scope, row.botId).catch(() => null) : null;
    if (!bot) return { ok: false, error: 'The assistant that asked for this no longer exists.' };
    const conversation = await this.deps.conversations.get(scope, row.conversationId);
    const [org] = await this.deps.tenantDb.run(scope.orgId, (tx) =>
      tx.select({ timezone: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, scope.orgId)),
    );
    const schemaCtx = await this.deps.tools.schemaContext(scope.orgId, bot);
    // The conversation's contact now (a merge may have moved it).
    let contactId = conversation.contactId;
    const ctx: ToolContext = {
      orgId: scope.orgId,
      conversationId: row.conversationId,
      get contactId() {
        return contactId;
      },
      aiRunId: row.aiRunId ?? '',
      bot,
      channel: conversation.channel,
      orgTimezone: org?.timezone ?? 'UTC',
      now,
      setContactId: (next) => {
        contactId = next;
      },
      // Ask-first actions don't hand off, stream progress or post follow-up messages.
      requestHandoff: () => {},
      activity: async () => {},
      postAfterReply: () => {},
      schema: schemaCtx,
      approval: { id: row.id, decidedByUserId: userId },
    };
    return this.deps.tools.runApproved(schemaCtx, row.toolName, row.input, ctx);
  }

  /** A message from the team member to the customer; the AI keeps the conversation. */
  private async message(scope: Scope, conversationId: string, userId: string, content: string) {
    await this.deps.conversations.addOutbound(scope, { conversationId, senderType: 'human', content, senderUserId: userId });
  }

  private async views(tx: Db, rows: ApprovalRow[], now: Date): Promise<ApprovalView[]> {
    if (!rows.length) return [];
    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    const userIds = [...new Set(rows.map((r) => r.decidedByUserId).filter((x): x is string => Boolean(x)))];
    const contacts = await tx
      .select({
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        email: schema.contacts.email,
        phone: schema.contacts.phone,
        isTest: schema.contacts.isTest,
      })
      .from(schema.contacts)
      .where(inArray(schema.contacts.id, contactIds));
    const users = userIds.length
      ? await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, userIds))
      : [];
    return rows.map((r) => {
      const c = contacts.find((x) => x.id === r.contactId);
      const u = users.find((x) => x.id === r.decidedByUserId);
      return {
        id: r.id,
        conversationId: r.conversationId,
        contact: { id: r.contactId, name: c ? displayName(c) : null, email: c?.email ?? null, phone: c?.phone ?? null, isTest: c?.isTest ?? false },
        botId: r.botId,
        tool: r.toolName,
        // Worded from the saved request, so older requests read the same way as new ones.
        summary: actionSummary(r.toolName, r.input as Record<string, unknown>),
        input: r.input,
        status: approvalState(r, now),
        reason: r.reason,
        result: r.status === 'approved' ? r.result : null,
        requestedAt: r.createdAt,
        expiresAt: r.expiresAt,
        decidedAt: r.status === 'approved' || r.status === 'rejected' ? r.decidedAt : null,
        decidedBy: u && (r.status === 'approved' || r.status === 'rejected') ? { id: u.id, name: u.name.trim() || u.email.split('@')[0]! } : null,
      };
    });
  }
}
