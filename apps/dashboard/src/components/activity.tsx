import {
  Activity,
  Bell,
  CalendarCheck,
  CalendarX,
  CircleCheck,
  CircleX,
  FileText,
  Hand,
  Handshake,
  ListChecks,
  MessageSquare,
  RotateCcw,
  ArrowRightLeft,
  ScrollText,
  ShieldCheck,
  ShieldQuestion,
  Star,
  Tag,
  Trash2,
  Trophy,
  UserPlus,
  UserRound,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { actorLabel, describeEvent, formatDateTime, TOOL_LABELS, timeAgo } from '../lib/format';
import { Link } from '../lib/router';
import type { EventItem, Timeline, ToolInvocation } from '../lib/types';
import { Badge, cx, JsonDisclosure, type Tone } from './ui';

const EVENT_ICONS: Record<string, LucideIcon> = {
  'contact.created': UserPlus,
  'contact.updated': UserRound,
  'contact.merged': UserRound,
  'contact.duplicate_detected': Users,
  'contact.consent_updated': ShieldCheck,
  'contact.tagged': Tag,
  'contact.untagged': Tag,
  'contact.note_added': FileText,
  'lead.captured': UserPlus,
  'lead.qualification_updated': Star,
  'lead.qualified': CircleCheck,
  'lead.disqualified': CircleX,
  'appointment.booked': CalendarCheck,
  'appointment.rescheduled': CalendarCheck,
  'appointment.cancelled': CalendarX,
  'task.created': ListChecks,
  'conversation.started': MessageSquare,
  'conversation.handoff_requested': Hand,
  'conversation.resumed_by_ai': RotateCcw,
  'conversation.closed': MessageSquare,
  'conversation.summarized': ScrollText,
  'deal.created': Handshake,
  'deal.updated': Handshake,
  'deal.stage_changed': ArrowRightLeft,
  'deal.won': Trophy,
  'deal.lost': CircleX,
  'deal.deleted': Trash2,
  'workflow.triggered': Workflow,
  'team.notified': Bell,
  'action.approval_requested': ShieldQuestion,
  'action.approved': CircleCheck,
  'action.rejected': CircleX,
};

const EVENT_TONES: Record<string, string> = {
  'lead.qualified': 'text-success',
  'deal.won': 'text-success',
  'deal.lost': 'text-danger',
  'action.approval_requested': 'text-warning',
  'appointment.booked': 'text-success',
  'lead.disqualified': 'text-danger',
  'appointment.cancelled': 'text-danger',
  'conversation.handoff_requested': 'text-warning',
  'team.notified': 'text-warning',
};

export function EventIcon({ type, className }: { type: string; className?: string }) {
  const Icon = EVENT_ICONS[type] ?? Activity;
  return <Icon className={cx('size-4', EVENT_TONES[type] ?? 'text-muted', className)} aria-hidden />;
}

/** One activity line. `links` adds "open conversation / contact" shortcuts. */
export function EventRow({ event, links = true, compact }: { event: EventItem; links?: boolean; compact?: boolean }) {
  return (
    <li className={cx('flex gap-3', compact ? 'py-2' : 'py-2.5')}>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2">
        <EventIcon type={event.type} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-fg">{describeEvent(event)}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span>{actorLabel(event.actor)}</span>
          <span aria-hidden>·</span>
          <time dateTime={event.createdAt} title={formatDateTime(event.createdAt)}>
            {timeAgo(event.createdAt)}
          </time>
          {links && event.conversationId && (
            <>
              <span aria-hidden>·</span>
              <Link to={`/conversations/${event.conversationId}`} className="text-accent-text hover:underline">
                Conversation
              </Link>
            </>
          )}
          {links && event.contactId && (
            <>
              <span aria-hidden>·</span>
              <Link to={`/contacts/${event.contactId}`} className="text-accent-text hover:underline">
                Contact
              </Link>
            </>
          )}
        </p>
      </div>
    </li>
  );
}

const toolTone: Record<ToolInvocation['status'], Tone> = { success: 'green', error: 'red', rejected: 'amber', replayed: 'slate', pending: 'amber' };
/** A retried turn reused the earlier attempt's result: shown as "reused" so it doesn't read as a second action. */
const toolStatusLabel = (status: ToolInvocation['status']) => (status === 'replayed' ? 'reused' : status === 'pending' ? 'asked the team' : status);

export function ToolRow({ tool }: { tool: ToolInvocation }) {
  return (
    <li className="py-2.5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft">
          <Wrench className="size-3.5 text-accent-text" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-fg">{TOOL_LABELS[tool.toolName]?.label ?? tool.toolName}</span>
            <Badge tone={toolTone[tool.status] ?? 'slate'}>{toolStatusLabel(tool.status)}</Badge>
            <span className="text-xs text-muted">
              {tool.durationMs} ms · {timeAgo(tool.createdAt)}
            </span>
          </div>
          {tool.error && <p className="text-xs text-danger-text">{tool.error}</p>}
          <div className="flex flex-col gap-1">
            <JsonDisclosure label="Input" value={tool.input} />
            <JsonDisclosure label="Output" value={tool.output} />
          </div>
        </div>
      </div>
    </li>
  );
}

type TimelineEntry = { kind: 'event'; at: string; event: EventItem } | { kind: 'tool'; at: string; tool: ToolInvocation };

/** Tool calls and events of one conversation, oldest first. */
export function TimelineList({ timeline, emptyText = 'Nothing yet.', newestFirst }: { timeline: Timeline | undefined; emptyText?: string; newestFirst?: boolean }) {
  const entries: TimelineEntry[] = [
    ...(timeline?.events ?? []).map((event) => ({ kind: 'event' as const, at: event.createdAt, event })),
    ...(timeline?.tools ?? []).map((tool) => ({ kind: 'tool' as const, at: tool.createdAt, tool })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (newestFirst) entries.reverse();
  if (!entries.length) return <p className="py-4 text-center text-xs text-muted">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border">
      {entries.map((e) => (e.kind === 'event' ? <EventRow key={`e-${e.event.id}`} event={e.event} links={false} compact /> : <ToolRow key={`t-${e.tool.id}`} tool={e.tool} />))}
    </ul>
  );
}
