import { sql } from 'drizzle-orm';
import { rowsOf, schema, type Db } from '../../db/client';
import type { TenantDb } from '../../db/tenant';
import { HandoffSchema } from '../bots/config';
import { recordEvent } from '../automation/events';
import type { ConversationsService } from '../conversations/service';
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
    await this.tenantDb.run(row.organization_id, async (tx) => {
      const [conv] = await tx.select().from(schema.conversations).where(sql`${schema.conversations.id} = ${row.id}`);
      if (!conv) return;
      await recordEvent(tx, {
        orgId: row.organization_id,
        type: 'conversation.handoff_overdue',
        actor: 'system',
        contactId: conv.contactId,
        conversationId: conv.id,
        payload: { waitedMinutes: row.wait_minutes, fallback, reason: conv.handoffReason },
      });
    });
    await this.onEvent();
    if (fallback === 'keep_waiting') return;
    await this.conversations.addOutbound(scope, { conversationId: row.id, senderType: 'ai', content: FALLBACK_MESSAGES[fallback] });
    // The chat goes back to the assistant; staff can still take it over again at any time.
    await this.conversations.setStatus(scope, row.id, 'ai_active', { actor: 'system', reason: `Nobody replied within ${row.wait_minutes} minutes` });
  }
}
