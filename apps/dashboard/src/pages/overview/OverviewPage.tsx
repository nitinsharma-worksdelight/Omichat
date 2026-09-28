import { useQuery } from '@tanstack/react-query';
import { Activity, CalendarCheck, CircleDollarSign, Hand, ListChecks, MessagesSquare, Star, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { EventRow } from '../../components/activity';
import { Badge, Card, CardHeader, cx, EmptyState, ErrorBanner, PageHeader, Skeleton, SkeletonRows } from '../../components/ui';
import { get, patch } from '../../lib/api';
import { formatDate, formatNumber, formatUsd, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { useOrg } from '../../lib/queries';
import { Link } from '../../lib/router';
import type { EventItem, Task, Usage } from '../../lib/types';

export function OverviewPage() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => get<Usage>('/v1/usage'), refetchInterval: 60_000 });
  const org = useOrg();
  const since = usage.data ? new Date(usage.data.since) : null;
  const monthLabel = since ? since.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'this month';
  const budget = org.data?.monthlyAiBudgetUsd ?? null;
  const cost = usage.data?.ai.costUsd ?? 0;

  return (
    <div>
      <PageHeader title="Overview" description={`How your assistants are doing in ${monthLabel}.`} />
      <div className="space-y-6 px-8 py-6">
        {usage.error ? <ErrorBanner error={usage.error} onRetry={() => void usage.refetch()} /> : null}
        <div className="grid grid-cols-3 gap-4 xl:grid-cols-6">
          <Stat loading={usage.isLoading} icon={<MessagesSquare className="size-4" />} label="Conversations" value={formatNumber(usage.data?.conversations.total)} hint="Excludes playground tests" />
          <Stat loading={usage.isLoading} icon={<UserPlus className="size-4" />} label="Leads captured" value={formatNumber(usage.data?.leads.captured)} />
          <Stat loading={usage.isLoading} icon={<Star className="size-4" />} label="Qualified leads" value={formatNumber(usage.data?.leads.qualified)} />
          <Stat loading={usage.isLoading} icon={<CalendarCheck className="size-4" />} label="AI bookings" value={formatNumber(usage.data?.appointmentsBookedByAi)} />
          <Stat
            loading={usage.isLoading}
            icon={<CircleDollarSign className="size-4" />}
            label="AI cost"
            value={formatUsd(cost)}
            hint={budget !== null ? `of ${formatUsd(budget)} budget` : `${formatNumber(usage.data?.ai.runs)} AI replies`}
            progress={budget ? Math.min(1, cost / budget) : undefined}
          />
          <Stat
            loading={usage.isLoading}
            icon={<Hand className="size-4" />}
            label="Handed to humans"
            value={formatNumber(usage.data?.conversations.handedOff)}
            hint="Currently waiting on your team"
          />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <RecentActivity className="lg:col-span-3" />
          <OpenTasks className="lg:col-span-2" />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint, loading, progress }: { icon: ReactNode; label: string; value: string; hint?: string; loading?: boolean; progress?: number }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      {loading ? <Skeleton className="mt-2 h-7 w-16" /> : <p className="mt-1.5 text-2xl font-semibold text-fg tabular-nums">{value}</p>}
      {progress !== undefined && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={cx('h-full rounded-full', progress > 0.9 ? 'bg-danger' : progress > 0.7 ? 'bg-warning' : 'bg-accent')} style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function RecentActivity({ className }: { className?: string }) {
  const events = useQuery({ queryKey: ['events', 'recent'], queryFn: () => get<EventItem[]>('/v1/events', { limit: 25 }), refetchInterval: 30_000 });
  return (
    <Card className={className}>
      <CardHeader title="Recent activity" description="Leads, bookings, handoffs and what the AI did." />
      {events.isLoading ? (
        <SkeletonRows rows={6} />
      ) : events.error ? (
        <ErrorBanner error={events.error} className="m-4" />
      ) : !events.data?.length ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No activity yet"
          description="Try your assistant in the playground, or add the chat widget to your website to start capturing leads."
          action={
            <Link to="/bots" className="text-[13px] font-medium text-accent-text hover:underline">
              Open the bot playground →
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-border px-4">
          {events.data.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function OpenTasks({ className }: { className?: string }) {
  const tasks = useQuery({ queryKey: ['tasks', { status: 'open' }], queryFn: () => get<Task[]>('/v1/tasks', { status: 'open' }) });
  const complete = useAction((id: string) => patch(`/v1/tasks/${id}`, { status: 'done' }), { invalidate: [['tasks']], success: 'Task completed' });
  return (
    <Card className={className}>
      <CardHeader title="Open tasks" description="Follow-ups created by the AI or your team." />
      {tasks.isLoading ? (
        <SkeletonRows rows={4} />
      ) : tasks.error ? (
        <ErrorBanner error={tasks.error} className="m-4" />
      ) : !tasks.data?.length ? (
        <EmptyState icon={<ListChecks className="size-5" />} title="No open tasks" description="When the AI creates a follow-up, or you add one on a lead, it shows up here." />
      ) : (
        <ul className="divide-y divide-border">
          {tasks.data.map((t) => (
            <li key={t.id} className="flex items-start gap-3 px-4 py-3">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--accent)]"
                aria-label={`Mark “${t.title}” as done`}
                disabled={complete.isPending && complete.variables === t.id}
                onChange={() => complete.mutate(t.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg">{t.title}</p>
                {t.description && <p className="line-clamp-2 text-xs text-muted">{t.description}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {t.priority !== 'normal' && <Badge tone={t.priority === 'high' ? 'red' : 'slate'}>{t.priority}</Badge>}
                  {t.dueAt && <span className={new Date(t.dueAt) < new Date() ? 'text-danger-text' : ''}>Due {formatDate(t.dueAt)}</span>}
                  <span>{t.createdBy === 'ai' ? 'Created by AI' : 'Created by team'} · {timeAgo(t.createdAt)}</span>
                  {t.contactId && (
                    <Link to={`/contacts/${t.contactId}`} className="text-accent-text hover:underline">
                      Contact
                    </Link>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
