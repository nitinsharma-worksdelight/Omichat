import { and, desc, eq, sql } from 'drizzle-orm';
import { rowsOf, schema, type Db } from '../../db/client';
import type { TenantDb } from '../../db/tenant';
import { HandoffFallbackSchema } from '../bots/config';
import { recordEvent } from '../automation/events';
import type { ConversationsService } from '../conversations/service';
import { notice } from '../conversations/pending';
import type { Logger } from '../../lib/logger';

/** Said to a customer who has waited past the bot's limit. */
export const FALLBACK_MESSAGES = {
  resume_ai: "Our team hasn't been able to reply yet, so I'll keep helping in the meantime.",
  ask_contact_details:
    "Our team hasn't been able to reply yet. If you share your email or phone number, they'll get back to you there. I can also keep helping in the meantime.",
} as const;

interface OverdueRow {
  id: string;
  organization_id: string;
  wait_minutes: number;
  fallback: string;
  [key: string]: unknown;
}

/**
 * Finds handed-off conversations that nobody answered within their bot's `handoff.waitMinutes`. System-level
 * (all organizations). Each conversation is claimed once (`handoff_escalated_at`), so overlapping runs never
 * alert or run the fallback twice.
 */
export class HandoffWatcher {
  constructor(
    private readonly db: Db,
    private readonly tenantDb: TenantDb,
    private readonly conversations: ConversationsService,
    private readonly logger: Logger,
    private readonly onEvent: () => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async escalateOverdue(): Promise<number> {
    const at = this.clock().toISOString();
    const claimed = rowsOf<OverdueRow>(
      await this.db.execute(sql`
        update conversations c
        set handoff_escalated_at = ${at}::timestamptz
        from bots b
        where c.id in (
            select c2.id from conversations c2
            join bots b2 on b2.id = c2.bot_id
            where c2.status = 'human_active' and c2.is_test = false
              and c2.handed_off_at is not null and c2.first_staff_reply_at is null and c2.handoff_escalated_at is null
              and coalesce((b2.config->'handoff'->>'waitMinutes')::int, 0) > 0
              and c2.handed_off_at + make_interval(mins => (b2.config->'handoff'->>'waitMinutes')::int) <= ${at}::timestamptz
            order by c2.handed_off_at
            limit 100
            for update of c2 skip locked)
          and b.id = c.bot_id
        returning c.id, c.organization_id,
          (b.config->'handoff'->>'waitMinutes')::int as wait_minutes,
          coalesce(b.config->'handoff'->>'fallback', 'keep_waiting') as fallback`),
    );
    for (const row of claimed) {
      await this.escalate(row).catch((err) => this.logger.error({ err, conversationId: row.id }, 'handoff escalation failed'));
    }
    return claimed.length;
  }

  /**
   * Handover scenarios with "Reactivate bot after": the assistant takes a handed-off chat back once its time is up,
   * unless the team replied within the last `reactivateAfterMinutes` (then it waits that long after their latest reply).
   */
  async reactivateDue(): Promise<number> {
    const now = this.clock();
    const due = rowsOf<{ id: string; organization_id: string }>(
      await this.db.execute(sql`
        select c.id, c.organization_id from conversations c
        where c.status = 'human_active' and (c.metadata ->> 'reactivateAt') is not null
          and (c.metadata ->> 'reactivateAt')::timestamptz <= ${now.toISOString()}::timestamptz
        order by (c.metadata ->> 'reactivateAt')::timestamptz
        limit 100`),
    );
    let reactivated = 0;
    for (const row of due) {
      try {
        if (await this.reactivate(row.organization_id, row.id, now)) reactivated++;
      } catch (err) {
        this.logger.error({ err, conversationId: row.id }, 'handover reactivation failed');
      }
    }
    return reactivated;
  }

  private async reactivate(orgId: string, conversationId: string, now: Date): Promise<boolean> {
    const c = schema.conversations;
    const m = schema.messages;
    const decision = await this.tenantDb.run(orgId, async (tx) => {
      const [conv] = await tx.select().from(c).where(eq(c.id, conversationId)).for('update');
      const at = typeof conv?.metadata.reactivateAt === 'string' ? Date.parse(conv.metadata.reactivateAt) : NaN;
      if (!conv || conv.status !== 'human_active' || !Number.isFinite(at) || at > now.getTime()) return 'skip' as const;
      const minutes = Number(conv.metadata.reactivateAfterMinutes) || 0;
      const [lastStaff] = await tx
        .select({ at: m.createdAt })
        .from(m)
        .where(and(eq(m.conversationId, conv.id), eq(m.senderType, 'human')))
        .orderBy(desc(m.createdAt))
        .limit(1);
      const quietSince = lastStaff ? lastStaff.at.getTime() + minutes * 60_000 : 0;
      if (quietSince > now.getTime()) {
        // The team is talking to them: try again once they've been quiet for the full time.
        await tx
          .update(c)
          .set({ metadata: sql`${c.metadata} || ${JSON.stringify({ reactivateAt: new Date(quietSince).toISOString() })}::jsonb` })
          .where(eq(c.id, conv.id));
        return 'later' as const;
      }
      return { minutes, scenario: typeof conv.metadata.handoffScenario === 'string' ? conv.metadata.handoffScenario : null };
    });
    if (decision === 'skip' || decision === 'later') return false;
    const hours = decision.minutes % 60 === 0 ? `${decision.minutes / 60} hour${decision.minutes === 60 ? '' : 's'}` : `${decision.minutes} minutes`;
    // Back with the assistant: it answers anything the customer wrote that nobody replied to.
    await this.conversations.setStatus({ orgId }, conversationId, 'ai_active', {
      actor: 'system',
      reason: `Reactivated after ${hours}${decision.scenario ? ` (${decision.scenario})` : ''}`,
      onlyFrom: ['human_active'],
    });
    await this.onEvent();
    return true;
  }

  private async escalate(row: OverdueRow): Promise<void> {
    const scope = { orgId: row.organization_id };
    const fallback = HandoffFallbackSchema.catch('keep_waiting').parse(row.fallback);
    const c = schema.conversations;
    // Claimed a moment ago, but a person may have replied, closed it or taken it back since: look again with the row
    // locked, and only then alert. A retry after a failed fallback doesn't alert twice.
    const stillWaiting = await this.tenantDb.run(row.organization_id, async (tx) => {
      const [conv] = await tx.select().from(c).where(eq(c.id, row.id)).for('update');
      if (!conv || conv.status !== 'human_active' || conv.firstStaffReplyAt) return false;
      // Set when an earlier run alerted but its fallback failed: this retry only redoes the fallback.
      if (conv.metadata.overdueAlerted !== true) {
        await recordEvent(tx, {
          orgId: row.organization_id,
          type: 'conversation.handoff_overdue',
          actor: 'system',
          contactId: conv.contactId,
          conversationId: conv.id,
          payload: { waitedMinutes: row.wait_minutes, fallback, reason: conv.handoffReason },
        });
      }
      return true;
    });
    if (!stillWaiting) return;
    await this.onEvent();
    if (fallback === 'keep_waiting') return;
    try {
      // Said only while nobody has replied (checked with the row locked), and not an answer to the customer's questions.
      const said = await this.conversations.addOutboundIf(
        scope,
        { conversationId: row.id, senderType: 'ai', content: FALLBACK_MESSAGES[fallback], metadata: notice() },
        (conv) => conv.status === 'human_active' && !conv.firstStaffReplyAt,
      );
      if (!said) return;
      // The chat goes back to the assistant (which answers what was asked meanwhile); staff can still take it over again.
      await this.conversations.setStatus(scope, row.id, 'ai_active', {
        actor: 'system',
        reason: `Nobody replied within ${row.wait_minutes} minutes`,
        onlyFrom: ['human_active'],
      });
    } catch (err) {
      // Release the claim so the next run tries again (without alerting the team a second time).
      await this.tenantDb
        .run(row.organization_id, (tx) =>
          tx
            .update(c)
            .set({ handoffEscalatedAt: null, metadata: sql`${c.metadata} || '{"overdueAlerted": true}'::jsonb` })
            .where(eq(c.id, row.id)),
        )
        .catch(() => {});
      throw err;
    }
  }
}
