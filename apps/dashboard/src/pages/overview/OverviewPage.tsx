import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, CalendarCheck, CircleDollarSign, Hand, ListChecks, MessagesSquare, Sparkles, Star, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { EventRow } from '../../components/activity';
import { StatValue, type StatTone } from '../../components/stats';
import { Badge, Card, CardHeader, cx, EmptyState, ErrorBanner, PageHeader, SkeletonRows } from '../../components/ui';
import { get, patch } from '../../lib/api';
import { formatDate, formatNumber, formatUsd, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { useOrg } from '../../lib/queries';
import { Link } from '../../lib/router';
import type { EventItem, Task, Usage } from '../../lib/types';

export function OverviewPage() {
  const { me } = useAuth();
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => get<Usage>('/v1/usage'), refetchInterval: 60_000 });
  const org = useOrg();
  const timezone = org.data?.timezone ?? 'UTC';
  const since = usage.data ? new Date(usage.data.since) : null;
  // The month is the organization's, so name it in its timezone.
  const monthLabel = since ? since.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: timezone }) : 'this month';
  const budget = org.data?.monthlyAiBudgetUsd ?? null;
  const spend = usage.data?.ai ?? null;
  const cost = spend?.costUsd ?? 0;
  const firstName = (me?.user.name ?? '').trim().split(/\s+/)[0] ?? '';

  return (
    <div>
      <PageHeader
        title={
          <>
            <span aria-hidden className="mb-1 block font-sans text-label font-semibold tracking-[0.08em] text-muted uppercase">
              {todayLabel(timezone)}
            </span>
            {firstName ? `${greetingFor(timezone)}, ${firstName}` : greetingFor(timezone)}
          </>
        }
        description={`How your assistants are doing in ${monthLabel}. Test chats are left out.`}
        actions={
          <Link
            to="/analytics"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 text-body-sm font-medium text-fg shadow-card transition-colors hover:bg-surface-2"
          >
            See analytics
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        }
      />
      <div className="space-y-6 px-4 sm:px-8 py-6">
        {usage.error ? <ErrorBanner error={usage.error} onRetry={() => void usage.refetch()} /> : null}
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 xl:grid-cols-6">
            <Stat loading={usage.isLoading} tone="neutral" icon={<MessagesSquare />} label="Conversations" value={formatNumber(usage.data?.conversations.total)} hint="Started this month" />
            <Stat loading={usage.isLoading} tone="brand" icon={<UserPlus />} label="Leads captured" value={formatNumber(usage.data?.leads.captured)} />
            <Stat loading={usage.isLoading} tone="success" icon={<Star />} label="Qualified leads" value={formatNumber(usage.data?.leads.qualified)} hint="Became qualified this month" />
            <Stat loading={usage.isLoading} tone="ai" icon={<CalendarCheck />} label="AI bookings" value={formatNumber(usage.data?.appointmentsBookedByAi)} hint="Not counting cancelled" />
            {spend ? (
              <Stat
                loading={usage.isLoading}
                tone="ai"
                icon={<CircleDollarSign />}
                label="AI cost"
                value={formatUsd(cost)}
                hint={budget !== null ? `of ${formatUsd(budget)} budget` : `${formatNumber(usage.data?.aiReplies)} AI replies`}
                progress={budget ? Math.min(1, cost / budget) : undefined}
              />
            ) : (
              <Stat loading={usage.isLoading} tone="ai" icon={<Sparkles />} label="AI replies" value={formatNumber(usage.data?.aiReplies)} />
            )}
            <Stat loading={usage.isLoading} tone="human" icon={<Hand />} label="Handoffs" value={formatNumber(usage.data?.conversations.handedOff)} hint="Chats handed to your team this month" />
          </div>
        </Card>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <RecentActivity className="lg:col-span-3" />
          <OpenTasks className="lg:col-span-2" />
        </div>
      </div>
    </div>
  );
}

/** "Good morning" / "Good afternoon" / "Good evening" by the hour in the organization's timezone. */
function greetingFor(timezone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function todayLabel(timezone: string): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone });
}

function Stat({ icon, tone, label, value, hint, loading, progress }: { icon: ReactNode; tone: StatTone; label: string; value: string; hint?: string; loading?: boolean; progress?: number }) {
  return (
    <div className="bg-surface px-5 py-4.5">
      <StatValue
        icon={icon}
        tone={tone}
        label={label}
        value={value}
        loading={loading}
        footer={
          progress !== undefined || hint ? (
            <>
              {progress !== undefined && (
                <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="AI budget used" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className={cx('h-full rounded-full', progress > 0.9 ? 'bg-danger' : progress > 0.7 ? 'bg-warning' : 'bg-accent')} style={{ width: `${progress * 100}%` }} />
                </div>
              )}
              {hint}
            </>
          ) : undefined
        }
      />
    </div>
  );
}

function RecentActivity({ className }: { className?: string }) {
  const events = useQuery({ queryKey: ['events', 'recent'], queryFn: () => get<EventItem[]>('/v1/events', { limit: 25 }), refetchInterval: 30_000 });
  return (
    <Card className={className}>
      <CardHeader
        title="Recent activity"
        description="Leads, bookings, handoffs and what the AI did."
        actions={
          <span className="flex items-center gap-3 text-caption text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-[3px] bg-ai" aria-hidden />
              AI
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-human" aria-hidden />
              Team
            </span>
          </span>
        }
      />
      {events.isLoading ? (
        <SkeletonRows rows={6} />
      ) : events.error ? (
        <ErrorBanner error={events.error} className="m-5" />
      ) : !events.data?.length ? (
        <EmptyState
          icon={<Activity className="size-5" />}
          title="No activity yet"
          description="Try your assistant in the playground, or add the chat widget to your website to start capturing leads."
          action={
            <Link to="/bots" className="text-body-sm font-medium text-accent-text hover:underline">
              Open the bot playground →
            </Link>
          }
        />
      ) : (
        <ul className="px-5 py-2">
          {events.data.map((e) => (
            <EventRow key={e.id} event={e} connected />
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
      <CardHeader
        title="Open tasks"
        description="Follow-ups created by the AI or your team."
        actions={tasks.data?.length ? <Badge className="tabular-nums">{tasks.data.length}</Badge> : undefined}
      />
      {tasks.isLoading ? (
        <SkeletonRows rows={4} />
      ) : tasks.error ? (
        <ErrorBanner error={tasks.error} className="m-5" />
      ) : !tasks.data?.length ? (
        <EmptyState icon={<ListChecks className="size-5" />} title="No open tasks" description="When the AI creates a follow-up, or you add one on a lead, it shows up here." />
      ) : (
        <ul className="divide-y divide-border">
          {tasks.data.map((t) => {
            const overdue = t.dueAt ? new Date(t.dueAt) < new Date() : false;
            return (
              <li key={t.id} className="flex items-start gap-3 px-5 py-3.5">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4.5 shrink-0 cursor-pointer rounded-[5px] accent-[var(--accent)]"
                  aria-label={`Mark “${t.title}” as done`}
                  disabled={complete.isPending && complete.variables === t.id}
                  onChange={() => complete.mutate(t.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-semibold text-fg">{t.title}</p>
                  {t.description && <p className="mt-0.5 line-clamp-2 text-body-sm text-muted">{t.description}</p>}
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-caption text-muted">
                    {t.priority !== 'normal' && <Badge tone={t.priority === 'high' ? 'red' : 'slate'}>{t.priority.charAt(0).toUpperCase() + t.priority.slice(1)}</Badge>}
                    <Badge tone={t.createdBy === 'ai' ? 'ai' : 'human'}>
                      {t.createdBy === 'ai' && <Sparkles className="size-3" aria-hidden />}
                      {t.createdBy === 'ai' ? 'Created by AI' : 'Created by team'}
                    </Badge>
                    {t.dueAt && <span className={overdue ? 'font-semibold text-danger-text' : ''}>Due {formatDate(t.dueAt)}</span>}
                    <span>{timeAgo(t.createdAt)}</span>
                    {t.contactId && (
                      <Link to={`/contacts/${t.contactId}`} className="font-medium text-accent-text hover:underline">
                        Contact
                      </Link>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
