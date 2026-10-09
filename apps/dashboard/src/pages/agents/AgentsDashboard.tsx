import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { ErrorBanner, Input, Select, Skeleton } from '../../components/ui';
import { get } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useBots, useChannels, useOrg } from '../../lib/queries';
import { Link } from '../../lib/router';
import type { AgentsDashboard as Dashboard, ChannelType } from '../../lib/types';
import { BarChart, shift, todayIn } from '../analytics/AnalyticsPage';
import { channelKindName } from './shared';

const NO_DATA = "Data for the selected timeframe isn't available.";

function timeSaved(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Conversation AI → Dashboard: what the agents did over a date range, by channel and agent. */
export function AgentsDashboard() {
  const org = useOrg();
  const bots = useBots();
  const channels = useChannels();
  const timezone = org.data?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const from = range?.from ?? shift(today, -29);
  const to = range?.to ?? today;
  const [channel, setChannel] = useState('');
  const [botId, setBotId] = useState('');
  const invalid = from > to ? 'The start date must be on or before the end date.' : null;

  const data = useQuery({
    queryKey: ['agents-dashboard', from, to, channel, botId],
    queryFn: () => get<Dashboard>('/v1/analytics/agents', { from, to, channel: channel || undefined, botId: botId || undefined }),
    enabled: Boolean(org.data) && !invalid,
    placeholderData: keepPreviousData,
  });
  // The channel types this organization has, Test chat aside.
  const kinds = [...new Set((channels.data ?? []).map((c) => c.channel).filter((c) => c !== 'playground'))] as ChannelType[];
  const d = data.data;
  const empty = d ? d.uniqueContacts === 0 && d.actionsTriggered === 0 && d.appointmentsBooked === 0 && d.aiReplies === 0 : true;
  const cards: Array<{ label: string; value: string; hint?: string }> = d
    ? [
        { label: 'Total Unique Contacts', value: formatNumber(d.uniqueContacts) },
        { label: 'Total Actions Triggered', value: formatNumber(d.actionsTriggered) },
        { label: 'Total Appointment Booked', value: formatNumber(d.appointmentsBooked) },
        { label: 'Time Saved', value: timeSaved(d.timeSavedMinutes), hint: `Estimated at ${d.minutesPerReply} minutes of your team's time per AI reply (${formatNumber(d.aiReplies)} replies).` },
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="sr-only">Channel</span>
          <Select className="w-44" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All Channels</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {channelKindName(k)}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-input-bg px-2.5 py-0.5">
          <label className="flex items-center">
            <span className="sr-only">From</span>
            <Input type="date" className="h-8 border-0 bg-transparent px-1 shadow-none" value={from} max={today} onChange={(e) => e.target.value && setRange({ from: e.target.value, to })} />
          </label>
          <ArrowRight className="size-4 text-faint" aria-hidden />
          <label className="flex items-center">
            <span className="sr-only">To</span>
            <Input type="date" className="h-8 border-0 bg-transparent px-1 shadow-none" value={to} max={today} onChange={(e) => e.target.value && setRange({ from, to: e.target.value })} />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="sr-only">Agent</span>
          <Select className="w-56" value={botId} onChange={(e) => setBotId(e.target.value)}>
            <option value="">All Agents</option>
            {(bots.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-body-sm">
          <Link to="/analytics" className="font-medium text-accent-text hover:underline">
            Full analytics report →
          </Link>
          <Link to="/overview" className="font-medium text-accent-text hover:underline">
            Business overview →
          </Link>
        </div>
      </div>

      {invalid ? (
        <ErrorBanner error={invalid} />
      ) : data.error ? (
        <ErrorBanner error={data.error} onRetry={() => void data.refetch()} />
      ) : null}

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {(d ? cards : Array.from({ length: 4 }, () => null)).map((card, i) => (
          <div key={card?.label ?? i} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-card">
            {card ? (
              <>
                <span className="text-body text-fg-2">
                  {card.label}{' '}
                  {card.hint && (
                    <span className="text-muted" title={card.hint}>
                      ⓘ<span className="sr-only">{card.hint}</span>
                    </span>
                  )}
                </span>
                <span className="font-display text-[24px] leading-8 font-bold text-fg tabular-nums">{empty ? '-' : card.value}</span>
                <span className="text-caption text-fg-2">{empty ? NO_DATA : `${d!.from} → ${d!.to}`}</span>
              </>
            ) : (
              <>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-3 w-40" />
              </>
            )}
          </div>
        ))}
      </div>

      <section aria-labelledby="contacts-chart" className="rounded-lg border border-border bg-surface p-6 shadow-card">
        <h2 id="contacts-chart" className="text-[17px] leading-6 font-medium text-fg">
          Total Unique Contacts{' '}
          <span className="text-body-sm text-muted" title="Contacts the AI replied to, each counted once per day (or week)">
            ⓘ
          </span>
        </h2>
        {!d ? (
          <Skeleton className="mt-4 h-48 w-full" />
        ) : empty ? (
          <p className="flex h-48 items-center justify-center text-[17px] text-fg-2">{NO_DATA}</p>
        ) : (
          <div className="mt-3">
            <BarChart label="Unique contacts" points={d.series.map((p) => ({ date: p.date, value: p.contacts }))} weekly={d.interval === 'week'} />
          </div>
        )}
      </section>
    </div>
  );
}
