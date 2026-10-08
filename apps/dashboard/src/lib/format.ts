import { serverNow } from './clock';
import type { EventItem } from './types';

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateTimeYearFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return d.getFullYear() === new Date().getFullYear() ? dateTimeFmt.format(d) : dateTimeYearFmt.format(d);
}

export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : '—';
}

export function formatTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? timeFmt.format(d) : '';
}

/** Up to two initials for a picture-less avatar, as the website chat shows them: "Bright Smile Dental" → "BS". */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function timeAgo(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  // On the server's clock (see clock.ts): the times shown come from it.
  const diff = (serverNow() - d.getTime()) / 1000;
  if (diff < 0) {
    const ahead = -diff;
    // A few seconds ahead is the clocks' small disagreement, not the future.
    if (ahead < 15) return 'just now';
    if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))}m`;
    if (ahead < 86400) return `in ${Math.round(ahead / 3600)}h`;
    return formatDate(d);
  }
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
  return formatDate(d);
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat().format(n);
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(n);
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `ai_active` → `Ai active`; override with a label map where wording matters. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const s = value.replace(/[_.-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const CATEGORY_LABELS: Record<string, string> = { general: 'General', faq: 'FAQ', services: 'Services', pricing: 'Pricing', policies: 'Policies', other: 'Other' };
export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? humanize(c);

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 64);
}

export function pretty(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(displayValue).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** YYYY-MM-DD for a Date in the browser's local time. */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** "2026-10-03" → "Saturday, 3 October 2026" (no timezone shifting). */
export function formatDayHeading(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** "2026-10-03T14:30" → "2:30 PM" */
export function formatLocalTime(local: string): string {
  const time = local.split('T')[1] ?? '';
  const [h, min] = time.split(':').map(Number);
  if (h === undefined || min === undefined || Number.isNaN(h) || Number.isNaN(min)) return time;
  const date = new Date(Date.UTC(2000, 0, 1, h, min));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(date);
}

// ---------- activity feed ----------

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function list(v: unknown): string {
  return Array.isArray(v) ? v.map(String).join(', ') : str(v);
}

const ACTOR_LABEL: Record<string, string> = { ai: 'AI', user: 'Team', contact: 'Visitor', system: 'System' };

const DEAL_FIELD: Record<string, string> = { title: 'title', value: 'value', owner: 'owner', expectedCloseOn: 'expected close', status: 'reopened', lostReason: 'lost reason' };

/** "Invisalign · $4,500" from a deal event's snapshot. */
function dealLine(deal: unknown): string {
  const d = (deal ?? {}) as { title?: string; value?: number | null; currency?: string };
  return `${d.title ?? 'a deal'}${d.value !== null && d.value !== undefined ? ` · ${formatMoney(d.value, d.currency ?? 'USD')}` : ''}`;
}

/** 4500, "USD" → "$4,500"; cents only when there are some. */
export function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** Why a summary was written, as it reads after "Summary updated". */
export const SUMMARY_TRIGGER: Record<string, string> = {
  quiet: 'after a quiet spell',
  closed: 'on close',
  handoff: 'at handoff',
  manual: 'on request',
};
export const actorLabel = (actor: string) => ACTOR_LABEL[actor] ?? humanize(actor);

/** One readable line per event type. */
export function describeEvent(e: EventItem): string {
  const p = e.payload ?? {};
  const appt = (p.appointment ?? {}) as { label?: string; title?: string; timezone?: string };
  switch (e.type) {
    case 'contact.created':
      return 'New contact created';
    case 'contact.updated': {
      const changed = list(p.changed);
      if (p.lifecycleStage) return `Lifecycle stage set to “${str(p.lifecycleStage)}”`;
      return changed ? `Contact details updated: ${changed}` : 'Contact details updated';
    }
    case 'contact.merged':
      return 'Duplicate contact merged into this one';
    case 'contact.duplicate_detected':
      return `Gave ${p.field === 'phone' ? 'a phone number' : 'an email'} that belongs to another contact — waiting for review`;
    case 'contact.consent_updated':
      return `${p.granted ? 'Opted in to' : 'Declined or withdrew'} marketing${p.source === 'staff' ? ' (recorded by staff)' : p.source === 'api' ? ' (from an integration)' : ' (in chat)'}`;
    case 'contact.tagged':
      return `Tagged ${list(p.tags)}`;
    case 'contact.untagged':
      return `Untagged ${list(p.tags)}`;
    case 'contact.note_added':
      return e.actor === 'ai' ? 'AI saved a note about the contact' : 'Note added';
    case 'lead.captured': {
      const who = [str(p.name), str(p.email) || str(p.phone)].filter(Boolean).join(' · ');
      return who ? `Lead captured: ${who}` : 'Lead captured';
    }
    case 'lead.qualification_updated':
      return `Qualification answers recorded${p.score !== undefined ? ` — score ${str(p.score)}` : ''}${p.tier ? ` (${str(p.tier)})` : ''}`;
    case 'lead.qualified':
      return `Lead qualified${p.tier ? ` as ${str(p.tier)}` : ''}${p.score !== undefined ? `, score ${str(p.score)}` : ''}`;
    case 'lead.disqualified':
      return `Lead disqualified${p.score !== undefined ? ` (score ${str(p.score)})` : ''}`;
    case 'appointment.booked':
      return `Booked ${appt.title ?? 'an appointment'}${appt.label ? ` for ${appt.label}` : ''}${p.calendarName ? ` · ${str(p.calendarName)}` : ''}`;
    case 'appointment.rescheduled':
      return `Appointment moved${p.previousLabel ? ` from ${str(p.previousLabel)}` : ''}${appt.label ? ` to ${appt.label}` : ''}`;
    case 'appointment.cancelled':
      return `Appointment cancelled${appt.label ? ` (${appt.label})` : ''}${p.reason ? ` — ${str(p.reason)}` : ''}`;
    case 'task.created':
      return `Task created: ${str(p.title) || 'untitled'}`;
    case 'conversation.started':
      return `New conversation on ${channelLabel(str(p.channel) || 'chat')}`;
    case 'conversation.handoff_requested':
      return `Handed to a human${p.reason ? ` — ${str(p.reason)}` : ''}`;
    case 'conversation.resumed_by_ai':
      return 'AI resumed the conversation';
    case 'conversation.closed':
      return 'Conversation closed';
    case 'conversation.reopened':
      return 'Conversation reopened by the team';
    case 'deal.created':
      return `Deal created: ${dealLine(p.deal)}`;
    case 'deal.updated': {
      const changed = Array.isArray(p.changed) ? (p.changed as string[]).map((f) => DEAL_FIELD[f] ?? f).join(', ') : '';
      return `Deal updated${changed ? ` (${changed})` : ''}: ${dealLine(p.deal)}`;
    }
    case 'deal.stage_changed': {
      const from = (p.from ?? {}) as { stage?: string };
      const to = (p.to ?? {}) as { stage?: string };
      return `Deal moved${from.stage ? ` from ${from.stage}` : ''}${to.stage ? ` to ${to.stage}` : ''}: ${dealLine(p.deal)}`;
    }
    case 'deal.won':
      return `Deal won: ${dealLine(p.deal)}`;
    case 'deal.lost':
      return `Deal lost${p.reason ? ` (${str(p.reason)})` : ''}: ${dealLine(p.deal)}`;
    case 'deal.deleted':
      return `Deal deleted: ${dealLine(p.deal)}`;
    case 'conversation.summarized':
      return `Summary updated${SUMMARY_TRIGGER[str(p.trigger)] ? ` (${SUMMARY_TRIGGER[str(p.trigger)]})` : ''}${p.intent ? `: ${str(p.intent)}` : ''}`;
    case 'workflow.triggered':
      return `Workflow “${str(p.workflow)}” triggered`;
    case 'conversation.handoff_overdue':
      return `Still waiting after ${str(p.waitedMinutes)} minutes${p.fallback === 'resume_ai' || p.fallback === 'ask_contact_details' ? ': the assistant took the chat back' : ''}`;
    case 'conversation.assigned':
      return p.assignedUserId ? `Assigned${p.auto ? ' to the customer\'s owner' : ''}` : 'Unassigned';
    case 'conversation.unanswered':
      return 'A customer wrote but nobody could reply (AI off or assistant paused)';
    case 'team.notified':
      return `Team notified: ${str(p.subject) || str(p.message)}`;
    case 'action.approval_requested':
      return `Asked the team to approve: ${str(p.summary)}`;
    case 'action.approved':
      return `Approved: ${str(p.summary)}`;
    case 'action.rejected':
      return `Declined: ${str(p.summary)}${p.reason ? ` (${str(p.reason)})` : ''}`;
    default:
      return humanize(e.type);
  }
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case 'webchat':
      return 'website chat';
    case 'playground':
      return 'playground';
    case 'api':
      return 'API';
    default:
      return channel;
  }
}

export const TOOL_LABELS: Record<string, { label: string; description: string }> = {
  save_contact_details: { label: 'Save contact details', description: 'Store name, email, phone, company and custom fields the visitor shares.' },
  record_qualification_answers: { label: 'Record qualification answers', description: 'Save answers to your qualification questions and update the lead score.' },
  search_knowledge_base: { label: 'Search knowledge base', description: 'Look up answers in the connected knowledge bases.' },
  check_availability: { label: 'Check availability', description: 'List open appointment slots on the booking calendar.' },
  book_appointment: { label: 'Book appointment', description: 'Book a slot for the visitor.' },
  list_my_appointments: { label: 'List visitor’s appointments', description: 'Show the visitor their upcoming bookings.' },
  reschedule_appointment: { label: 'Reschedule appointment', description: 'Move an existing booking to another slot.' },
  cancel_appointment: { label: 'Cancel appointment', description: 'Cancel an existing booking.' },
  add_tags: { label: 'Add tags', description: 'Tag the contact (limited to allowed tags).' },
  add_note: { label: 'Add note', description: 'Save a note and long-term memory about the contact.' },
  create_task: { label: 'Create task', description: 'Create a follow-up task for your team.' },
  notify_team: { label: 'Notify team', description: 'Send an in-app and email notification to your team.' },
  trigger_workflow: { label: 'Trigger workflow', description: 'Run one of the allowed n8n workflows.' },
  transfer_to_human: { label: 'Transfer to human', description: 'Hand the conversation to your team.' },
  ask_marketing_consent: { label: 'Ask marketing opt-in', description: 'Post your exact opt-in question once the visitor has shared an email or phone.' },
  record_marketing_consent: { label: 'Record marketing consent', description: 'Record the answer to the opt-in question, or a request to stop marketing.' },
  set_lifecycle_stage: { label: 'Set lifecycle stage', description: 'Move the contact to one of the stages you allow.' },
  assign_owner: { label: 'Assign owner', description: 'Make one of the team members you allow the contact’s owner.' },
  remove_tags: { label: 'Remove tags', description: 'Remove allowed tags, or the assistant’s own when there is no list.' },
  create_deal: { label: 'Create deal', description: 'Open a deal for the contact (one open deal each).' },
  update_deal: { label: 'Update deal', description: 'Move the contact’s deal, change its value or close date, or (if allowed) mark it won or lost.' },
};
