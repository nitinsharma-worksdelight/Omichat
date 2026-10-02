import { eq, sql } from 'drizzle-orm';
import { rowsOf, schema, type Db } from '../../db/client';
import type { TenantDb } from '../../db/tenant';
import { HandoffSchema } from '../bots/config';
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

  private async escalate(row: OverdueRow): Promise<void> {
    const scope = { orgId: row.organization_id };
    const fallback = HandoffSchema.shape.fallback.catch('keep_waiting').parse(row.fallback);
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
