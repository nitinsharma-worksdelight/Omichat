import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { useToast } from '../../components/feedback-context';
import { Button, Card, CardHeader, EmptyState, ErrorBanner, SkeletonRows, Table, TD, TH } from '../../components/ui';
import { download, get } from '../../lib/api';
import { formatNumber, formatUsd } from '../../lib/format';
import type { AnalyticsPerformance } from '../../lib/types';

interface Props {
  from: string;
  to: string;
  botId: string;
  channel: string;
  isAdmin: boolean;
}

const FUNNEL_LABEL: Record<AnalyticsPerformance['funnel'][number]['step'], string> = {
  conversations: 'Conversations',
  leads: 'Leads',
  qualified: 'Qualified',
  bookings: 'AI bookings',
  dealsWon: 'Deals won',
};

/** "4 min", "1 h 20 min", "2 d 3 h"; a dash when there's nothing to time. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** The second half of the Analytics page: handoffs and the team, the funnel, lead sources, and what the AI did. */
export function Performance({ from, to, botId, channel, isAdmin }: Props) {
  const toast = useToast();
  const query = { from, to, botId: botId || undefined, channel: channel || undefined };
  const perf = useQuery({ queryKey: ['analytics', 'performance', query], queryFn: () => get<AnalyticsPerformance>('/v1/analytics/performance', query) });
  const csv = (report: string) =>
    isAdmin ? (
      <Button size="sm" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => void download('/v1/analytics/export', { ...query, report }).catch((e) => toast.error(e))}>
        CSV
      </Button>
    ) : undefined;

  if (perf.error) return <ErrorBanner error={perf.error} onRetry={() => void perf.refetch()} />;
  const p = perf.data;
  if (!p) return <SkeletonRows rows={6} />;
  const h = p.handoffs;
  const top = Math.max(1, p.funnel[0]?.count ?? 0);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader title="Handoffs" description="How fast your team answers chats the assistant hands over." actions={csv('handoffs')} />
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 pb-4 sm:grid-cols-3">
          <Figure label="First reply (median)" value={formatDuration(h.firstReplySeconds.median)} />
          <Figure label="First reply (slowest 10%)" value={formatDuration(h.firstReplySeconds.p90)} />
          <Figure label="Handoff rate" value={p.handoffRate === null ? '—' : `${Math.round(p.handoffRate * 100)}%`} hint="Per conversation" />
          <Figure label="Not answered yet" value={formatNumber(h.unanswered)} hint={`of ${formatNumber(h.byAi)} from the assistant`} />
          <Figure label="Waited too long" value={formatNumber(h.waitedTooLong)} />
          <Figure label="Taken back by the assistant" value={formatNumber(h.takenBackByAi)} />
        </div>
        <div className="border-t border-border px-5 py-4">
          <p className="mb-2 text-xs font-medium text-muted">Why chats were handed over</p>
          {h.reasons.length ? (
            <ul className="space-y-1.5">
              {h.reasons.map((r) => (
                <Bar key={r.reason} label={r.reason} value={r.count} max={h.reasons[0]!.count} />
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No handoffs in this period.</p>
          )}
          {h.takenOverByStaff > 0 && <p className="mt-2 text-xs text-muted">Includes {formatNumber(h.takenOverByStaff)} taken over by your team (not timed).</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Team" description="Who answered customers, and how fast after a handoff." actions={csv('team')} />
        <Table>
          <thead>
            <tr>
              <TH>Member</TH>
              <TH className="text-right">Assigned</TH>
              <TH className="text-right">Replies</TH>
              <TH className="text-right">Chats</TH>
              <TH className="text-right">First reply</TH>
            </tr>
          </thead>
          <tbody>
            {p.team.map((m) => (
              <tr key={m.userId}>
                <TD className="font-medium text-fg">{m.name}</TD>
                <TD className="text-right tabular-nums">{formatNumber(m.assigned)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(m.replies)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(m.conversations)}</TD>
                <TD className="text-right tabular-nums">{formatDuration(m.firstReplyMedianSeconds)}</TD>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Funnel" description="Each step as it happened in this period (not one group of customers followed through)." />
        <ul className="space-y-2 px-5 pb-5">
          {p.funnel.map((s, i) => {
            const prev = i ? p.funnel[i - 1]!.count : null;
            return (
              <Bar
                key={s.step}
                label={FUNNEL_LABEL[s.step]}
                value={s.count}
                max={top}
                // Each step counts what happened in the period, so a later step can outnumber an earlier one.
                note={prev && s.count <= prev ? `${Math.round((s.count / prev) * 100)}% of previous step` : undefined}
              />
            );
          })}
        </ul>
        {p.cost && (
          <p className="border-t border-border px-5 py-3 text-xs text-muted">
            AI cost {formatUsd(p.cost.totalUsd)} · {p.cost.perConversationUsd === null ? '—' : formatUsd(p.cost.perConversationUsd)} per conversation ·{' '}
            {p.cost.perLeadUsd === null ? '—' : formatUsd(p.cost.perLeadUsd)} per lead (admins only)
          </p>
        )}
      </Card>

      <Card>
        <CardHeader title="Lead sources" description="Where this period's leads first came from." actions={csv('sources')} />
        {p.sources.length ? (
          <Table>
            <thead>
              <tr>
                <TH>Source</TH>
                <TH>Campaign</TH>
                <TH className="text-right">Leads</TH>
              </tr>
            </thead>
            <tbody>
              {p.sources.map((s, i) => (
                <tr key={`${s.source}-${s.campaign ?? ''}-${s.channel ?? ''}-${i}`}>
                  <TD className="font-medium text-fg capitalize">{s.source}</TD>
                  <TD className="text-muted">{s.campaign ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(s.count)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No leads in this period" description="Sources come from the first page a visitor landed on." />
        )}
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader title="What the assistant did" description="Actions it took in this period, and requests your team decided." actions={csv('actions')} />
        <div className="grid grid-cols-1 gap-6 px-5 pb-5 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {p.actions.length ? (
              <ul className="space-y-1.5">
                {p.actions.map((a) => (
                  <Bar
                    key={a.tool}
                    label={a.tool.replace(/_/g, ' ')}
                    value={a.calls}
                    max={p.actions[0]!.calls}
                    note={[a.failed ? `${a.failed} failed` : '', a.askedTeam ? `${a.askedTeam} asked the team` : ''].filter(Boolean).join(' · ') || undefined}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">No actions in this period.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4 self-start">
            <Figure label="Approved" value={formatNumber(p.approvals.approved)} />
            <Figure label="Declined" value={formatNumber(p.approvals.declined)} />
            <Figure label="Waiting" value={formatNumber(p.approvals.waiting)} />
            <Figure label="Expired" value={formatNumber(p.approvals.expired)} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-fg tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

function Bar({ label, value, max, note }: { label: string; value: number; max: number; note?: string }) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="min-w-0 truncate text-fg-2 first-letter:uppercase" title={label}>
          {label}
        </span>
        <span className="shrink-0 font-medium text-fg tabular-nums">{formatNumber(value)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </div>
      {note && <p className="mt-0.5 text-[11px] text-faint">{note}</p>}
    </li>
  );
}
