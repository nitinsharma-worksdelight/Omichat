import { sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { rowsOf, type Db } from '../../db/client';
import type { TenantDb } from '../../db/tenant';
import { badRequest } from '../../lib/errors';

/**
 * Reports over a date range in the organization's timezone. Every figure leaves out Test chat (playground)
 * conversations and test contacts, and counts a merged duplicate once (as the contact it was merged into).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const AnalyticsQuerySchema = z.object({
  /** Inclusive local dates (YYYY-MM-DD) in the organization's timezone. Default: the last 30 days. */
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  botId: z.string().uuid().optional(),
  channel: z.string().max(30).optional(),
});
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

/** The team's time one AI reply stands in for, for the AI Agents dashboard's "Time saved" estimate. */
export const MINUTES_PER_AI_REPLY = 2;

/** The longest range a report covers. */
const MAX_DAYS = 366;
/** Ranges longer than this are bucketed by week (weeks start on Monday). */
const DAILY_UP_TO_DAYS = 62;

export interface Range {
  start: Date;
  end: Date;
}

interface Filters {
  botId?: string;
  channel?: string;
}

export interface MetricTotals {
  conversations: number;
  leads: number;
  qualified: number;
  handoffs: number;
  bookings: number;
  dealsWon: number;
  aiReplies: number;
}

const METRICS = ['conversations', 'leads', 'qualified', 'handoffs', 'bookings', 'dealsWon', 'aiReplies'] as const;
type Metric = (typeof METRICS)[number];

/** `[from, to]` as local dates in `timezone` → the instants they span (the end is exclusive). */
export function localRange(timezone: string, from: string, to: string): Range {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timezone }).startOf('day').plus({ days: 1 });
  if (!start.isValid || !end.isValid) throw badRequest('Enter valid dates', [{ path: 'from', message: 'Enter valid dates' }]);
  if (end <= start) throw badRequest('The end date must be on or after the start date', [{ path: 'to', message: 'The end date must be on or after the start date' }]);
  if (end.diff(start, 'days').days > MAX_DAYS) throw badRequest(`A report covers at most ${MAX_DAYS} days`, [{ path: 'to', message: `A report covers at most ${MAX_DAYS} days` }]);
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** This calendar month so far, in the organization's timezone. */
export function monthToDate(timezone: string, now: Date): Range {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  return { start: local.startOf('month').toJSDate(), end: now };
}

export class AnalyticsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Totals for the range and for the same length just before it, a daily (or weekly) series, deal values per
   * currency, and (for those allowed to see it) AI spend.
   */
  async report(orgId: string, timezone: string, q: AnalyticsQuery, opts: { includeCost: boolean }) {
    const today = DateTime.fromJSDate(this.clock(), { zone: timezone }).toISODate()!;
    const to = q.to ?? today;
    const from = q.from ?? DateTime.fromISO(to).minus({ days: 29 }).toISODate()!;
    const range = localRange(timezone, from, to);
    const length = range.end.getTime() - range.start.getTime();
    const previous = { start: new Date(range.start.getTime() - length), end: range.start };
    const days = Math.round(length / 86_400_000);
    const interval: 'day' | 'week' = days > DAILY_UP_TO_DAYS ? 'week' : 'day';
    const filters: Filters = { botId: q.botId, channel: q.channel };

    return this.tenantDb.run(orgId, async (tx) => {
      // One transaction, one query at a time.
      const current = await this.totals(tx, orgId, range, filters);
      const before = await this.totals(tx, orgId, previous, filters);
      const series = await this.series(tx, orgId, range, filters, timezone, interval);
      const deals = await this.dealValues(tx, orgId, range, filters);
      const cost = opts.includeCost ? await this.cost(tx, orgId, range, filters) : null;
      return {
        from,
        to,
        timezone,
        interval,
        filters,
        totals: current,
        previous: before,
        series: fillBuckets(series, timezone, range, interval),
        dealsWonValue: deals,
        aiCostUsd: cost,
      };
    });
  }

  /**
   * The Overview's month-to-date figures (same rules as the report). `cost` is the figure the Analytics page shows
   * for the same days (real conversations only); `spend` is everything the AI cost, which the monthly budget counts.
   */
  async monthToDate(orgId: string, timezone: string, opts: { includeCost: boolean }) {
    const range = monthToDate(timezone, this.clock());
    return this.tenantDb.run(orgId, async (tx) => {
      const totals = await this.totals(tx, orgId, range, {});
      const cost = opts.includeCost ? await this.cost(tx, orgId, range, {}) : null;
      const spend = opts.includeCost ? await this.spend(tx, orgId, range) : null;
      return { since: range.start, totals, cost, spend };
    });
  }

  /**
   * Who and how fast: handoffs (reasons, time to the team's first reply, waits past the limit, chats taken back),
   * each team member's share, the lead funnel and where leads came from, what the AI did, and team approvals.
   */
  async performance(orgId: string, timezone: string, q: AnalyticsQuery, opts: { includeCost: boolean }) {
    const today = DateTime.fromJSDate(this.clock(), { zone: timezone }).toISODate()!;
    const to = q.to ?? today;
    const from = q.from ?? DateTime.fromISO(to).minus({ days: 29 }).toISODate()!;
    const range = localRange(timezone, from, to);
    const f: Filters = { botId: q.botId, channel: q.channel };
    return this.tenantDb.run(orgId, async (tx) => {
      const totals = await this.totals(tx, orgId, range, f);
      const handoffs = await this.handoffs(tx, orgId, range, f);
      const team = await this.team(tx, orgId, range, f);
      const sources = await this.sources(tx, orgId, range, f);
      const actions = await this.actions(tx, orgId, range, f);
      const approvals = await this.approvals(tx, orgId, range, f);
      const cost = opts.includeCost ? await this.cost(tx, orgId, range, f) : null;
      return {
        from,
        to,
        timezone,
        filters: f,
        handoffs,
        team,
        funnel: [
          { step: 'conversations', count: totals.conversations },
          { step: 'leads', count: totals.leads },
          { step: 'qualified', count: totals.qualified },
          { step: 'bookings', count: totals.bookings },
          { step: 'dealsWon', count: totals.dealsWon },
        ],
        sources,
        actions,
        approvals,
        /** Handoffs per conversation started in the range. */
        handoffRate: totals.conversations ? handoffs.total / totals.conversations : null,
        cost:
          cost === null
            ? null
            : {
                totalUsd: cost,
                perConversationUsd: totals.conversations ? cost / totals.conversations : null,
                perLeadUsd: totals.leads ? cost / totals.leads : null,
              },
      };
    });
  }

  /**
   * The AI Agents dashboard: contacts the AI replied to (each counted once), actions it took, appointments it booked
   * and the time that saved the team (an estimate: MINUTES_PER_AI_REPLY per reply), with contacts per day or week.
   */
  async agents(orgId: string, timezone: string, q: AnalyticsQuery) {
    const today = DateTime.fromJSDate(this.clock(), { zone: timezone }).toISODate()!;
    const to = q.to ?? today;
    const from = q.from ?? DateTime.fromISO(to).minus({ days: 29 }).toISODate()!;
    const range = localRange(timezone, from, to);
    const days = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000);
    const interval: 'day' | 'week' = days > DAILY_UP_TO_DAYS ? 'week' : 'day';
    const f: Filters = { botId: q.botId, channel: q.channel };
    const replies = sql`from ai_runs r join conversations c on c.id = r.conversation_id join contacts ct on ct.id = c.contact_id
      where r.organization_id = ${orgId} and c.is_test = false and ct.is_test = false and r.status in ('completed', 'handoff')
        and r.stop_reason is distinct from 'summary' and ${within(sql`r.created_at`, range)} ${conversationFilter(f)}`;
    const contact = sql`coalesce(ct.merged_into_id, ct.id)`;
    return this.tenantDb.run(orgId, async (tx) => {
      const [counts] = rowsOf<{ contacts: number; replies: number }>(
        await tx.execute(sql`select count(distinct ${contact})::int as contacts, count(*)::int as replies ${replies}`),
      );
      const [acts] = rowsOf<{ n: number }>(
        await tx.execute(sql`
          select count(*)::int as n from tool_invocations t join conversations c on c.id = t.conversation_id
          where t.organization_id = ${orgId} and c.is_test = false and t.status = 'success' and ${within(sql`t.created_at`, range)} ${conversationFilter(f)}`),
      );
      const [booked] = rowsOf<{ n: number }>(await tx.execute(sql`select count(*)::int as n ${source('bookings', orgId, range, f)}`));
      const bucket = sql`to_char(date_trunc(${interval}, r.created_at at time zone ${timezone}), 'YYYY-MM-DD')`;
      const perBucket = rowsOf<{ bucket: string; n: number }>(
        await tx.execute(sql`select ${bucket} as bucket, count(distinct ${contact})::int as n ${replies} group by 1`),
      );
      const found = Object.fromEntries(perBucket.map((r) => [r.bucket, { conversations: Number(r.n) }]));
      const aiReplies = Number(counts?.replies ?? 0);
      return {
        from,
        to,
        timezone,
        interval,
        filters: f,
        uniqueContacts: Number(counts?.contacts ?? 0),
        actionsTriggered: Number(acts?.n ?? 0),
        appointmentsBooked: Number(booked?.n ?? 0),
        aiReplies,
        timeSavedMinutes: aiReplies * MINUTES_PER_AI_REPLY,
        minutesPerReply: MINUTES_PER_AI_REPLY,
        series: fillBuckets(found, timezone, range, interval).map((b) => ({ date: b.date, contacts: b.conversations })),
      };
    });
  }

  private async handoffs(tx: Db, orgId: string, range: Range, f: Filters) {
    // Each handoff to the team, with the first staff message after it. Staff taking over by hand are already answering,
    // so only the AI's handoffs count towards response times.
    const base = sql`
      from events e join conversations c on c.id = e.conversation_id
      left join lateral (
        select min(m.created_at) as at from messages m
        where m.conversation_id = e.conversation_id and m.sender_type = 'human' and m.created_at >= e.created_at
      ) reply on true
      where e.organization_id = ${orgId} and e.type = 'conversation.handoff_requested' and c.is_test = false
        and ${within(sql`e.created_at`, range)} ${conversationFilter(f)}`;
    const [row] = rowsOf<{ total: number; by_ai: number; by_staff: number; answered: number; median: number | null; p90: number | null }>(
      await tx.execute(sql`
        select count(*)::int as total,
          count(*) filter (where e.actor <> 'user')::int as by_ai,
          count(*) filter (where e.actor = 'user')::int as by_staff,
          count(reply.at) filter (where e.actor <> 'user')::int as answered,
          percentile_cont(0.5) within group (order by extract(epoch from reply.at - e.created_at)) filter (where e.actor <> 'user' and reply.at is not null) as median,
          percentile_cont(0.9) within group (order by extract(epoch from reply.at - e.created_at)) filter (where e.actor <> 'user' and reply.at is not null) as p90
        ${base}`),
    );
    const reasons = rowsOf<{ reason: string; count: number }>(
      await tx.execute(sql`
        select coalesce(nullif(e.payload->>'reason', ''), 'No reason given') as reason, count(*)::int as count
        ${base} group by 1 order by 2 desc, 1 limit 10`),
    );
    const [later] = rowsOf<{ overdue: number; taken_back: number }>(
      await tx.execute(sql`
        select count(*) filter (where e.type = 'conversation.handoff_overdue')::int as overdue,
          count(*) filter (where e.type = 'conversation.resumed_by_ai' and e.actor = 'system')::int as taken_back
        from events e join conversations c on c.id = e.conversation_id
        where e.organization_id = ${orgId} and e.type in ('conversation.handoff_overdue', 'conversation.resumed_by_ai') and c.is_test = false
          and ${within(sql`e.created_at`, range)} ${conversationFilter(f)}`),
    );
    const byAi = Number(row?.by_ai ?? 0);
    const answered = Number(row?.answered ?? 0);
    return {
      total: Number(row?.total ?? 0),
      byAi,
      takenOverByStaff: Number(row?.by_staff ?? 0),
      answered,
      unanswered: byAi - answered,
      /** Seconds from the handoff to the team's first reply (AI handoffs that got one). */
      firstReplySeconds: { median: secondsOrNull(row?.median), p90: secondsOrNull(row?.p90) },
      waitedTooLong: Number(later?.overdue ?? 0),
      takenBackByAi: Number(later?.taken_back ?? 0),
      reasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    };
  }

  /** Per team member: chats assigned to them, replies they sent, chats they answered, and how fast after a handoff. */
  private async team(tx: Db, orgId: string, range: Range, f: Filters) {
    const rows = rowsOf<{ user_id: string; name: string; assigned: number; replies: number; conversations: number; median: number | null }>(
      await tx.execute(sql`
        with members as (
          select u.id, coalesce(nullif(u.name, ''), u.email) as name from memberships ms join users u on u.id = ms.user_id
          where ms.organization_id = ${orgId}
        ),
        assigned as (
          select (e.payload->>'assignedUserId')::uuid as user_id, count(*)::int as n
          from events e join conversations c on c.id = e.conversation_id
          where e.organization_id = ${orgId} and e.type = 'conversation.assigned' and e.payload->>'assignedUserId' is not null
            and c.is_test = false and ${within(sql`e.created_at`, range)} ${conversationFilter(f)}
          group by 1
        ),
        replies as (
          select m.sender_user_id as user_id, count(*)::int as n, count(distinct m.conversation_id)::int as conversations
          from messages m join conversations c on c.id = m.conversation_id
          where c.organization_id = ${orgId} and m.sender_type = 'human' and m.sender_user_id is not null and c.is_test = false
            and ${within(sql`m.created_at`, range)} ${conversationFilter(f)}
          group by 1
        ),
        first_replies as (
          select r.sender_user_id as user_id, extract(epoch from r.created_at - e.created_at) as seconds
          from events e join conversations c on c.id = e.conversation_id
          join lateral (
            select m.created_at, m.sender_user_id from messages m
            where m.conversation_id = e.conversation_id and m.sender_type = 'human' and m.created_at >= e.created_at
            order by m.created_at limit 1
          ) r on true
          where e.organization_id = ${orgId} and e.type = 'conversation.handoff_requested' and e.actor <> 'user' and c.is_test = false
            and ${within(sql`e.created_at`, range)} ${conversationFilter(f)}
        )
        select m.id as user_id, m.name, coalesce(a.n, 0) as assigned, coalesce(r.n, 0) as replies, coalesce(r.conversations, 0) as conversations,
          (select percentile_cont(0.5) within group (order by fr.seconds) from first_replies fr where fr.user_id = m.id) as median
        from members m left join assigned a on a.user_id = m.id left join replies r on r.user_id = m.id
        order by coalesce(r.n, 0) desc, coalesce(a.n, 0) desc, m.name`),
    );
    return rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      assigned: Number(r.assigned),
      replies: Number(r.replies),
      conversations: Number(r.conversations),
      firstReplyMedianSeconds: secondsOrNull(r.median),
    }));
  }

  /** Where the period's leads came from: campaign tag, ad click, referring site, or direct. */
  private async sources(tx: Db, orgId: string, range: Range, f: Filters) {
    const rows = rowsOf<{ source: string; campaign: string | null; channel: string | null; count: number }>(
      await tx.execute(sql`
        select
          case
            when ct.first_touch->>'utmSource' is not null then lower(ct.first_touch->>'utmSource')
            when ct.first_touch->>'gclid' is not null then 'google ads'
            when ct.first_touch->>'fbclid' is not null then 'meta ads'
            when ct.first_touch->>'msclkid' is not null then 'microsoft ads'
            when ct.first_touch->>'referrer' is not null then substring(ct.first_touch->>'referrer' from '^https?://(?:www\.)?([^/:]+)')
            else 'direct'
          end as source,
          ct.first_touch->>'utmCampaign' as campaign,
          ct.source_channel as channel,
          count(*)::int as count
        from contacts ct
        where ct.organization_id = ${orgId} and ct.is_test = false and ct.merged_into_id is null and ${within(sql`ct.lead_captured_at`, range)}
          ${filtered(f) ? sql`and exists (select 1 from conversations c where c.contact_id = ct.id and c.is_test = false ${conversationFilter(f)})` : sql``}
        group by 1, 2, 3 order by 4 desc, 1 limit 50`),
    );
    return rows.map((r) => ({ source: r.source ?? 'direct', campaign: r.campaign, channel: r.channel, count: Number(r.count) }));
  }

  /** What the AI did: each tool's calls, and how many failed or were refused. */
  private async actions(tx: Db, orgId: string, range: Range, f: Filters) {
    const rows = rowsOf<{ tool: string; calls: number; failed: number; waiting: number }>(
      await tx.execute(sql`
        select t.tool_name as tool, count(*)::int as calls,
          count(*) filter (where t.status in ('error', 'rejected'))::int as failed,
          count(*) filter (where t.status = 'pending')::int as waiting
        from tool_invocations t join conversations c on c.id = t.conversation_id
        where t.organization_id = ${orgId} and c.is_test = false and t.status <> 'replayed' and ${within(sql`t.created_at`, range)} ${conversationFilter(f)}
        group by 1 order by 2 desc, 1`),
    );
    return rows.map((r) => ({ tool: r.tool, calls: Number(r.calls), failed: Number(r.failed), askedTeam: Number(r.waiting) }));
  }

  /** Ask-first requests made in the range, by what became of them. */
  private async approvals(tx: Db, orgId: string, range: Range, f: Filters) {
    const now = this.clock().toISOString();
    const [row] = rowsOf<{ approved: number; declined: number; waiting: number; expired: number }>(
      await tx.execute(sql`
        select
          count(*) filter (where a.status = 'approved')::int as approved,
          count(*) filter (where a.status = 'rejected')::int as declined,
          count(*) filter (where a.status in ('pending', 'running') and a.expires_at > ${now}::timestamptz)::int as waiting,
          count(*) filter (where a.status = 'pending' and a.expires_at <= ${now}::timestamptz)::int as expired
        from action_approvals a join conversations c on c.id = a.conversation_id
        where a.organization_id = ${orgId} and c.is_test = false and ${within(sql`a.created_at`, range)} ${conversationFilter(f)}`),
    );
    return {
      approved: Number(row?.approved ?? 0),
      declined: Number(row?.declined ?? 0),
      waiting: Number(row?.waiting ?? 0),
      expired: Number(row?.expired ?? 0),
    };
  }

  private async totals(tx: Db, orgId: string, range: Range, f: Filters): Promise<MetricTotals> {
    const out = {} as MetricTotals;
    for (const metric of METRICS) {
      const [row] = rowsOf<{ n: number }>(await tx.execute(sql`select ${aggregate(metric)}::int as n ${source(metric, orgId, range, f)}`));
      out[metric] = Number(row?.n ?? 0);
    }
    return out;
  }

  private async series(tx: Db, orgId: string, range: Range, f: Filters, timezone: string, interval: 'day' | 'week') {
    const result: Record<string, Partial<Record<Metric, number>>> = {};
    for (const metric of METRICS) {
      const bucket = sql`to_char(date_trunc(${interval}, ${dateColumn(metric)} at time zone ${timezone}), 'YYYY-MM-DD')`;
      const rows = rowsOf<{ bucket: string; n: number }>(
        await tx.execute(sql`select ${bucket} as bucket, ${aggregate(metric)}::int as n ${source(metric, orgId, range, f)} group by 1`),
      );
      for (const r of rows) (result[r.bucket] ??= {})[metric] = Number(r.n);
    }
    return result;
  }

  /** Won deal value, per currency (never added across currencies). */
  private async dealValues(tx: Db, orgId: string, range: Range, f: Filters) {
    const rows = rowsOf<{ currency: string; value: string }>(
      await tx.execute(sql`select d.currency, coalesce(sum(d.value), 0) as value ${source('dealsWon', orgId, range, f)} group by d.currency order by d.currency`),
    );
    return rows.map((r) => ({ currency: r.currency, value: Number(r.value) }));
  }

  /** What the AI cost on real (non-test) conversations in the range, replies and summaries alike. */
  private async cost(tx: Db, orgId: string, range: Range, f: Filters): Promise<number> {
    const [row] = rowsOf<{ cost: string }>(
      await tx.execute(sql`
        select coalesce(sum(r.cost_usd), 0) as cost
        from ai_runs r join conversations c on c.id = r.conversation_id
        where r.organization_id = ${orgId} and c.is_test = false
          and r.created_at >= ${range.start.toISOString()}::timestamptz and r.created_at < ${range.end.toISOString()}::timestamptz
          ${conversationFilter(f)}`),
    );
    return Number(row?.cost ?? 0);
  }

  /** Everything the AI cost this month, Test chats included: what the monthly budget counts. */
  private async spend(tx: Db, orgId: string, range: Range) {
    const [row] = rowsOf<{ runs: number; cost: string; input: number; output: number; cache_read: number }>(
      await tx.execute(sql`
        select count(*)::int as runs, coalesce(sum(cost_usd), 0) as cost,
          coalesce(sum(input_tokens), 0)::int as input, coalesce(sum(output_tokens), 0)::int as output,
          coalesce(sum(cache_read_tokens), 0)::int as cache_read
        from ai_runs
        where organization_id = ${orgId}
          and created_at >= ${range.start.toISOString()}::timestamptz and created_at < ${range.end.toISOString()}::timestamptz`),
    );
    return {
      runs: Number(row?.runs ?? 0),
      costUsd: Number(row?.cost ?? 0),
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      cacheReadTokens: Number(row?.cache_read ?? 0),
    };
  }
}

function secondsOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Math.round(Number(v));
}

/** Bot and channel filters on a conversations alias `c`. */
function conversationFilter(f: Filters): SQL {
  return sql`${f.botId ? sql`and c.bot_id = ${f.botId}` : sql``} ${f.channel ? sql`and c.channel = ${f.channel}` : sql``}`;
}

const filtered = (f: Filters) => Boolean(f.botId || f.channel);

function within(column: SQL, range: Range): SQL {
  return sql`${column} >= ${range.start.toISOString()}::timestamptz and ${column} < ${range.end.toISOString()}::timestamptz`;
}

/** The moment each metric is counted at. */
function dateColumn(metric: Metric): SQL {
  switch (metric) {
    case 'conversations':
      return sql`c.created_at`;
    case 'leads':
      return sql`ct.lead_captured_at`;
    case 'qualified':
    case 'handoffs':
      return sql`e.created_at`;
    case 'bookings':
      return sql`a.created_at`;
    case 'dealsWon':
      return sql`d.closed_at`;
    case 'aiReplies':
      return sql`r.created_at`;
  }
}

function aggregate(metric: Metric): SQL {
  // A lead qualified twice (or a duplicate and the contact it was merged into) counts once.
  return metric === 'qualified' ? sql`count(distinct coalesce(ct.merged_into_id, ct.id))` : sql`count(*)`;
}

/** `from … where …` for one metric, with the test, merge, range and bot/channel rules applied. */
function source(metric: Metric, orgId: string, range: Range, f: Filters): SQL {
  const when = within(dateColumn(metric), range);
  switch (metric) {
    case 'conversations':
      return sql`from conversations c where c.organization_id = ${orgId} and c.is_test = false and ${when} ${conversationFilter(f)}`;
    case 'leads':
      // A lead belongs to a bot or channel when it has a conversation there.
      return sql`from contacts ct where ct.organization_id = ${orgId} and ct.is_test = false and ct.merged_into_id is null and ${when}
        ${filtered(f) ? sql`and exists (select 1 from conversations c where c.contact_id = ct.id and c.is_test = false ${conversationFilter(f)})` : sql``}`;
    case 'qualified':
      return sql`from events e join contacts ct on ct.id = e.contact_id left join conversations c on c.id = e.conversation_id
        where e.organization_id = ${orgId} and e.type = 'lead.qualified' and ct.is_test = false and coalesce(c.is_test, false) = false and ${when}
        ${filtered(f) ? sql`and c.id is not null ${conversationFilter(f)}` : sql``}`;
    case 'handoffs':
      return sql`from events e join conversations c on c.id = e.conversation_id
        where e.organization_id = ${orgId} and e.type = 'conversation.handoff_requested' and c.is_test = false and ${when} ${conversationFilter(f)}`;
    case 'bookings':
      // Booked by the AI and not cancelled since.
      return sql`from appointments a join contacts ct on ct.id = a.contact_id left join conversations c on c.id = a.conversation_id
        where a.organization_id = ${orgId} and a.created_by = 'ai' and a.status <> 'cancelled' and ct.is_test = false and ${when}
        ${filtered(f) ? sql`and c.id is not null ${conversationFilter(f)}` : sql``}`;
    case 'dealsWon':
      return sql`from deals d join contacts ct on ct.id = d.contact_id left join conversations c on c.id = d.conversation_id
        where d.organization_id = ${orgId} and d.status = 'won' and ct.is_test = false and ${when}
        ${filtered(f) ? sql`and c.id is not null ${conversationFilter(f)}` : sql``}`;
    case 'aiReplies':
      // Replies only: summaries, failed and skipped runs aren't replies.
      return sql`from ai_runs r join conversations c on c.id = r.conversation_id
        where r.organization_id = ${orgId} and c.is_test = false and r.status in ('completed', 'handoff')
          and r.stop_reason is distinct from 'summary' and ${when} ${conversationFilter(f)}`;
  }
}

/** One entry per day (or week) of the range, zeros included, oldest first. */
function fillBuckets(found: Record<string, Partial<Record<Metric, number>>>, timezone: string, range: Range, interval: 'day' | 'week') {
  const out: Array<{ date: string } & MetricTotals> = [];
  let cursor = DateTime.fromJSDate(range.start, { zone: timezone }).startOf(interval === 'week' ? 'week' : 'day');
  const end = DateTime.fromJSDate(range.end, { zone: timezone });
  while (cursor < end) {
    const key = cursor.toISODate()!;
    const row = found[key] ?? {};
    out.push({
      date: key,
      conversations: row.conversations ?? 0,
      leads: row.leads ?? 0,
      qualified: row.qualified ?? 0,
      handoffs: row.handoffs ?? 0,
      bookings: row.bookings ?? 0,
      dealsWon: row.dealsWon ?? 0,
      aiReplies: row.aiReplies ?? 0,
    });
    cursor = cursor.plus(interval === 'week' ? { weeks: 1 } : { days: 1 });
  }
  return out;
}
