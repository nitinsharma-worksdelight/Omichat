import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Download, CalendarCheck, CircleDollarSign, Hand, Handshake, MessagesSquare, Sparkles, Star, UserPlus } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/feedback-context';
import { Button, Card, CardHeader, cx, ErrorBanner, Input, PageHeader, Select, Skeleton } from '../../components/ui';
import { download, get } from '../../lib/api';
import { formatNumber, formatUsd } from '../../lib/format';
import { roleAtLeast, useBots, useChannels, useOrg } from '../../lib/queries';
import { navigate, useRoute, withQuery } from '../../lib/router';
import type { AnalyticsMetric, AnalyticsReport } from '../../lib/types';
import { Performance } from './Performance';

const METRICS: Array<{ key: AnalyticsMetric; label: string; icon: ReactNode; hint: string }> = [
  { key: 'conversations', label: 'Conversations', icon: <MessagesSquare className="size-4" />, hint: 'Started in the period' },
  { key: 'leads', label: 'Leads captured', icon: <UserPlus className="size-4" />, hint: 'Became a lead in the period' },
  { key: 'qualified', label: 'Qualified', icon: <Star className="size-4" />, hint: 'Became qualified in the period' },
  { key: 'bookings', label: 'AI bookings', icon: <CalendarCheck className="size-4" />, hint: 'Booked by the assistant, not cancelled' },
  { key: 'handoffs', label: 'Handoffs', icon: <Hand className="size-4" />, hint: 'Times a chat went to your team' },
  { key: 'dealsWon', label: 'Deals won', icon: <Handshake className="size-4" />, hint: 'Closed as won in the period' },
  { key: 'aiReplies', label: 'AI replies', icon: <Sparkles className="size-4" />, hint: 'Replies the assistant sent' },
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
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function shift(day: string, days: number): string {
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

  const report = useQuery({
    queryKey: ['analytics', { from, to, botId, channel }],
    queryFn: () => get<AnalyticsReport>('/v1/analytics', { from, to, botId: botId || undefined, channel: channel || undefined }),
    enabled: Boolean(org.data),
  });
  const channelTypes = useMemo(
    () => [...new Set((channels.data ?? []).map((c) => c.channel).filter((c) => c !== 'playground'))],
    [channels.data],
  );
  const data = report.data;
  const selected = METRICS.find((m) => m.key === metric) ?? METRICS[0]!;

  return (
    <div>
      <PageHeader title="Analytics" description={`How your assistants are doing. Days are counted in ${timezone}; Test chats are left out.`} />
      <div className="space-y-6 px-8 py-6">
        <div className="flex flex-wrap items-end gap-3">
          <Select aria-label="Period" className="w-40" value={preset} onChange={(e) => setQuery({ range: e.target.value, from: e.target.value === 'custom' ? from : null, to: e.target.value === 'custom' ? to : null })}>
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          {custom && (
            <>
              <Input type="date" aria-label="From" className="w-40" value={from} max={to} onChange={(e) => e.target.value && setQuery({ from: e.target.value })} />
              <Input type="date" aria-label="To" className="w-40" value={to} min={from} onChange={(e) => e.target.value && setQuery({ to: e.target.value })} />
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

        {report.error ? <ErrorBanner error={report.error} onRetry={() => void report.refetch()} /> : null}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {METRICS.map((m) => (
            <MetricCard
              key={m.key}
              label={m.label}
              icon={m.icon}
              hint={m.hint}
              loading={report.isLoading}
              value={data?.totals[m.key]}
              previous={data?.previous[m.key]}
              selected={m.key === selected.key}
              onSelect={() => setQuery({ metric: m.key })}
            />
          ))}
          {roleAtLeast(role, 'admin') && (
            <Card className="p-4">
              <div className="flex items-center gap-2 text-muted">
                <CircleDollarSign className="size-4" />
                <span className="text-xs font-medium">AI cost</span>
              </div>
              {report.isLoading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className="mt-1.5 text-2xl font-semibold text-fg tabular-nums">{formatUsd(data?.aiCostUsd ?? 0)}</p>}
              <p className="mt-1 text-xs text-muted">Admins only · Test chats left out</p>
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
          <div className="px-5 pb-5">
            {report.isLoading || !data ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <BarChart label={selected.label} points={data.series.map((p) => ({ date: p.date, value: p[selected.key] }))} weekly={data.interval === 'week'} />
            )}
          </div>
        </Card>

        <Performance from={from} to={to} botId={botId} channel={channel} isAdmin={roleAtLeast(role, 'admin')} />
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
  hint,
  value,
  previous,
  loading,
  selected,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
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
        'rounded-xl border bg-surface p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
        selected ? 'border-accent' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      {loading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className="mt-1.5 text-2xl font-semibold text-fg tabular-nums">{formatNumber(value)}</p>}
      <p className="mt-1 flex items-center gap-1 text-xs text-muted">
        {loading ? (
          ' '
        ) : change === null ? (
          previous === 0 && value ? 'New this period' : 'No earlier data'
        ) : change === 0 ? (
          'Same as before'
        ) : (
          <>
            <span className={cx('inline-flex items-center gap-0.5 font-medium', change > 0 ? 'text-success' : 'text-danger')}>
              {change > 0 ? <ArrowUpRight className="size-3.5" aria-hidden /> : <ArrowDownRight className="size-3.5" aria-hidden />}
              {Math.abs(Math.round(change * 100))}%
            </span>
            vs previous period
          </>
        )}
      </p>
    </button>
  );
}

/** A plain SVG bar chart that scales to its box and follows the theme's colours. */
function BarChart({ label, points, weekly }: { label: string; points: Array<{ date: string; value: number }>; weekly: boolean }) {
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
              <line x1={left} x2={width - 8} y1={y} y2={y} stroke="currentColor" strokeWidth={1} />
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
              <rect x={x} y={8 + plotH - h} width={bar} height={Math.max(h, p.value ? 1 : 0)} rx={2} className="fill-current text-accent">
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
