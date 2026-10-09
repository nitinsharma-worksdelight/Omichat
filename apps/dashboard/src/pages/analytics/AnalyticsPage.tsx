import { useQuery } from '@tanstack/react-query';
import { Download, CalendarCheck, CircleAlert, CircleDollarSign, Hand, Handshake, MessagesSquare, Sparkles, Star, UserPlus } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/feedback-context';
import { DeltaPill, StatValue, type StatTone } from '../../components/stats';
import { Button, Card, CardHeader, cx, ErrorBanner, Input, PageHeader, Select, Skeleton } from '../../components/ui';
import { download, get } from '../../lib/api';
import { formatNumber, formatUsd } from '../../lib/format';
import { roleAtLeast, useBots, useChannels, useOrg } from '../../lib/queries';
import { reportRangeProblem } from '../../lib/validate';
import { navigate, useRoute, withQuery } from '../../lib/router';
import type { AnalyticsMetric, AnalyticsReport } from '../../lib/types';
import { Performance } from './Performance';

// The tile tone says what each number is about: ai and human mark who acted.
const METRICS: Array<{ key: AnalyticsMetric; label: string; icon: ReactNode; tone: StatTone; hint: string }> = [
  { key: 'conversations', label: 'Conversations', icon: <MessagesSquare />, tone: 'neutral', hint: 'Started in the period' },
  { key: 'leads', label: 'Leads captured', icon: <UserPlus />, tone: 'brand', hint: 'Became a lead in the period' },
  { key: 'qualified', label: 'Qualified', icon: <Star />, tone: 'success', hint: 'Became qualified in the period' },
  { key: 'bookings', label: 'AI bookings', icon: <CalendarCheck />, tone: 'ai', hint: 'Booked by the assistant, not cancelled' },
  { key: 'handoffs', label: 'Handoffs', icon: <Hand />, tone: 'human', hint: 'Times a chat went to your team' },
  { key: 'dealsWon', label: 'Deals won', icon: <Handshake />, tone: 'success', hint: 'Closed as won in the period' },
  { key: 'aiReplies', label: 'AI replies', icon: <Sparkles />, tone: 'ai', hint: 'Replies the assistant sent' },
];

const PRESETS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
] as const;

/** Today as YYYY-MM-DD in `timezone`. */
export function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The local dates a preset covers, as of today in the organization's timezone. */
function presetRange(preset: string, timezone: string): { from: string; to: string } {
  const today = todayIn(timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (preset) {
    case '7d':
      return { from: shift(today, -6), to: today };
    case '90d':
      return { from: shift(today, -89), to: today };
    case 'month':
      return { from: monthStart, to: today };
    case 'last-month': {
      const end = shift(monthStart, -1);
      return { from: `${end.slice(0, 8)}01`, to: end };
    }
    default:
      return { from: shift(today, -29), to: today };
  }
}

export function AnalyticsPage() {
  const route = useRoute();
  const toast = useToast();
  const { role } = useAuth();
  const org = useOrg();
  const bots = useBots();
  const channels = useChannels();
  const timezone = org.data?.timezone ?? 'UTC';
  const preset = route.query.get('range') ?? '30d';
  const custom = preset === 'custom';
  const fallback = presetRange(custom ? '30d' : preset, timezone);
  const from = custom ? (route.query.get('from') ?? fallback.from) : fallback.from;
  const to = custom ? (route.query.get('to') ?? fallback.to) : fallback.to;
  const botId = route.query.get('bot') ?? '';
  const channel = route.query.get('channel') ?? '';
  const metric = (route.query.get('metric') as AnalyticsMetric | null) ?? 'conversations';
  const setQuery = (changes: Record<string, string | null>) => navigate(withQuery(route, changes), { replace: true });
  // A period that ends before it starts (typed in, or from an old link) isn't sent: the page says what to fix instead.
  const rangeProblem = reportRangeProblem(from, to);

  const report = useQuery({
    queryKey: ['analytics', { from, to, botId, channel }],
    queryFn: () => get<AnalyticsReport>('/v1/analytics', { from, to, botId: botId || undefined, channel: channel || undefined }),
    enabled: Boolean(org.data) && !rangeProblem,
  });
  const channelTypes = useMemo(
    () => [...new Set((channels.data ?? []).map((c) => c.channel).filter((c) => c !== 'playground'))],
    [channels.data],
  );
  const data = rangeProblem ? undefined : report.data;
  const periodLabel = custom ? `${from} to ${to}` : (PRESETS.find((p) => p.value === preset)?.label ?? 'Last 30 days');
  const selected = METRICS.find((m) => m.key === metric) ?? METRICS[0]!;

  return (
    <div>
      <PageHeader title="Analytics" description={`How your assistants are doing. Days are counted in ${timezone}; Test chats are left out.`} />
      <div className="space-y-6 px-4 sm:px-8 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Period" className="w-40" value={preset} onChange={(e) => setQuery({ range: e.target.value, from: e.target.value === 'custom' ? from : null, to: e.target.value === 'custom' ? to : null })}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          {custom && (
            <>
              <Input type="date" aria-label="From" className="w-40" invalid={Boolean(rangeProblem)} value={from} max={to} onChange={(e) => e.target.value && setQuery({ from: e.target.value })} />
              <Input type="date" aria-label="To" className="w-40" invalid={Boolean(rangeProblem)} value={to} min={from} onChange={(e) => e.target.value && setQuery({ to: e.target.value })} />
            </>
          )}
          <Select aria-label="Bot" className="w-48" value={botId} onChange={(e) => setQuery({ bot: e.target.value || null })}>
            <option value="">All bots</option>
            {(bots.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Channel" className="w-40" value={channel} onChange={(e) => setQuery({ channel: e.target.value || null })}>
            <option value="">All channels</option>
            {channelTypes.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c] ?? c}
              </option>
            ))}
          </Select>
        </div>

        {rangeProblem ? (
          <p role="alert" className="flex items-start gap-1.5 text-body-sm text-danger-text">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {rangeProblem}
          </p>
        ) : null}
        {report.error && !rangeProblem ? <ErrorBanner error={report.error} onRetry={() => void report.refetch()} /> : null}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {METRICS.map((m) => (
            <MetricCard
              key={m.key}
              label={m.label}
              icon={m.icon}
              tone={m.tone}
              hint={m.hint}
              loading={report.isLoading && !rangeProblem}
              value={data?.totals[m.key]}
              previous={data?.previous[m.key]}
              selected={m.key === selected.key}
              onSelect={() => setQuery({ metric: m.key })}
            />
          ))}
          {roleAtLeast(role, 'admin') && (
            <Card className="px-5 py-4.5">
              <StatValue
                icon={<CircleDollarSign />}
                tone="ai"
                label="AI cost"
                loading={report.isLoading && !rangeProblem}
                value={data ? formatUsd(data.aiCostUsd ?? 0) : '—'}
                // The period is named: Overview's AI cost is this month so far, which is a different period from "Last 30 days".
                footer={`${periodLabel} · Admins only · Test chats left out`}
              />
            </Card>
          )}
        </div>

        <Card>
          <CardHeader
            actions={
              roleAtLeast(role, 'admin') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Download className="size-3.5" />}
                  onClick={() => void download('/v1/analytics/export', { from, to, botId: botId || undefined, channel: channel || undefined, report: 'daily' }).catch((e) => toast.error(e))}
                >
                  CSV
                </Button>
              ) : undefined
            }
            title={`${selected.label} by ${data?.interval === 'week' ? 'week' : 'day'}`}
            description={data?.dealsWonValue.length && selected.key === 'dealsWon' ? `Won value: ${data.dealsWonValue.map((d) => formatMoney(d.value, d.currency)).join(' · ')}` : selected.hint}
          />
          <div className="px-5 pt-4 pb-5">
            {rangeProblem ? (
              <p className="flex h-56 items-center justify-center text-body-sm text-muted">Fix the dates above to see the chart.</p>
            ) : report.isLoading || !data ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <BarChart label={selected.label} points={data.series.map((p) => ({ date: p.date, value: p[selected.key] }))} weekly={data.interval === 'week'} />
            )}
          </div>
        </Card>

        {!rangeProblem && <Performance from={from} to={to} botId={botId} channel={channel} isAdmin={roleAtLeast(role, 'admin')} />}
      </div>
    </div>
  );
}

const CHANNEL_LABEL: Record<string, string> = { webchat: 'Website chat', api: 'Chat API', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

function MetricCard({
  label,
  icon,
  tone,
  hint,
  value,
  previous,
  loading,
  selected,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  tone: StatTone;
  hint: string;
  value: number | undefined;
  previous: number | undefined;
  loading: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const change = value === undefined || previous === undefined ? null : previous === 0 ? (value === 0 ? 0 : null) : (value - previous) / previous;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={hint}
      className={cx(
        'rounded-xl border bg-surface px-5 py-4.5 text-left shadow-card transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent ring-3 ring-accent/15' : 'border-border hover:border-border-strong',
      )}
    >
      <StatValue
        icon={icon}
        tone={tone}
        label={label}
        loading={loading}
        value={formatNumber(value)}
        footer={
          loading ? (
            <span aria-hidden>&nbsp;</span>
          ) : change === null ? (
            previous === 0 && value ? 'New this period' : 'No earlier data'
          ) : change === 0 ? (
            'Same as before'
          ) : (
            <span className="flex items-center gap-1.5">
              <DeltaPill change={change} />
              vs previous period
            </span>
          )
        }
      />
    </button>
  );
}

/** A plain SVG bar chart that scales to its box and follows the theme's colours. */
export function BarChart({ label, points, weekly }: { label: string; points: Array<{ date: string; value: number }>; weekly: boolean }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const width = 720;
  const height = 220;
  const left = 32;
  const bottom = 22;
  const plotW = width - left - 8;
  const plotH = height - bottom - 8;
  const slot = plotW / Math.max(1, points.length);
  const bar = Math.max(2, Math.min(28, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const total = points.reduce((s, p) => s + p.value, 0);
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img" aria-label={`${label}: ${total} in total over ${points.length} ${weekly ? 'weeks' : 'days'}`}>
        {ticks.map((t) => {
          const y = 8 + plotH - (t / top) * plotH;
          return (
            <g key={t} className="text-border">
              <line x1={left} x2={width - 8} y1={y} y2={y} stroke="currentColor" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3 4'} />
              <text x={left - 6} y={y + 3} textAnchor="end" className="fill-current text-[10px] text-muted">
                {t}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const h = (p.value / top) * plotH;
          const x = left + i * slot + (slot - bar) / 2;
          return (
            <g key={p.date}>
              <rect x={x} y={8 + plotH - h} width={bar} height={Math.max(h, p.value ? 1 : 0)} rx={Math.min(4, bar / 3)} className="fill-current text-accent transition-opacity hover:opacity-80">
                <title>{`${weekly ? 'Week of ' : ''}${fmt(p.date)}: ${p.value}`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={left + i * slot + slot / 2} y={height - 6} textAnchor="middle" className="fill-current text-[10px] text-muted">
                  {fmt(p.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** 0 and up to four round steps at or above `max`. */
function niceTicks(max: number): number[] {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const unit = Math.max(1, Math.ceil(step));
  const out: number[] = [];
  for (let v = 0; v < max + unit; v += unit) {
    out.push(v);
    if (v >= max) break;
  }
  return out;
}
