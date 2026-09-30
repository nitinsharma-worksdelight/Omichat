import { schema, type Db } from '../../db/client';

export const EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.merged',
  'contact.duplicate_detected',
  'contact.consent_updated',
  'contact.tagged',
  'contact.untagged',
  'contact.note_added',
  'lead.captured',
  'lead.qualification_updated',
  'lead.qualified',
  'lead.disqualified',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'task.created',
  'conversation.started',
  'conversation.handoff_requested',
  'conversation.resumed_by_ai',
  'conversation.handoff_overdue',
  'conversation.assigned',
  'conversation.unanswered',
  'conversation.closed',
  'conversation.summarized',
  'message.outbound',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'deal.deleted',
  'workflow.triggered',
  'team.notified',
  'ai.provider_problem',
  'action.approval_requested',
  'action.approved',
  'action.rejected',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface NewEvent {
  orgId: string;
  type: EventType;
  actor: 'ai' | 'user' | 'contact' | 'system';
  actorUserId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Outbox write. Call inside the same transaction as the change the event describes, so an event
 * exists if and only if the change committed. The dispatcher delivers it afterwards.
 */
export async function recordEvent(tx: Db, event: NewEvent): Promise<string> {
  const [row] = await tx
    .insert(schema.events)
    .values({
      organizationId: event.orgId,
      type: event.type,
      actor: event.actor,
      actorUserId: event.actorUserId ?? null,
      contactId: event.contactId ?? null,
      conversationId: event.conversationId ?? null,
      payload: event.payload ?? {},
    })
    .returning({ id: schema.events.id });
  return row!.id;
}
