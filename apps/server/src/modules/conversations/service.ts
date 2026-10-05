import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '../../db/client';
import type { ChannelType, Citation, ConversationStatus, SenderType } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import type { PubSub } from '../../infra/pubsub';
import type { QueueDriver } from '../../infra/queue';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { normalizeIp } from '../../lib/ip';
import { queryBool } from '../../lib/validation';
import type { SummaryJob } from '../ai/summary';
import { recordEvent } from '../automation/events';
import { trimPageUrl } from '../leads/attribution';
import { pendingInbound } from './pending';
import type { ChannelRegistry } from '../channels/adapter';
import { toContactView, type ContactsService } from '../contacts/service';
import { displayName } from '../leads/capture';

/** What every channel adapter hands the engine. Nothing below this line knows which channel it came from. */
export interface NormalizedInboundMessage {
  orgId: string;
  channelAccountId: string;
  externalUserId: string;
  content: string;
  /** Provider message id or client idempotency key; duplicates are dropped. */
  externalMessageId?: string;
  attachments?: Array<{ url: string; type: string; name?: string }>;
  metadata?: Record<string, unknown>;
  /** Playground sessions can pin a bot other than the channel's default. */
  botIdOverride?: string;
  isTest?: boolean;
  /** Where the visitor first came from (widget or integration); kept on the contact once. */
  firstTouch?: unknown;
  /** The visitor's timezone (the widget reads the browser's); kept on the contact when none is known. */
  timezone?: string;
  /** The website visitor's address as the server saw it (`req.ip`), kept on the conversation it creates (not for tests). */
  visitorIp?: string | null;
}

export interface InboundResult {
  conversationId: string;
  contactId: string;
  message: MessageView;
  duplicate: boolean;
  aiQueued: boolean;
}

export type MessageView = ReturnType<typeof toMessageView>;
export type ConversationRow = typeof schema.conversations.$inferSelect;

export interface OutboundInput {
  conversationId: string;
  senderType: Exclude<SenderType, 'contact'>;
  content: string;
  senderUserId?: string | null;
  citations?: Citation[];
  aiRunId?: string | null;
  /**
   * What the message is for: `answersThrough` (an AI reply: the customer message it answers), `notice` (not an answer),
   * `consentRequest` (a posted consent question), … See `pendingInbound`.
   */
  metadata?: Record<string, unknown>;
}

export function toMessageView(m: typeof schema.messages.$inferSelect) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    senderType: m.senderType,
    senderUserId: m.senderUserId,
    content: m.content,
    attachments: m.attachments,
    citations: m.citations,
    aiRunId: m.aiRunId,
    status: m.status,
    createdAt: m.createdAt,
  };
}

/** Realtime events. Published on `conv:<id>` (widget + open thread) and `org:<id>` (inbox lists). */
export type RealtimeEvent =
  | { type: 'message'; conversationId: string; message: MessageView }
  | { type: 'ai.typing'; conversationId: string; runId: string }
  | { type: 'ai.delta'; conversationId: string; runId: string; text: string }
  | { type: 'ai.activity'; conversationId: string; runId: string; label: string; internal?: boolean }
  | { type: 'ai.done'; conversationId: string; runId: string; messageId: string | null }
  | { type: 'conversation.status'; conversationId: string; status: ConversationStatus; reason?: string | null }
  /** Staff only: who looks after the conversation changed. */
  | { type: 'conversation.assigned'; conversationId: string; assignedUserId: string | null }
  /** Staff only: a new summary was saved (the dashboard refetches it). */
  | { type: 'conversation.summary'; conversationId: string };

/** Handed to the team, not yet answered, and already past its bot's limit. */
function isOverdue(c: typeof schema.conversations.$inferSelect): boolean {
  return c.status === 'human_active' && !c.firstStaffReplyAt && Boolean(c.handoffEscalatedAt);
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const convChannel = (id: string) => `conv:${id}`;
export const orgChannel = (id: string) => `org:${id}`;
/** One member's own events in one organization (personal notifications). */
export const userChannel = (orgId: string, userId: string) => `user:${orgId}:${userId}`;

export const ConversationListSchema = z.object({
  status: z.enum(['ai_active', 'human_active', 'closed']).optional(),
  channel: z.string().max(30).optional(),
  contactId: z.string().uuid().optional(),
  includeTest: queryBool.optional(),
  search: z.string().trim().max(200).optional(),
  /** `me` (needs the signed-in user), `unassigned`, or a member's ID. */
  assignee: z.union([z.enum(['me', 'unassigned']), z.string().uuid()]).optional(),
  /** `waiting`: handed-off chats nobody has answered first, longest wait first. */
  sort: z.enum(['recent', 'waiting']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

export class ConversationsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly contacts: ContactsService,
    private readonly queue: QueueDriver,
    private readonly pubsub: PubSub,
    private readonly channels: ChannelRegistry,
    private readonly opts: {
      replyDebounceMs: number;
      /** Quiet spell before a recap; 0 = none. */
      summaryIdleMs?: number;
      /** After an event was recorded here (a message to a chat-API customer): send it on without waiting for the timer. */
      onEventRecorded?: () => Promise<void>;
    },
  ) {}

  // ---------- inbound ----------

  async receiveInbound(msg: NormalizedInboundMessage): Promise<InboundResult> {
    const content = msg.content.trim();
    if (!content && !msg.attachments?.length) throw badRequest('Message is empty');
    if (content.length > 4000) throw badRequest('Message is too long (4000 characters max)');
    const scope = { orgId: msg.orgId };

    const account = await inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.channelAccounts)
        .where(and(eq(schema.channelAccounts.id, msg.channelAccountId), eq(schema.channelAccounts.organizationId, msg.orgId)));
      return row;
    });
    if (!account || account.status !== 'active') throw notFound('Channel');

    const { contactId } = await this.contacts.findOrCreateByIdentity(scope, {
      channel: account.channel,
      externalId: msg.externalUserId,
      isTest: msg.isTest ?? account.channel === 'playground',
    });
    if (msg.firstTouch) await this.contacts.recordFirstTouch(scope, contactId, msg.firstTouch);
    if (msg.timezone) await this.contacts.recordTimezone(scope, contactId, msg.timezone);
    // A page URL keeps only what attribution needs: other query parameters may carry personal data.
    const metadata: Record<string, unknown> = { ...(msg.metadata ?? {}) };
    if ('pageUrl' in metadata) {
      const pageUrl = trimPageUrl(metadata.pageUrl);
      if (pageUrl) metadata.pageUrl = pageUrl;
      else delete metadata.pageUrl;
    }

    const isTest = msg.isTest ?? account.channel === 'playground';
    // A new conversation keeps where it came from; its messages don't carry the address.
    const visitorIp = isTest || !msg.visitorIp || !(await this.recordsVisitorIp(msg.orgId)) ? null : normalizeIp(msg.visitorIp);
    const conversationMetadata = visitorIp ? { ...metadata, visitorIp, visitorIpAt: new Date().toISOString() } : metadata;

    const result = await inScope(this.tenantDb, scope, async (tx) => {
      const conversation = await this.findOrCreateOpen(tx, {
        orgId: msg.orgId,
        channelAccountId: account.id,
        channel: account.channel,
        contactId,
        botId: msg.botIdOverride ?? account.botId,
        isTest,
        metadata: conversationMetadata,
      });
      const inserted = await tx
        .insert(schema.messages)
        .values({
          organizationId: msg.orgId,
          conversationId: conversation.id,
          direction: 'inbound',
          senderType: 'contact',
          content,
          attachments: msg.attachments ?? [],
          externalId: msg.externalMessageId ?? null,
          metadata,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) {
        const [existing] = await tx
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.externalId, msg.externalMessageId!)));
        return { conversation, message: existing!, duplicate: true };
      }
      const now = new Date();
      await tx
        .update(schema.conversations)
        .set({ messageCount: sql`${schema.conversations.messageCount} + 1`, lastMessageAt: now, lastInboundAt: now })
        .where(eq(schema.conversations.id, conversation.id));
      await tx.update(schema.contacts).set({ lastActivityAt: now }).where(eq(schema.contacts.id, contactId));
      return { conversation, message: inserted[0]!, duplicate: false };
    });

    const view = toMessageView(result.message);
    let aiQueued = false;
    if (!result.duplicate) {
      await this.publish(msg.orgId, { type: 'message', conversationId: result.conversation.id, message: view });
      // A chat with no bot (its bot was deleted) is queued too: the reply job tells the team nobody can answer.
      if (result.conversation.status === 'ai_active') {
        // One job per inbound message; the handler skips itself if a newer message arrived meanwhile,
        // so a burst of messages gets a single reply.
        await this.queueReply(msg.orgId, result.conversation.id, view.id, { delayMs: this.opts.replyDebounceMs });
        aiQueued = true;
      }
      await this.queueRecap(msg.orgId, result.conversation.id, view.id);
    } else if (result.conversation.status === 'ai_active') {
      // A retry of a message that was saved but whose reply job may never have been queued (the queue was down at
      // that moment): queue it again. If the first job is still waiting, or the message was answered, this is a no-op.
      await this.queueReply(msg.orgId, result.conversation.id, view.id, { delayMs: this.opts.replyDebounceMs });
    }
    return { conversationId: result.conversation.id, contactId, message: view, duplicate: result.duplicate, aiQueued };
  }

  /**
   * Queues the AI's reply to a customer message. A job that fails for good forgets its id, so the same message can be
   * queued again (a retry of the request, the sweeper, handing the chat back to the AI).
   */
  async queueReply(orgId: string, conversationId: string, triggerMessageId: string, opts: { delayMs?: number; suffix?: string } = {}) {
    await this.queue.add(
      'ai-reply',
      { orgId, conversationId, triggerMessageId },
      { jobId: `reply_${triggerMessageId}${opts.suffix ? `_${opts.suffix}` : ''}`, delayMs: opts.delayMs ?? 0, attempts: 3, backoffMs: 3_000, removeOnFail: true },
    );
  }

  /** The latest customer message in the conversation that nobody has answered, if any. */
  async unansweredTrigger(scope: Scope, conversationId: string): Promise<string | null> {
    const rows = await this.recentRows(scope, conversationId, 60);
    return pendingInbound(rows).at(-1)?.id ?? null;
  }

  /** The conversation's latest messages, oldest first (ties broken by id, which is time-ordered). */
  async recentRows(scope: Scope, conversationId: string, limit: number) {
    const rows = await inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.organizationId, scope.orgId), eq(schema.messages.conversationId, conversationId)))
        .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
        .limit(limit),
    );
    return rows.reverse();
  }

  /**
   * Recap the conversation once it has been quiet for a while, so a later conversation (or staff) can
   * recall it. Every customer or staff message schedules one; it does nothing if a newer one came.
   */
  private async queueRecap(orgId: string, conversationId: string, afterMessageId: string) {
    if (!this.opts.summaryIdleMs) return;
    const job: SummaryJob = { orgId, conversationId, mode: 'recap', trigger: 'quiet', afterMessageId };
    await this.queue.add('summary', job, { jobId: `recap_${afterMessageId}`, delayMs: this.opts.summaryIdleMs, attempts: 2 });
  }

  private async findOrCreateOpen(
    tx: Db,
    input: {
      orgId: string;
      channelAccountId: string;
      channel: ChannelType;
      contactId: string;
      botId: string | null;
      isTest: boolean;
      metadata: Record<string, unknown>;
    },
  ) {
    const open = () =>
      tx
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.channelAccountId, input.channelAccountId),
            eq(schema.conversations.contactId, input.contactId),
            ne(schema.conversations.status, 'closed'),
          ),
        );
    const [existing] = await open();
    if (existing) return existing;
    const created = await tx
      .insert(schema.conversations)
      .values({
        organizationId: input.orgId,
        contactId: input.contactId,
        channelAccountId: input.channelAccountId,
        channel: input.channel,
        botId: input.botId,
        isTest: input.isTest,
        metadata: input.metadata,
      })
      .onConflictDoNothing()
      .returning();
    if (created[0]) {
      await recordEvent(tx, {
        orgId: input.orgId,
        type: 'conversation.started',
        actor: 'contact',
        contactId: input.contactId,
        conversationId: created[0].id,
        payload: { channel: input.channel },
      });
      return created[0];
    }
    const [raced] = await open();
    return raced!;
  }

  // ---------- outbound ----------

  /** Stores an outbound message and delivers it through the conversation's channel adapter. */
  async addOutbound(scope: Scope, input: OutboundInput): Promise<MessageView> {
    return (await this.insertOutbound(scope, input))!;
  }

  /**
   * Like `addOutbound`, but only while `allowed` says yes about the conversation as it is right now (checked with the
   * row locked, so a staff takeover or a close can't slip in between the check and the message). Null when it said no.
   */
  async addOutboundIf(scope: Scope, input: OutboundInput, allowed: (conversation: ConversationRow) => boolean): Promise<MessageView | null> {
    return this.insertOutbound(scope, input, allowed);
  }

  private async insertOutbound(scope: Scope, input: OutboundInput, allowed?: (conversation: ConversationRow) => boolean): Promise<MessageView | null> {
    const stored = await inScope(this.tenantDb, scope, async (tx) => {
      const conversation = await this.row(tx, scope.orgId, input.conversationId, { lock: Boolean(allowed) });
      if (allowed && !allowed(conversation)) return null;
      const [message] = await tx
        .insert(schema.messages)
        .values({
          organizationId: scope.orgId,
          conversationId: conversation.id,
          direction: 'outbound',
          senderType: input.senderType,
          senderUserId: input.senderUserId ?? null,
          content: input.content,
          citations: input.citations ?? [],
          aiRunId: input.aiRunId ?? null,
          metadata: input.metadata ?? {},
          status: 'sent',
        })
        .returning();
      await tx
        .update(schema.conversations)
        .set({
          messageCount: sql`${schema.conversations.messageCount} + 1`,
          aiReplyCount: input.senderType === 'ai' ? sql`${schema.conversations.aiReplyCount} + 1` : undefined,
          lastMessageAt: new Date(),
          // The first staff answer after a handoff stops the "still waiting" clock.
          firstStaffReplyAt:
            input.senderType === 'human' && conversation.status === 'human_active' && !conversation.firstStaffReplyAt ? new Date() : undefined,
        })
        .where(eq(schema.conversations.id, conversation.id));
      // A chat-API customer only sees what the integration passes on: every message to them goes out as an event,
      // recorded with the message itself.
      if (conversation.channel === 'api') {
        await recordEvent(tx, {
          orgId: scope.orgId,
          type: 'message.outbound',
          actor: input.senderType === 'human' ? 'user' : input.senderType,
          actorUserId: input.senderUserId ?? null,
          contactId: conversation.contactId,
          conversationId: conversation.id,
          payload: {
            message: { id: message!.id, content: message!.content, senderType: message!.senderType, createdAt: message!.createdAt },
            externalUserId: await this.apiCustomerId(tx, conversation),
          },
        });
      }
      return { message: message!, conversation };
    });
    if (!stored) return null;
    const { message, conversation } = stored;
    const view = toMessageView(message);
    await this.channels.get(conversation.channel).deliver({ orgId: scope.orgId, conversation, message: view });
    await this.publish(scope.orgId, { type: 'message', conversationId: conversation.id, message: view });
    if (conversation.channel === 'api') await this.opts.onEventRecorded?.();
    return view;
  }

  /** The integration's own ID for a chat-API customer: kept on the conversation, or (older ones) from the identity. */
  private async apiCustomerId(tx: Db, conversation: typeof schema.conversations.$inferSelect): Promise<string | null> {
    const kept = conversation.metadata.externalUserId;
    if (typeof kept === 'string' && kept) return kept;
    const [identity] = await tx
      .select({ externalId: schema.contactIdentities.externalId })
      .from(schema.contactIdentities)
      .where(and(eq(schema.contactIdentities.contactId, conversation.contactId), eq(schema.contactIdentities.channel, 'api')))
      .orderBy(asc(schema.contactIdentities.createdAt))
      .limit(1);
    return identity?.externalId ?? null;
  }

  /** A staff reply. Replying to an AI-run conversation takes it over (the AI stops answering). */
  async humanReply(scope: Scope, conversationId: string, userId: string, content: string): Promise<MessageView> {
    const text = content.trim();
    if (!text) throw badRequest('Message is empty');
    const conv = await inScope(this.tenantDb, scope, (tx) => this.row(tx, scope.orgId, conversationId));
    if (conv.status === 'closed') throw conflict('This conversation is closed');
    if (conv.status === 'ai_active') {
      await this.setStatus(scope, conversationId, 'human_active', { actor: 'user', actorUserId: userId, reason: 'Staff replied' });
    } else if (conv.status === 'human_active' && !conv.assignedUserId) {
      await this.assignReplier(scope, conversationId, userId);
    }
    const message = await this.addOutbound(scope, { conversationId, senderType: 'human', content: text, senderUserId: userId });
    await this.queueRecap(scope.orgId, conversationId, message.id);
    return message;
  }

  /**
   * A chat with the team that nobody looks after goes to whoever answers it. Only while it's still unassigned, so two
   * people replying at once end up with one assignee, and a teammate's chat is never taken from them.
   */
  private async assignReplier(scope: Scope, conversationId: string, userId: string) {
    const c = schema.conversations;
    const claimed = await inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(c)
        .set({ assignedUserId: userId })
        .where(and(eq(c.id, conversationId), eq(c.organizationId, scope.orgId), eq(c.status, 'human_active'), isNull(c.assignedUserId)))
        .returning();
      if (!row) return null;
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'conversation.assigned',
        actor: 'user',
        actorUserId: userId,
        contactId: row.contactId,
        conversationId: row.id,
        payload: { assignedUserId: userId, previousUserId: null, auto: true },
      });
      return row;
    });
    if (!claimed) return;
    await this.opts.onEventRecorded?.();
    await this.publish(scope.orgId, { type: 'conversation.assigned', conversationId, assignedUserId: userId });
  }

  async setStatus(
    scope: Scope,
    conversationId: string,
    status: ConversationStatus,
    opts: {
      actor: 'ai' | 'user' | 'system';
      actorUserId?: string;
      reason?: string | null;
      /** Handoffs by the AI: whether staff get an alert (the bot's `handoff.notifyTeam`). Webhooks get the event either way. */
      notifyTeam?: boolean;
      /** Change the status only if it is one of these right now (e.g. the AI's handoff never reopens a closed chat). */
      onlyFrom?: ConversationStatus[];
      /** Staff reopening a closed chat (to `human_active`): its own event, not a handoff, and no new recap. */
      reopen?: boolean;
    },
  ) {
    let changed = false;
    const updated = await inScope(this.tenantDb, scope, async (tx) => {
      // Locked, so two people (or the AI and a person) changing it at once are applied one after the other: the second
      // sees the first's result and, when it asked for the same status, changes nothing and records no second event.
      const conv = await this.row(tx, scope.orgId, conversationId, { lock: true });
      if (opts.reopen && conv.status !== 'closed') throw conflict('This conversation is not closed');
      if (conv.status === status) return conv;
      if (opts.onlyFrom && !opts.onlyFrom.includes(conv.status)) return conv;
      if (conv.status === 'closed') {
        // One open conversation per customer per channel: reopening an old one would collide with a newer one.
        const [open] = await tx
          .select({ id: schema.conversations.id })
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.channelAccountId, conv.channelAccountId),
              eq(schema.conversations.contactId, conv.contactId),
              ne(schema.conversations.status, 'closed'),
            ),
          )
          .limit(1);
        // The newer conversation's id travels in the details, so the dashboard can link to it.
        if (open) throw conflict('This customer already has a newer open conversation', [{ path: 'openConversationId', message: open.id }]);
      }
      changed = true;
      // Who looks after it: whoever took it over, else the customer's owner when they're a member; nobody once it's
      // back with the AI or closed.
      const assignee = status === 'human_active' ? (opts.actorUserId ?? (await this.memberOwner(tx, scope.orgId, conv.contactId))) : null;
      const brief = status === 'human_active' ? await this.brief(tx, conv) : null;
      const [row] = await tx
        .update(schema.conversations)
        .set({
          status,
          handoffReason: status === 'human_active' ? (opts.reason ?? null) : conv.handoffReason,
          assignedUserId: assignee,
          // Returning to the AI resets the per-conversation reply budget.
          aiReplyCount: status === 'ai_active' ? 0 : conv.aiReplyCount,
          // The waiting clock: starts at a handoff, and a person taking over by hand is already answering. Reopening
          // isn't a handoff: no clock.
          handedOffAt: status === 'human_active' && !opts.reopen ? new Date() : null,
          firstStaffReplyAt: status === 'human_active' && opts.actor === 'user' && !opts.reopen ? new Date() : null,
          handoffEscalatedAt: null,
          // A new handoff (or a return to the AI) starts the overdue alert afresh.
          metadata: sql`${schema.conversations.metadata} - 'overdueAlerted'`,
        })
        .where(eq(schema.conversations.id, conv.id))
        .returning();
      const type = opts.reopen
        ? 'conversation.reopened'
        : status === 'human_active'
          ? 'conversation.handoff_requested'
          : status === 'ai_active'
            ? 'conversation.resumed_by_ai'
            : 'conversation.closed';
      await recordEvent(tx, {
        orgId: scope.orgId,
        type,
        actor: opts.actor,
        actorUserId: opts.actorUserId,
        contactId: conv.contactId,
        conversationId: conv.id,
        payload: {
          reason: opts.reason ?? null,
          previousStatus: conv.status,
          ...(opts.notifyTeam === undefined ? {} : { notifyTeam: opts.notifyTeam }),
          ...(brief ? { brief, assignedUserId: assignee } : {}),
        },
      });
      // A handoff given to the customer's owner tells them personally (staff taking over need no note).
      if (assignee && assignee !== opts.actorUserId) {
        await recordEvent(tx, {
          orgId: scope.orgId,
          type: 'conversation.assigned',
          actor: 'system',
          contactId: conv.contactId,
          conversationId: conv.id,
          payload: { assignedUserId: assignee, previousUserId: conv.assignedUserId, auto: true },
        });
      }
      return row!;
    });
    await this.publish(scope.orgId, { type: 'conversation.status', conversationId, status: updated.status, reason: opts.reason });
    if (changed && status === 'ai_active') {
      // Back with the AI: answer what the customer wrote while the team had it and nobody replied.
      const waiting = await this.unansweredTrigger(scope, conversationId);
      if (waiting) await this.queueReply(scope.orgId, conversationId, waiting, { suffix: 'resume' });
    }
    if (changed && status !== 'ai_active' && !opts.reopen) {
      // Closed: recap it now, so the customer's next conversation can recall it. Handed to a person: so they
      // (and integrations) start from a current summary.
      const job: SummaryJob = { orgId: scope.orgId, conversationId, mode: 'recap', trigger: status === 'closed' ? 'closed' : 'handoff' };
      await this.queue.add('summary', job, { attempts: 2 });
    }
    return updated;
  }

  /** Gives the conversation to a team member (or nobody). The new assignee is notified unless they did it themselves. */
  async assign(scope: Scope, conversationId: string, userId: string | null, actorUserId: string) {
    const result = await inScope(this.tenantDb, scope, async (tx) => {
      const conv = await this.row(tx, scope.orgId, conversationId);
      if (userId && !(await this.isMember(tx, scope.orgId, userId))) throw badRequest('That person is not a member of this organization');
      if (conv.assignedUserId === userId) return conv;
      const [row] = await tx.update(schema.conversations).set({ assignedUserId: userId }).where(eq(schema.conversations.id, conv.id)).returning();
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'conversation.assigned',
        actor: 'user',
        actorUserId,
        contactId: conv.contactId,
        conversationId: conv.id,
        payload: { assignedUserId: userId, previousUserId: conv.assignedUserId, auto: false },
      });
      return row!;
    });
    await this.opts.onEventRecorded?.();
    await this.publish(scope.orgId, { type: 'conversation.assigned', conversationId, assignedUserId: result.assignedUserId });
    return result;
  }

  private async isMember(tx: Db, orgId: string, userId: string): Promise<boolean> {
    const [m] = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.organizationId, orgId), eq(schema.memberships.userId, userId)));
    return Boolean(m);
  }

  private async memberOwner(tx: Db, orgId: string, contactId: string): Promise<string | null> {
    const [contact] = await tx.select({ ownerUserId: schema.contacts.ownerUserId }).from(schema.contacts).where(eq(schema.contacts.id, contactId));
    const owner = contact?.ownerUserId ?? null;
    return owner && (await this.isMember(tx, orgId, owner)) ? owner : null;
  }

  /**
   * What staff read in the handoff alert, available at once: the customer's latest words, plus the parts of the
   * last recap when there is one (the recap queued at handoff refreshes the summary bar a moment later).
   */
  private async brief(tx: Db, conv: typeof schema.conversations.$inferSelect) {
    const [last] = await tx
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.senderType, 'contact')))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    const d = conv.summaryDetails;
    return {
      lastMessage: last ? truncateText(last.content, 280) : null,
      intent: d?.intent ?? null,
      nextStep: d?.nextStep ?? null,
      sentiment: d?.sentiment ?? null,
    };
  }

  // ---------- reads ----------

  async list(scope: Scope, filters: z.infer<typeof ConversationListSchema>, userId: string | null = null) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const c = schema.conversations;
      const where: SQL[] = [eq(c.organizationId, scope.orgId)];
      if (filters.assignee === 'unassigned') where.push(isNull(c.assignedUserId));
      else if (filters.assignee === 'me') {
        if (!userId) throw badRequest('assignee=me needs a signed-in team member');
        where.push(eq(c.assignedUserId, userId));
      } else if (filters.assignee) where.push(eq(c.assignedUserId, filters.assignee));
      if (filters.status) where.push(eq(c.status, filters.status));
      if (filters.channel) where.push(eq(c.channel, filters.channel as ChannelType));
      if (filters.contactId) where.push(eq(c.contactId, filters.contactId));
      if (!filters.includeTest) where.push(eq(c.isTest, false));
      if (filters.search) {
        const q = `%${filters.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
        const ct = schema.contacts;
        where.push(sql`(${ct.firstName} ilike ${q} or ${ct.lastName} ilike ${q} or ${ct.email} ilike ${q} or ${ct.phone} ilike ${q})`);
      }
      const [{ total } = { total: 0 }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(c)
        .innerJoin(schema.contacts, eq(schema.contacts.id, c.contactId))
        .where(and(...where));
      const rows = await tx
        .select({ conversation: c, contact: schema.contacts })
        .from(c)
        .innerJoin(schema.contacts, eq(schema.contacts.id, c.contactId))
        .where(and(...where))
        .orderBy(
          ...(filters.sort === 'waiting'
            ? [sql`(${c.status} = 'human_active' and ${c.firstStaffReplyAt} is null) desc`, sql`${c.handedOffAt} asc nulls last`]
            : []),
          desc(sql`coalesce(${c.lastMessageAt}, ${c.createdAt})`),
        )
        .limit(filters.limit)
        .offset(filters.offset);
      const ids = rows.map((r) => r.conversation.id);
      const lastMessages = ids.length
        ? await tx
            .selectDistinctOn([schema.messages.conversationId], {
              conversationId: schema.messages.conversationId,
              content: schema.messages.content,
              senderType: schema.messages.senderType,
              createdAt: schema.messages.createdAt,
            })
            .from(schema.messages)
            .where(inArray(schema.messages.conversationId, ids))
            .orderBy(schema.messages.conversationId, desc(schema.messages.createdAt))
        : [];
      const last = new Map(lastMessages.map((m) => [m.conversationId, m]));
      const assignees = await this.people(tx, rows.map((r) => r.conversation.assignedUserId));
      const items = rows.map((r) => ({
        ...r.conversation,
        contact: { id: r.contact.id, name: displayName(r.contact), email: r.contact.email, phone: r.contact.phone, leadTier: r.contact.leadTier },
        lastMessage: last.get(r.conversation.id) ?? null,
        assignee: r.conversation.assignedUserId ? (assignees.get(r.conversation.assignedUserId) ?? null) : null,
        overdue: isOverdue(r.conversation),
      }));
      return Object.assign(items, { total });
    });
  }

  private async people(tx: Db, ids: Array<string | null>) {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!wanted.length) return new Map<string, { id: string; name: string }>();
    const rows = await tx.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, wanted));
    return new Map(rows.map((u) => [u.id, { id: u.id, name: u.name || u.email }]));
  }

  async get(scope: Scope, conversationId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const conv = await this.row(tx, scope.orgId, conversationId);
      const contact = await this.contacts.row(tx, scope.orgId, conv.contactId);
      const assignees = await this.people(tx, [conv.assignedUserId]);
      return {
        ...conv,
        contact: { ...toContactView(contact), tags: await this.contacts.tagsFor(tx, contact.id) },
        assignee: conv.assignedUserId ? (assignees.get(conv.assignedUserId) ?? null) : null,
        overdue: isOverdue(conv),
      };
    });
  }

  async messages(scope: Scope, conversationId: string, opts: { limit?: number; after?: string; before?: string } = {}) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.row(tx, scope.orgId, conversationId);
      const where: SQL[] = [eq(schema.messages.conversationId, conversationId)];
      const limit = Math.min(opts.limit ?? 50, 200);
      if (opts.after) {
        const [pivot] = await tx.select({ createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.id, opts.after));
        if (pivot) where.push(gt(schema.messages.createdAt, pivot.createdAt));
        const rows = await tx.select().from(schema.messages).where(and(...where)).orderBy(asc(schema.messages.createdAt)).limit(limit);
        return rows.map(toMessageView);
      }
      if (opts.before) {
        const [pivot] = await tx.select({ createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.id, opts.before));
        if (pivot) where.push(lt(schema.messages.createdAt, pivot.createdAt));
      }
      const rows = await tx.select().from(schema.messages).where(and(...where)).orderBy(desc(schema.messages.createdAt)).limit(limit);
      return rows.reverse().map(toMessageView);
    });
  }

  /** Conversation timeline: AI actions, bookings, handoffs, qualification changes. */
  async timeline(scope: Scope, conversationId: string) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.events)
        // Messages to chat-API customers are in the thread already; their events are for webhooks.
        .where(and(eq(schema.events.organizationId, scope.orgId), eq(schema.events.conversationId, conversationId), ne(schema.events.type, 'message.outbound')))
        .orderBy(asc(schema.events.createdAt))
        .limit(500),
    );
  }

  async toolInvocations(scope: Scope, conversationId: string) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.toolInvocations)
        .where(and(eq(schema.toolInvocations.organizationId, scope.orgId), eq(schema.toolInvocations.conversationId, conversationId)))
        .orderBy(asc(schema.toolInvocations.createdAt))
        .limit(500),
    );
  }

  /** The visitor's open conversation on a channel account, if any (widget history restore). */
  /**
   * The website visitor's address at their latest chat session, on their open conversation. Written only when it
   * changed, and never for test (playground) conversations.
   */
  async recordVisitorIp(scope: Scope, conversationId: string, ip: string): Promise<void> {
    if (!(await this.recordsVisitorIp(scope.orgId))) return;
    const c = schema.conversations;
    await inScope(this.tenantDb, scope, (tx) =>
      tx
        .update(c)
        .set({ metadata: sql`${c.metadata} || ${JSON.stringify({ visitorIp: ip, visitorIpAt: new Date().toISOString() })}::jsonb` })
        .where(and(eq(c.id, conversationId), eq(c.organizationId, scope.orgId), eq(c.isTest, false), sql`${c.metadata} ->> 'visitorIp' is distinct from ${ip}`)),
    );
  }

  /** Whether the organization records visitors' IP addresses (missing = yes; new organizations start with no). */
  private async recordsVisitorIp(orgId: string): Promise<boolean> {
    const [row] = await inScope(this.tenantDb, { orgId }, (tx) =>
      tx.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)),
    );
    return row?.settings.recordVisitorIp !== false;
  }

  async openForIdentity(scope: Scope, channelAccountId: string, channel: ChannelType, externalUserId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const contactId = await this.contacts.findByIdentity(tx, scope.orgId, channel, externalUserId);
      if (!contactId) return null;
      const resolved = await this.contacts.resolveId(tx, scope.orgId, contactId);
      const [conv] = await tx
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.channelAccountId, channelAccountId),
            eq(schema.conversations.contactId, resolved),
            ne(schema.conversations.status, 'closed'),
          ),
        );
      return conv ?? null;
    });
  }

  /** A customer's latest conversation on a channel account, open or closed (chat-API polling). */
  async latestForIdentity(scope: Scope, channelAccountId: string, channel: ChannelType, externalUserId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const contactId = await this.contacts.findByIdentity(tx, scope.orgId, channel, externalUserId);
      if (!contactId) return null;
      const resolved = await this.contacts.resolveId(tx, scope.orgId, contactId);
      const [conv] = await tx
        .select()
        .from(schema.conversations)
        .where(and(eq(schema.conversations.channelAccountId, channelAccountId), eq(schema.conversations.contactId, resolved)))
        .orderBy(desc(schema.conversations.createdAt))
        .limit(1);
      return conv ?? null;
    });
  }

  async row(tx: Db, orgId: string, id: string, opts: { lock?: boolean } = {}) {
    const query = tx
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.id, id), eq(schema.conversations.organizationId, orgId)));
    const [row] = opts.lock ? await query.for('update') : await query;
    if (!row) throw notFound('Conversation');
    return row;
  }

  /** Token-level events (typing, deltas, tool activity) go only to the conversation; inbox lists get the rest. */
  async publish(orgId: string, event: RealtimeEvent): Promise<void> {
    const inboxWorthy = event.type === 'message' || event.type === 'conversation.status' || event.type === 'ai.done' || event.type === 'conversation.assigned';
    await Promise.all([
      this.pubsub.publish(convChannel(event.conversationId), event),
      inboxWorthy ? this.pubsub.publish(orgChannel(orgId), event) : Promise.resolve(),
    ]);
  }
}
