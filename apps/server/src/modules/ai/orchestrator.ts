import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Env } from '../../config/env';
import { schema } from '../../db/client';
import type { Citation } from '../../db/schema';
import type { TenantDb } from '../../db/tenant';
import type { LockService } from '../../infra/lock';
import type { QueueDriver } from '../../infra/queue';
import type { Logger } from '../../lib/logger';
import { approvalState } from '../approvals/service';
import type { AutomationService } from '../automation/service';
import { handoffStarter, STANDARD_LEAD_FIELDS } from '../bots/config';
import type { BotsService, BotView } from '../bots/service';
import type { ChannelRegistry } from '../channels/adapter';
import { openingGreeting } from '../channels/service';
import type { ContactsService } from '../contacts/service';
import { toMessageView, type ConversationsService, type MessageView } from '../conversations/service';
import type { DealsService } from '../deals/service';
import type { KnowledgeService, RetrievedChunk } from '../knowledge/service';
import type { QualificationService } from '../leads/qualification';
import type { SchedulingService } from '../scheduling/service';
import type { ToolExecutor } from '../tools/executor';
import { hasAskFirst, type ToolContext } from '../tools/types';
import { monthSpendUsd } from './budget';
import { LlmError, textOf, type LlmMessage, type LlmProvider, type LlmUsage } from './llm/types';
import { addUsage, type PriceBook } from './pricing';
import { buildContextBlock, buildHistory, buildSystemPrompt, escapeTags, gapNote, MEMORY_LIMITS, type EarlierAction, type EarlierConversation } from './prompt';
import type { SummaryJob } from './summary';

export interface ReplyJob {
  orgId: string;
  conversationId: string;
  triggerMessageId: string;
}

type Outcome = 'completed' | 'failed' | 'skipped' | 'handoff';

const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** Fold older messages into the summary once this many more than the history size are unsummarized. */
const FOLD_AFTER = 10;

export class AiOrchestrator {
  constructor(
    private readonly deps: {
      env: Env;
      tenantDb: TenantDb;
      llm: LlmProvider;
      locks: LockService;
      queue: QueueDriver;
      bots: BotsService;
      contacts: ContactsService;
      conversations: ConversationsService;
      knowledge: KnowledgeService;
      qualification: QualificationService;
      scheduling: SchedulingService;
      tools: ToolExecutor;
      automation: AutomationService;
      deals: DealsService;
      channels: ChannelRegistry;
      prices: PriceBook;
      logger: Logger;
      clock?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** Queue handler. One reply at a time per conversation; a burst of messages gets one reply. */
  async handle(job: ReplyJob, meta: { attempt: number; maxAttempts: number }): Promise<void> {
    // The lock renews itself while the reply runs, so a short TTL only matters if this worker dies.
    await this.deps.locks.withLock(`conv_${job.conversationId}`, { ttlMs: 60_000, waitMs: 90_000 }, (lockLost) =>
      this.reply(job, meta, lockLost),
    );
  }

  private async reply(job: ReplyJob, meta: { attempt: number; maxAttempts: number }, lockLost: AbortSignal): Promise<void> {
    const { tenantDb, conversations, logger } = this.deps;
    const scope = { orgId: job.orgId };
    const log = logger.child({ orgId: job.orgId, conversationId: job.conversationId });
    // The whole turn — model calls and tools — gets a time limit; losing the lock stops it too.
    const deadline = AbortSignal.timeout(this.deps.env.AI_TURN_TIMEOUT_MS);
    const stop = AbortSignal.any([deadline, lockLost]);

    // ---- 1. Is this job still the one that should answer? ----
    const state = await tenantDb.run(job.orgId, async (tx) => {
      const conv = await conversations.row(tx, job.orgId, job.conversationId);
      const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, job.orgId));
      // The history shows up to twice the history size, plus room for a burst of new messages.
      const limit = this.deps.env.AI_HISTORY_MESSAGES * 2 + 20;
      const rows = (
        await tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id)).orderBy(desc(schema.messages.createdAt)).limit(limit)
      ).reverse();
      // Web chat: the greeting the widget showed before the first message, and the page of the latest one.
      const [account] =
        conv.channel === 'webchat' || conv.channel === 'playground'
          ? await tx.select({ config: schema.channelAccounts.config }).from(schema.channelAccounts).where(eq(schema.channelAccounts.id, conv.channelAccountId))
          : [];
      const lastInbound = rows.filter((r) => r.direction === 'inbound').at(-1);
      return {
        conv,
        org: org!,
        recent: rows.map(toMessageView),
        /** Every message was loaded, so the first one is the conversation's first. */
        fromStart: rows.length < limit,
        channelConfig: account?.config ?? null,
        page: typeof lastInbound?.metadata.pageUrl === 'string' ? lastInbound.metadata.pageUrl : null,
        /** Web chat: the conversation starter each message came from, when the visitor clicked one. */
        starterOf: new Map(rows.flatMap((r) => (typeof r.metadata.starterId === 'string' ? [[r.id, r.metadata.starterId] as const] : []))),
      };
    });
    const { conv, org } = state;
    const lastOutboundIdx = state.recent.map((m) => m.direction).lastIndexOf('outbound');
    const pending = state.recent.slice(lastOutboundIdx + 1).filter((m) => m.direction === 'inbound');
    const latestInbound = pending[pending.length - 1];
    if (!latestInbound || latestInbound.id !== job.triggerMessageId) {
      // Either already answered or a newer message arrived; its own job will reply.
      return;
    }
    if (conv.status !== 'ai_active' || !conv.botId) return;
    if (!org.aiEnabled) {
      log.info('AI disabled for organization; not replying');
      return;
    }
    const bot = await this.deps.bots.get(scope, conv.botId).catch(() => null);
    if (!bot?.isActive) return;

    const pendingText = pending.map((m) => m.content).join('\n');
    const answered = state.recent.slice(0, lastOutboundIdx + 1);
    const { history, unsummarized } = selectHistory(
      state.recent,
      answered.length,
      conv.summarizedThroughMessageId,
      conv.messageCount,
      this.deps.env.AI_HISTORY_MESSAGES,
    );

    // ---- 2. Guards that don't need the model ----
    // A "talk to the team" starter counts only while it's still one of this bot's enabled starters.
    const chosen = handoffStarter(bot.config, pending.map((m) => state.starterOf.get(m.id)));
    if (chosen) {
      await this.handoff(scope, conv.id, bot, `Customer chose "${chosen.label}"`, bot.config.handoff.message);
      return;
    }
    if (bot.config.handoff.enabled && matchesHandoffKeyword(pendingText, bot.config.handoff.keywords)) {
      await this.handoff(scope, conv.id, bot, 'Customer asked for a person', bot.config.handoff.message);
      return;
    }
    if (conv.aiReplyCount >= bot.config.guardrails.maxAiRepliesPerConversation) {
      await this.handoff(scope, conv.id, bot, 'AI reply limit reached for this conversation', bot.config.handoff.message);
      return;
    }
    if (org.monthlyAiBudgetUsd !== null && (await monthSpendUsd(tenantDb, job.orgId)) >= Number(org.monthlyAiBudgetUsd)) {
      log.warn('monthly AI budget exhausted');
      // Like an error, this stops the AI everywhere, so staff always hear about it.
      await this.handoff(scope, conv.id, bot, 'Monthly AI budget reached', bot.config.handoff.message, { alwaysNotify: true });
      return;
    }

    // ---- 3. Context ----
    let contactId = conv.contactId;
    const [toolSchemaCtx, contact, earlierConversations, earlierActions, knowledgeLanguages, pastAppointments] = await Promise.all([
      this.deps.tools.schemaContext(job.orgId, bot),
      this.deps.contacts.getForConversation(scope, contactId),
      this.earlierConversations(job.orgId, conv.id, conv.contactId),
      this.earlierActions(job.orgId, conv.id),
      this.deps.knowledge.languagesOf(scope, bot.knowledgeBaseIds),
      // Their latest visits, whether or not this bot books: continuity ("how did the cleaning go?").
      this.deps.scheduling.pastForContact(scope, contactId, { limit: MEMORY_LIMITS.pastAppointments, sinceDays: 365 }),
    ]);
    // Greetings and thanks need no documents (the model can still search itself when it must).
    const searchable = bot.knowledgeBaseIds.length > 0 && !isSmallTalk(pendingText);
    const retrieval = searchable
      ? await this.deps.knowledge
          .search(scope, { knowledgeBaseIds: bot.knowledgeBaseIds, query: retrievalQuery(pendingText, history), limit: 5 })
          .catch((err) => {
            log.warn({ err }, 'retrieval failed; answering without knowledge');
            return null;
          })
      : null;
    const upcoming = bot.config.booking.enabled ? await this.deps.scheduling.listForContact(scope, contactId, { upcomingOnly: true }) : [];
    const activeTools = this.deps.tools.prepare(toolSchemaCtx).specs.map((s) => s.name);
    // CRM actions: the owner and open deals are shown only to bots that can change them.
    const owner = activeTools.includes('assign_owner') ? await this.ownerName(job.orgId, contact.ownerUserId, toolSchemaCtx.owners) : undefined;
    const pipeline = activeTools.includes('create_deal') ? toolSchemaCtx.pipeline : null;
    const openDeals = pipeline
      ? (await this.deps.deals.list(scope, { contactId, pipelineId: pipeline.id, status: 'open', limit: 3, offset: 0 })).map((d) => ({
          id: d.id,
          title: d.title,
          stage: pipeline.stages.find((st) => st.id === d.stageId)?.name ?? '',
          value: d.value,
          currency: d.currency,
        }))
      : undefined;
    const qual =
      bot.config.qualification.enabled && bot.config.qualification.questions.length
        ? this.deps.qualification.progress(bot.config.qualification, contact.qualification)
        : null;
    const customFieldLabels = new Map(toolSchemaCtx.customFields.map((f) => [f.key, f.label]));
    const contextBlock = buildContextBlock({
      now: this.now(),
      timezone: org.timezone,
      channel: conv.channel,
      contact,
      customFieldLabels,
      missingLeadFields: missingLeadFields(bot, contact, customFieldLabels),
      qualification: qual
        ? { answered: qual.answers, nextQuestion: qual.nextQuestion?.question ?? null, status: contact.qualificationStatus }
        : null,
      upcomingAppointments: upcoming.map((a) => ({ id: a.id, title: a.title, label: a.label, timezone: a.timezone })),
      recentAppointments: pastAppointments.map((a) => ({ title: a.title, label: a.label, timezone: a.timezone, status: a.status })),
      page: state.page,
      retrieval: retrieval ? { chunks: retrieval.chunks, grounding: retrieval.grounding } : searchable ? { chunks: [], grounding: 'none' } : null,
      earlierActions,
      turnAt: latestInbound.createdAt,
      asksMarketingConsent: bot.config.leadCapture.enabled && bot.config.leadCapture.marketingOptIn.trim() !== '',
      owner,
      deals: openDeals,
    });

    const system = buildSystemPrompt(bot, {
      customFields: toolSchemaCtx.customFields,
      hasKnowledge: bot.knowledgeBaseIds.length > 0,
      knowledgeLanguages,
      organizationName: org.name,
      activeTools,
      asksFirst: hasAskFirst(toolSchemaCtx, activeTools),
    });
    // The greeting stays while the conversation's first message is still in the history (not yet folded into the summary).
    const firstInView = history.length ? history[0]!.id : pending[0]?.id;
    const opening =
      state.channelConfig && state.fromStart && !conv.summarizedThroughMessageId && firstInView === state.recent[0]?.id
        ? openingGreeting(state.channelConfig, bot)
        : null;
    const messages: LlmMessage[] = buildHistory(history, { summary: conv.summary, earlierConversations, timezone: org.timezone, opening });
    const previousAt = answered[answered.length - 1]?.createdAt;
    const gap = previousAt ? gapNote(previousAt, pending[0]!.createdAt, org.timezone) : null;
    const turn = { type: 'text' as const, text: `${contextBlock}\n\n${gap ? `${gap}\n` : ''}${escapeTags(pendingText)}` };
    // A new conversation may open with memory alone: the customer's message joins that first turn.
    const lastTurn = messages[messages.length - 1];
    if (lastTurn?.role === 'user') lastTurn.content.push(turn);
    else messages.push({ role: 'user', content: [turn] });

    // ---- 4. Run ----
    const [run] = await tenantDb.run(job.orgId, (tx) =>
      tx
        .insert(schema.aiRuns)
        .values({
          organizationId: job.orgId,
          conversationId: conv.id,
          botId: bot.id,
          botVersion: bot.version,
          triggerMessageId: job.triggerMessageId,
          provider: this.deps.llm.info.provider,
          model: bot.model ?? this.deps.llm.info.model,
          status: 'failed',
          grounding: retrieval ? retrieval.grounding : 'n/a',
          retrievedChunkIds: retrieval?.chunks.map((c) => c.id) ?? [],
        })
        .returning({ id: schema.aiRuns.id }),
    );
    const runId = run!.id;
    // Knows this turn (conversation + customer message), so a retry replays what earlier attempts already did.
    const prepared = this.deps.tools.prepare(toolSchemaCtx, { conversationId: conv.id, triggerMessageId: job.triggerMessageId, runId });
    const started = Date.now();
    const streaming = this.deps.channels.get(conv.channel).streaming;
    const citations = new Map<string, RetrievedChunk>((retrieval?.chunks ?? []).map((c) => [c.id, c]));
    let handoffReason: string | null = null;
    let usage = EMPTY_USAGE;
    let iterations = 0;
    let stopReason: string | null = null;
    let servedModel = bot.model ?? this.deps.llm.info.model;
    const texts: string[] = [];
    const delta = new DeltaBuffer((text) => conversations.publish(job.orgId, { type: 'ai.delta', conversationId: conv.id, runId, text }));

    // Messages of the server's own (e.g. a consent question, verbatim) that follow the model's reply.
    const followUps: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
    const toolCtx: ToolContext = {
      orgId: job.orgId,
      conversationId: conv.id,
      get contactId() {
        return contactId;
      },
      aiRunId: runId,
      bot,
      channel: conv.channel,
      orgTimezone: org.timezone,
      now: this.now(),
      setContactId: (id) => {
        contactId = id;
      },
      requestHandoff: (reason) => {
        handoffReason = reason;
      },
      activity: (label) => conversations.publish(job.orgId, { type: 'ai.activity', conversationId: conv.id, runId, label }),
      postAfterReply: (message) => {
        followUps.push(message);
      },
      schema: toolSchemaCtx,
    };

    await conversations.publish(job.orgId, { type: 'ai.typing', conversationId: conv.id, runId });
    let outcome: Outcome = 'completed';
    let error: string | null = null;
    try {
      for (let round = 0; round < this.deps.env.AI_MAX_TOOL_ROUNDS + 1; round++) {
        iterations++;
        const lastRound = round === this.deps.env.AI_MAX_TOOL_ROUNDS || handoffReason !== null;
        const response = await this.deps.llm.generate(
          {
            tier: 'reply',
            // Only per-bot overrides are passed; otherwise the provider uses the configured model/effort.
            model: bot.model ?? undefined,
            reasoningEffort: bot.effort ?? undefined,
            system,
            // On the final round (or after a handoff) tools are withheld so the model must answer in text.
            tools: lastRound ? [] : prepared.specs,
            messages,
            maxTokens: bot.maxOutputTokens,
          },
          { onText: streaming ? (t) => delta.push(t) : undefined, signal: stop },
        );
        await delta.flush();
        usage = addUsage(usage, response.usage);
        stopReason = response.stopReason;
        servedModel = response.model;
        const text = textOf(response.content);
        if (text) texts.push(text);

        if (response.stopReason === 'refusal') {
          handoffReason = handoffReason ?? 'The AI could not help with this request';
          texts.length = 0;
          break;
        }
        const calls = response.content.filter((b) => b.type === 'tool_use');
        if (response.stopReason !== 'tool_use' || calls.length === 0 || lastRound) break;

        // Out of time, or the lock is gone: don't start acting (the catch below retries the turn).
        if (stop.aborted) throw new TurnStopped();
        // A human may have taken over while the model was thinking: stop before acting.
        if (!(await this.stillAiActive(job.orgId, conv.id))) {
          outcome = 'skipped';
          break;
        }
        messages.push({ role: 'assistant', content: response.content, raw: response.raw });
        // Sequential, in the order the model asked: business actions depend on each other within a
        // turn (details saved before a booking; a merge can change the contact id mid-turn).
        const results = [];
        for (const call of calls) results.push(await prepared.execute({ id: call.id, name: call.name, input: call.input }, toolCtx));
        for (const r of results) collectCitations(r.content, citations);
        messages.push({
          role: 'user',
          content: results.map((r) => ({ type: 'tool_result' as const, toolUseId: r.toolCallId, content: r.content, isError: r.isError })),
        });
      }
      // Without the lock, someone else may be answering now: never send.
      if (lockLost.aborted) throw new TurnStopped();
    } catch (err) {
      await delta.flush().catch(() => {});
      // The time limit and a lost lock are retried like a temporary provider error (the retry replays done actions).
      const provider = this.deps.llm.info.provider;
      const failure = lockLost.aborted
        ? new LlmError('unavailable', true, 'Lost the conversation lock', provider)
        : deadline.aborted
          ? new LlmError('unavailable', true, `No reply within ${this.deps.env.AI_TURN_TIMEOUT_MS} ms`, provider)
          : err;
      error = failure instanceof Error ? failure.message : String(failure);
      await this.finishRun(job.orgId, runId, { status: 'failed', usage, iterations, stopReason, model: servedModel, started, error });
      await conversations.publish(job.orgId, { type: 'ai.done', conversationId: conv.id, runId, messageId: null });
      // Without the lock we can't apologize or hand off either: leave it to the retry.
      if (lockLost.aborted) throw failure;
      if (failure instanceof LlmError && failure.retryable && meta.attempt < meta.maxAttempts) throw failure;
      log.error({ err: failure }, 'AI reply failed');
      if (failure instanceof LlmError && (failure.kind === 'auth' || failure.kind === 'billing')) {
        await this.deps.automation.reportProviderProblem(scope, { kind: failure.kind, provider: failure.provider, message: failure.message });
      }
      await this.handoff(scope, conv.id, bot, 'The assistant hit an error', "Sorry — I'm having trouble right now. A member of our team will reply here shortly.", {
        alwaysNotify: true,
      });
      return;
    }

    // ---- 5. Deliver ----
    let messageId: string | null = null;
    if (outcome !== 'skipped') {
      const finalText = texts.join('\n\n').trim() || (handoffReason ? bot.config.handoff.message : '');
      // Re-check right before sending: never talk over a human who just took over.
      if (!handoffReason && !(await this.stillAiActive(job.orgId, conv.id))) {
        outcome = 'skipped';
      } else if (finalText) {
        const message = await conversations.addOutbound(scope, {
          conversationId: conv.id,
          senderType: 'ai',
          content: finalText,
          aiRunId: runId,
          citations: [...citations.values()].slice(0, 8).map<Citation>((c) => ({ chunkId: c.id, documentId: c.documentId, title: c.title, url: c.url })),
        });
        messageId = message.id;
      }
      // Not after a handoff (the team takes it from here) or when a human took over.
      if (outcome !== 'skipped' && !handoffReason) {
        for (const f of followUps) {
          await conversations.addOutbound(scope, { conversationId: conv.id, senderType: 'ai', content: f.content, aiRunId: runId, metadata: f.metadata });
        }
      }
      if (handoffReason) {
        outcome = 'handoff';
        await conversations.setStatus(scope, conv.id, 'human_active', {
          actor: 'ai',
          reason: handoffReason,
          notifyTeam: bot.config.handoff.notifyTeam,
        });
      }
    }

    await this.finishRun(job.orgId, runId, { status: outcome, usage, iterations, stopReason, model: servedModel, started, error });
    await conversations.publish(job.orgId, { type: 'ai.done', conversationId: conv.id, runId, messageId });
    await this.deps.automation.kick();
    await this.maybeFold(job.orgId, conv.id, conv.summarizedThroughMessageId, unsummarized);
  }

  private async stillAiActive(orgId: string, conversationId: string): Promise<boolean> {
    const [row] = await this.deps.tenantDb.run(orgId, (tx) =>
      tx.select({ status: schema.conversations.status }).from(schema.conversations).where(eq(schema.conversations.id, conversationId)),
    );
    return row?.status === 'ai_active';
  }

  private async handoff(
    scope: { orgId: string },
    conversationId: string,
    bot: BotView,
    reason: string,
    message: string,
    opts: { alwaysNotify?: boolean } = {},
  ) {
    await this.deps.conversations.addOutbound(scope, { conversationId, senderType: 'ai', content: message });
    await this.deps.conversations.setStatus(scope, conversationId, 'human_active', {
      actor: 'ai',
      reason,
      // An error handoff always alerts staff: nobody else would know the AI stopped answering.
      notifyTeam: opts.alwaysNotify || bot.config.handoff.notifyTeam,
    });
    await this.deps.automation.kick();
  }

  private async finishRun(
    orgId: string,
    runId: string,
    r: { status: Outcome; usage: LlmUsage; iterations: number; stopReason: string | null; model: string; started: number; error: string | null },
  ) {
    await this.deps.tenantDb.run(orgId, (tx) =>
      tx
        .update(schema.aiRuns)
        .set({
          status: r.status,
          model: r.model,
          stopReason: r.stopReason,
          iterations: r.iterations,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cacheReadTokens: r.usage.cacheReadTokens,
          cacheWriteTokens: r.usage.cacheWriteTokens,
          costUsd: this.deps.prices.costUsd(r.model, r.usage).toFixed(6),
          latencyMs: Date.now() - r.started,
          error: r.error?.slice(0, 2000) ?? null,
        })
        .where(eq(schema.aiRuns.id, runId)),
    );
  }

  /** The contact's owner as the model knows team members: the bot's own names for them, else their name on the team. */
  private async ownerName(orgId: string, ownerUserId: string | null, owners: Array<{ id: string; name: string }>): Promise<string | null> {
    if (!ownerUserId) return null;
    const listed = owners.find((o) => o.id === ownerUserId);
    if (listed) return listed.name;
    const [user] = await this.deps.tenantDb.run(orgId, (tx) =>
      tx.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, ownerUserId)),
    );
    return user ? user.name.trim() || user.email.split('@')[0]! : null;
  }

  /** Recaps of the contact's most recent other conversations (any channel). */
  private async earlierConversations(orgId: string, conversationId: string, contactId: string): Promise<EarlierConversation[]> {
    const c = schema.conversations;
    const rows = await this.deps.tenantDb.run(orgId, (tx) =>
      tx
        .select({ channel: c.channel, summary: c.summary, lastMessageAt: c.lastMessageAt, createdAt: c.createdAt })
        .from(c)
        // The conversation's own contact only: never through a pending duplicate claim (Phase 1).
        .where(and(eq(c.organizationId, orgId), eq(c.contactId, contactId), ne(c.id, conversationId), isNotNull(c.summary)))
        .orderBy(desc(sql`coalesce(${c.lastMessageAt}, ${c.createdAt})`))
        .limit(MEMORY_LIMITS.earlierConversations),
    );
    return rows.map((r) => ({ channel: r.channel, summary: r.summary!, at: r.lastMessageAt ?? r.createdAt }));
  }

  /** This conversation's earlier successful tool calls, newest first; calls that asked the team first, with their answer. */
  private async earlierActions(orgId: string, conversationId: string): Promise<EarlierAction[]> {
    const ti = schema.toolInvocations;
    const now = this.now();
    return this.deps.tenantDb.run(orgId, async (tx) => {
      const calls = await tx
        .select({ toolName: ti.toolName, input: ti.input, output: ti.output, at: ti.createdAt })
        .from(ti)
        .where(
          and(
            eq(ti.organizationId, orgId),
            // Through the conversation's runs, so both lookups use an index.
            inArray(ti.aiRunId, tx.select({ id: schema.aiRuns.id }).from(schema.aiRuns).where(eq(schema.aiRuns.conversationId, conversationId))),
            inArray(ti.status, ['success', 'replayed', 'pending']),
          ),
        )
        .orderBy(desc(ti.createdAt))
        .limit(60);
      const requestOf = (output: unknown) => {
        const id = (output as { request_id?: unknown } | null)?.request_id;
        return typeof id === 'string' ? id : null;
      };
      const ids = [...new Set(calls.map((c) => requestOf(c.output)).filter((id): id is string => id !== null))];
      if (!ids.length) return calls;
      const a = schema.actionApprovals;
      const requests = await tx.select({ id: a.id, status: a.status, expiresAt: a.expiresAt, summary: a.summary, reason: a.reason }).from(a).where(inArray(a.id, ids));
      const seen = new Set<string>();
      return calls.flatMap((c) => {
        const id = requestOf(c.output);
        if (!id) return [c];
        const request = requests.find((r) => r.id === id);
        // Never listed as if it had happened.
        if (!request) return [];
        // A request asked again (or replayed on a retry) is listed once.
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ ...c, approval: { status: approvalState(request, now), summary: request.summary, reason: request.reason } }];
      });
    });
  }

  /** Long conversations: fold the oldest messages into the summary once enough are unsummarized. */
  private async maybeFold(orgId: string, conversationId: string, through: string | null, unsummarized: number) {
    if (unsummarized <= this.deps.env.AI_HISTORY_MESSAGES + FOLD_AFTER) return;
    const job: SummaryJob = { orgId, conversationId, mode: 'fold' };
    // Triggers collapse into one pending fold per summary state and 10-message step. The step matters
    // with Redis: a failed job keeps its id, so without it one failure would block every later fold.
    const step = Math.floor(unsummarized / FOLD_AFTER);
    await this.deps.queue.add('summary', job, { jobId: `fold_${conversationId}_${through ?? 'start'}_${step}`, attempts: 2 });
  }
}

/**
 * The summary covers the conversation up to `through`; the model sees every answered message after
 * it — at least `min` (recent turns stay verbatim even when summarized), at most twice that.
 */
function selectHistory(recent: MessageView[], answeredCount: number, through: string | null, messageCount: number, min: number) {
  const idx = through ? recent.findIndex((m) => m.id === through) : -1;
  // Unsummarized overall: past the summary point, or everything loaded when that point is older still.
  const unsummarized = idx >= 0 ? recent.length - 1 - idx : through ? recent.length : messageCount;
  const unsummarizedAnswered = idx >= 0 ? Math.max(0, answeredCount - 1 - idx) : answeredCount;
  const size = Math.min(Math.max(unsummarizedAnswered, min), min * 2);
  return { history: recent.slice(0, answeredCount).slice(-size), unsummarized };
}

// Words that close or greet (at least one must appear), and the fillers that may come with them.
// A bare "yes" or "ok" is not small talk: it often answers a question the bot just asked.
const GREETINGS_AND_THANKS = new Set(
  `hi hii hey hello hiya morning afternoon evening night thanks thank thx ty tysm cheers bye goodbye cya great nice perfect awesome
   excellent cool wonderful appreciate appreciated hola buenos buenas gracias adios adiós chao perfecto genial namaste namaskar
   dhanyavad dhanyavaad shukriya नमस्ते नमस्कार धन्यवाद शुक्रिया`.split(/\s+/),
);
const FILLERS = new Set(
  `good you u so much very lot lots a that thats that's is it for your help again all sounds ok okay okey k kk sure yes yeah yep yup
   ya no nope nah alright fine got noted please pls np lol haha oh ah wow dias días tardes noches muchas vale si sí claro bueno de
   nada theek thik hai haan ji bilkul ठीक है हाँ हां जी`.split(/\s+/),
);

/** Greetings, thanks and goodbyes: nothing to look up in the business's documents. */
export function isSmallTalk(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Emoji or punctuation only: small talk, unless it's a bare "?" about what was said before.
  if (!words.length) return !text.includes('?');
  return words.length <= 8 && words.some((w) => GREETINGS_AND_THANKS.has(w)) && words.every((w) => GREETINGS_AND_THANKS.has(w) || FILLERS.has(w));
}

/** Thrown at a checkpoint once the turn's time limit or lock is gone; the catch works out which. */
class TurnStopped extends Error {}

export function matchesHandoffKeyword(text: string, keywords: string[]): boolean {
  const normalized = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;
  return keywords.some((k) => {
    const needle = k.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    return needle.length > 0 && normalized.includes(` ${needle} `);
  });
}

/** Very short follow-ups ("and on weekends?") retrieve better with the previous customer message attached. */
function retrievalQuery(pendingText: string, history: MessageView[]): string {
  if (pendingText.split(/\s+/).length >= 5) return pendingText;
  const previous = [...history].reverse().find((m) => m.senderType === 'contact');
  return previous ? `${previous.content}\n${pendingText}` : pendingText;
}

function missingLeadFields(
  bot: BotView,
  contact: { firstName: string | null; email: string | null; phone: string | null; company: string | null; customFields: Record<string, unknown> },
  labels: Map<string, string>,
): string[] {
  if (!bot.config.leadCapture.enabled) return [];
  return bot.config.leadCapture.fields
    .filter((f) => {
      if (f.field === 'name') return !contact.firstName;
      if ((STANDARD_LEAD_FIELDS as readonly string[]).includes(f.field)) return !contact[f.field as 'email' | 'phone' | 'company'];
      const v = contact.customFields[f.field];
      return v === undefined || v === null || v === '';
    })
    .map((f) => `${f.field === 'name' ? 'name' : (labels.get(f.field) ?? f.field)}${f.required ? ' (required)' : ''}`);
}

/** Picks up chunks returned by search_knowledge_base so they are cited on the reply too. */
function collectCitations(toolContent: string, into: Map<string, RetrievedChunk>) {
  try {
    const parsed = JSON.parse(toolContent) as {
      results?: Array<{ source_id: string; document_id: string; title: string; url: string | null }>;
    };
    for (const r of parsed.results ?? []) {
      if (!into.has(r.source_id)) {
        into.set(r.source_id, {
          id: r.source_id,
          documentId: r.document_id,
          knowledgeBaseId: '',
          title: r.title,
          content: '',
          url: r.url,
          category: null,
          similarity: null,
          score: 0,
        });
      }
    }
  } catch {
    // Not a knowledge result.
  }
}

/** Coalesces token deltas so the realtime bus carries a handful of messages per second, not one per token. */
class DeltaBuffer {
  private buf = '';
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly sink: (text: string) => Promise<void>) {}

  push(text: string) {
    this.buf += text;
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 60);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.buf;
    this.buf = '';
    if (text) this.chain = this.chain.then(() => this.sink(text)).catch(() => {});
    return this.chain;
  }
}

