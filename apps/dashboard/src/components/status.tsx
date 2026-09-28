import type { AppointmentStatus, ConversationStatus, DocumentStatus, LeadTier, QualificationStatus } from '../lib/types';
import { Badge, type Tone } from './ui';

/** Status colours: green = ready/qualified/booked · amber = pending/warm/human · red = failed/hot · slate = neutral. */

const conversationStatus: Record<ConversationStatus, { label: string; tone: Tone }> = {
  ai_active: { label: 'AI', tone: 'indigo' },
  human_active: { label: 'Human', tone: 'amber' },
  closed: { label: 'Closed', tone: 'slate' },
};

export function ConversationStatusBadge({ status }: { status: ConversationStatus }) {
  const s = conversationStatus[status] ?? { label: status, tone: 'slate' as Tone };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

const tierTone: Record<LeadTier, Tone> = { hot: 'red', warm: 'amber', cold: 'slate' };

export function TierBadge({ tier }: { tier: LeadTier | null | undefined }) {
  if (!tier) return <span className="text-faint">—</span>;
  return <Badge tone={tierTone[tier]}>{tier.charAt(0).toUpperCase() + tier.slice(1)}</Badge>;
}

const qualificationStatus: Record<QualificationStatus, { label: string; tone: Tone }> = {
  not_started: { label: 'Not started', tone: 'slate' },
  in_progress: { label: 'In progress', tone: 'amber' },
  qualified: { label: 'Qualified', tone: 'green' },
  disqualified: { label: 'Disqualified', tone: 'red' },
};

export function QualificationBadge({ status }: { status: QualificationStatus }) {
  const s = qualificationStatus[status] ?? { label: status, tone: 'slate' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const documentStatus: Record<DocumentStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'amber' },
  processing: { label: 'Processing', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
};

export function DocumentStatusBadge({ status }: { status: DocumentStatus }) {
  const s = documentStatus[status] ?? { label: status, tone: 'slate' as Tone };
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

const appointmentStatus: Record<AppointmentStatus, { label: string; tone: Tone }> = {
  booked: { label: 'Booked', tone: 'green' },
  completed: { label: 'Completed', tone: 'slate' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  no_show: { label: 'No-show', tone: 'amber' },
};

export function AppointmentStatusBadge({ status }: { status: AppointmentStatus }) {
  const s = appointmentStatus[status] ?? { label: status, tone: 'slate' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function ChannelBadge({ channel }: { channel: string }) {
  const label = channel === 'webchat' ? 'Website' : channel === 'playground' ? 'Playground' : channel === 'api' ? 'API' : channel;
  return <Badge tone={channel === 'playground' ? 'blue' : 'slate'}>{label}</Badge>;
}

export function TagChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs whitespace-nowrap text-fg-2">
      <span className="size-2 rounded-full" style={{ background: color || '#64748b' }} aria-hidden />
      {name}
      {onRemove && (
        <button type="button" onClick={onRemove} className="-mr-0.5 rounded px-0.5 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Remove tag ${name}`}>
          ×
        </button>
      )}
    </span>
  );
}
