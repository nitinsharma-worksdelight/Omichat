import { sql } from 'drizzle-orm';
import { rowsOf, type Db } from '../../db/client';
import type { Logger } from '../../lib/logger';
import type { ConversationsService } from '../conversations/service';

/** A customer message that has waited this long without an answer or a running reply is queued again. */
const WAITED_MS = 2 * 60_000;
/** Older than this is left alone (a day-old question isn't worth an automatic reply). */
const GIVE_UP_MS = 24 * 3_600_000;
/** A reply attempted for the message within this long is still in progress (or just failed and is retrying). */
const ATTEMPT_MS = 3 * 60_000;

/**
 * Safety net for the AI's replies: finds chats the AI should be answering where the customer's latest message has no
 * answer, and queues the reply again. Covers a message saved but never queued (the queue was down), a job that failed
 * before it could do anything, and a worker that died. System-level (all organizations); several workers may run it
 * at once, because a queued reply is deduplicated by its job id.
 */
export class UnansweredSweeper {
  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationsService,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(limit = 100): Promise<number> {
    const now = this.clock();
    const waited = new Date(now.getTime() - WAITED_MS).toISOString();
    const giveUp = new Date(now.getTime() - GIVE_UP_MS).toISOString();
    const attempted = new Date(now.getTime() - ATTEMPT_MS).toISOString();
    // The latest customer message of each AI-run chat is unanswered when no answer came after it: a staff or older AI
    // message after it, or an AI reply that says it answered that message or a later one. A "notice" answers nothing
    // (the same rule as `pendingInbound`).
    const rows = rowsOf<{ id: string; organization_id: string; message_id: string }>(
      await this.db.execute(sql`
        select c.id, c.organization_id, m.id as message_id
        from conversations c
        join organizations o on o.id = c.organization_id and o.ai_enabled
        join bots b on b.id = c.bot_id and b.is_active
        join lateral (
          select id, created_at from messages
          where conversation_id = c.id and direction = 'inbound'
          order by created_at desc, id desc limit 1
        ) m on true
        where c.status = 'ai_active'
          and m.created_at <= ${waited}::timestamptz
          and m.created_at > ${giveUp}::timestamptz
          and not exists (
            select 1 from messages a
            where a.conversation_id = c.id and a.direction = 'outbound'
              and coalesce(a.metadata ->> 'notice', '') <> 'true'
              and a.created_at >= m.created_at
              and (
                a.metadata ->> 'answersThrough' is null
                or exists (
                  select 1 from messages t
                  where t.conversation_id = c.id and t.id::text = a.metadata ->> 'answersThrough' and t.created_at >= m.created_at))
          )
          and not exists (
            select 1 from ai_runs r
            where r.conversation_id = c.id and r.trigger_message_id = m.id and r.created_at > ${attempted}::timestamptz)
        order by m.created_at
        limit ${limit}`),
    );
    for (const row of rows) {
      await this.conversations
        .queueReply(row.organization_id, row.id, row.message_id, { suffix: 'sweep' })
        .then(() => this.logger.warn({ orgId: row.organization_id, conversationId: row.id, messageId: row.message_id }, 'ai.unanswered_recovered'))
        .catch((err) => this.logger.error({ err, conversationId: row.id }, 'could not queue a reply for an unanswered message'));
    }
    return rows.length;
  }
}
