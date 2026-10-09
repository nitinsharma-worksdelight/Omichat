import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rowsOf, schema, type Db } from '../../db/client';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import type { EmailSender } from '../../infra/email';
import type { PubSub } from '../../infra/pubsub';
import type { QueueDriver } from '../../infra/queue';
import { orgChannel, userChannel } from '../conversations/service';
import { truncate } from '../../lib/async';
import { signWebhook, type SecretBox } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { randomToken } from '../../lib/ids';
import type { Logger } from '../../lib/logger';
import { assertSafeUrl, fetchLimited } from '../../lib/net';
import { consentForWebhook, touchForWebhook } from '../leads/attribution';
import { displayName } from '../leads/capture';
import { EVENT_TYPES, recordEvent } from './events';

export const WebhookEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url(),
  eventTypes: z.array(z.union([z.literal('*'), z.enum(EVENT_TYPES)])).min(1).default(['*']),
  isActive: z.boolean().default(true),
});

export const WorkflowSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(10).max(1000),
  url: z.string().trim().url(),
  mode: z.enum(['fire_and_forget', 'request_response']).default('fire_and_forget'),
  inputFields: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_]+$/),
        type: z.enum(['string', 'number', 'boolean']).default('string'),
        description: z.string().max(300).default(''),
        required: z.boolean().default(false),
        /** Where the value comes from: the chat (the model passes it) or the contact record (filled by the server). */
        source: z.enum(['chat', 'contact.email', 'contact.phone', 'contact.name', 'contact.id']).default('chat'),
      })
      .refine((f) => f.source === 'chat' || f.type === 'string', { message: 'A value from the contact record is text: set its type to string', path: ['type'] }),
    )
    .max(20)
    .default([]),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
  /** Run only for customers identified by the business's own systems (chat-API conversations), never a web-chat visitor. */
  identifiedOnly: z.boolean().default(false),
  /** Each call waits for the team's approval; with `identifiedOnly`, that also admits web-chat visitors. */
  askFirst: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

/** Who the customer is, as far as a workflow can trust it. */
type Identity = 'integration' | 'unverified' | 'staff';

type EventRow = typeof schema.events.$inferSelect;

interface StaffNotification {
  title: string;
  body: string;
  link: string | null;
  /** Only this member sees it (and it's emailed to them, not to the notification list). */
  userId?: string;
  /** In the dashboard only: not worth an email (what the team decided on an approval, for the others to see). */
  inAppOnly?: boolean;
  /** The member whose own action this reports: it is already read for them, and they get no pop-up for it. */
  byUserId?: string;
}

interface Brief {
  lastMessage?: string | null;
  intent?: string | null;
  nextStep?: string | null;
  sentiment?: string | null;
}

/** The handoff alert's body: why, then what staff need to pick it up. */
function handoffBody(reason: unknown, brief: Brief | undefined): string {
  const lines = [String(reason ?? 'Handoff requested')];
  if (brief?.intent) lines.push(`Wants: ${brief.intent}`);
  if (brief?.nextStep) lines.push(`Next: ${brief.nextStep}`);
  if (brief?.sentiment === 'negative') lines.push('Mood: negative');
  if (brief?.lastMessage) lines.push(`Last message: “${brief.lastMessage}”`);
  return lines.join('\n');
}

function unansweredBody(reason: string): string {
  if (reason === 'ai_disabled') return "The organization's AI is switched off, so nobody is answering website chats.";
  if (reason === 'bot_inactive') return 'The assistant for this chat is paused, so nobody is answering.';
  return 'This chat has no assistant, so nobody is answering.';
}

/** The approval events that change what the team's approvals list shows. */
const APPROVAL_EVENT_STATUS: Partial<Record<string, 'pending' | 'approved' | 'rejected'>> = {
  'action.approval_requested': 'pending',
  'action.approved': 'approved',
  'action.rejected': 'rejected',
};

/** Which events become staff notifications (in-app + email), and how they read. */
function notificationFor(event: EventRow, contactName: string | null): StaffNotification | null {
  const p = event.payload as Record<string, unknown>;
  const who = contactName ?? 'A visitor';
  const convLink = event.conversationId ? `/conversations/${event.conversationId}` : event.contactId ? `/contacts/${event.contactId}` : null;
  switch (event.type) {
    case 'conversation.handoff_requested':
      // Staff taking over need no alert; nor do AI handoffs on a bot whose `handoff.notifyTeam` is off.
      return event.actor === 'user' || p.notifyTeam === false
        ? null
        : { title: `${who} needs a human`, body: handoffBody(p.reason, p.brief as Brief | undefined), link: convLink };
    case 'conversation.assigned': {
      const to = typeof p.assignedUserId === 'string' ? p.assignedUserId : null;
      // Nobody to tell, or they assigned it to themselves.
      if (!to || to === event.actorUserId) return null;
      return { title: `${who} was assigned to you`, body: p.auto ? 'You own this customer, so their handoff came to you.' : 'A teammate assigned this conversation to you.', link: convLink, userId: to };
    }
    case 'conversation.handoff_overdue':
      return { title: `${who} is still waiting for a reply`, body: `Handed to the team ${String(p.waitedMinutes)} minutes ago and nobody has answered.`, link: convLink };
    case 'conversation.unanswered':
      return { title: `${who} wrote but the assistant can't reply`, body: unansweredBody(String(p.reason)), link: convLink };
    case 'lead.qualified':
      return p.notifyTeam ? { title: `New qualified lead: ${who}`, body: `Tier: ${String(p.tier)} · score ${String(p.score)}`, link: convLink } : null;
    case 'appointment.booked': {
      const a = p.appointment as { label?: string; timezone?: string } | undefined;
      return { title: `New booking: ${who}`, body: `${a?.label ?? ''} (${a?.timezone ?? ''})`, link: convLink };
    }
    case 'appointment.rescheduled': {
      const a = p.appointment as { label?: string; timezone?: string } | undefined;
      return { title: `Booking moved: ${who}`, body: `${String(p.previousLabel ?? '')} → ${a?.label ?? ''} (${a?.timezone ?? ''})`, link: convLink };
    }
    case 'appointment.cancelled': {
      const a = p.appointment as { label?: string } | undefined;
      return { title: `Booking cancelled: ${who}`, body: `${a?.label ?? ''}${p.reason ? ` — ${String(p.reason)}` : ''}`, link: convLink };
    }
    case 'contact.duplicate_detected':
      return {
        title: `Possible returning customer: ${who}`,
        body: `Gave ${p.field === 'phone' ? 'a phone number' : 'an email'} in a chat that belongs to another contact. Review it: merge them or dismiss.`,
        link: event.contactId ? `/contacts/${event.contactId}` : null,
      };
    case 'ai.provider_problem':
      return {
        title: 'AI assistant unavailable: conversations are going to your team',
        body: p.kind === 'billing' ? 'The AI provider account is out of credits or quota.' : 'The AI provider rejected the API key.',
        link: '/settings',
      };
    case 'team.notified':
      return { title: `${p.urgency === 'high' ? '🔴 ' : ''}${String(p.subject)}`, body: `${who}: ${String(p.message)}`, link: convLink };
    case 'action.approval_requested':
      return { title: `Approval needed: ${who}`, body: `The assistant asks to: ${String(p.summary)}`, link: convLink };
    // What a teammate decided, so the others know it is dealt with.
    case 'action.approved':
      return { title: `Approved: ${who}`, body: `The team approved: ${String(p.summary)}`, link: convLink, inAppOnly: true, byUserId: event.actorUserId ?? undefined };
    case 'action.rejected':
      return {
        title: `Declined: ${who}`,
        body: `The team declined: ${String(p.summary)}${p.reason ? ` (${String(p.reason)})` : ''}`,
        link: convLink,
        inAppOnly: true,
        byUserId: event.actorUserId ?? undefined,
      };
    default:
      return null;
  }
}

export class AutomationService {
  constructor(
    private readonly db: Db,
    private readonly tenantDb: TenantDb,
    private readonly queue: QueueDriver,
    private readonly secrets: SecretBox,
    private readonly email: EmailSender,
    private readonly logger: Logger,
    private readonly opts: { allowPrivateUrls: boolean; dashboardUrl: string; pubsub?: PubSub },
  ) {}

  // ---------- AI-facing actions ----------

  async notifyTeam(
    scope: Scope,
    input: { subject: string; message: string; urgency: 'normal' | 'high'; contactId?: string; conversationId?: string },
  ) {
    await inScope(this.tenantDb, scope, (tx) =>
      recordEvent(tx, {
        orgId: scope.orgId,
        type: 'team.notified',
        actor: 'ai',
        contactId: input.contactId,
        conversationId: input.conversationId,
        payload: { subject: input.subject, message: input.message, urgency: input.urgency },
      }),
    );
    await this.kick();
  }

  /** Auth/billing failures need a person to fix configuration. Alert staff at most once an hour. */
  async reportProviderProblem(scope: Scope, input: { kind: 'auth' | 'billing'; provider: string; message: string }) {
    const recorded = await inScope(this.tenantDb, scope, async (tx) => {
      const [recent] = await tx
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.organizationId, scope.orgId),
            eq(schema.events.type, 'ai.provider_problem'),
            sql`${schema.events.createdAt} > now() - interval '1 hour'`,
          ),
        )
        .limit(1);
      if (recent) return false;
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'ai.provider_problem',
        actor: 'system',
        payload: { kind: input.kind, provider: input.provider, message: truncate(input.message, 500) },
      });
      return true;
    });
    if (recorded) await this.kick();
  }

  /**
   * A customer wrote and nobody will answer (AI off, assistant paused or missing). Alert staff at most once an
   * hour per organization, so a busy chat doesn't flood them.
   */
  async reportUnanswered(scope: Scope, input: { reason: 'ai_disabled' | 'bot_inactive' | 'no_bot'; contactId: string; conversationId: string }) {
    const recorded = await inScope(this.tenantDb, scope, async (tx) => {
      const [recent] = await tx
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.organizationId, scope.orgId),
            eq(schema.events.type, 'conversation.unanswered'),
            sql`${schema.events.createdAt} > now() - interval '1 hour'`,
          ),
        )
        .limit(1);
      if (recent) return false;
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'conversation.unanswered',
        actor: 'system',
        contactId: input.contactId,
        conversationId: input.conversationId,
        payload: { reason: input.reason },
      });
      return true;
    });
    if (recorded) await this.kick();
  }

  async triggerWorkflow(
    scope: Scope,
    input: {
      key: string;
      inputs: Record<string, unknown>;
      contactId?: string;
      conversationId?: string;
      allowedKeys?: string[];
      actor?: 'ai' | 'user';
      actorUserId?: string;
      /** The team member who approved this call (the workflow, or the bot, asks first). */
      approvedBy?: string;
    },
  ): Promise<{ ok: boolean; queued?: boolean; status?: number; response?: unknown; error?: string }> {
    if (input.allowedKeys && !input.allowedKeys.includes(input.key)) throw badRequest(`Workflow "${input.key}" is not enabled for this bot`);
    const staff = (input.actor ?? 'ai') === 'user';
    const prepared = await inScope(this.tenantDb, scope, async (tx) => {
      const [workflow] = await tx
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.organizationId, scope.orgId), eq(schema.workflows.key, input.key), eq(schema.workflows.isActive, true)));
      if (!workflow) throw notFound('Workflow');
      // A chat-API customer is who the business's own systems say; anyone in the web chat is taking their own word.
      const [conversation] = input.conversationId
        ? await tx.select({ channel: schema.conversations.channel }).from(schema.conversations).where(eq(schema.conversations.id, input.conversationId))
        : [];
      const identity: Identity = staff ? 'staff' : conversation?.channel === 'api' ? 'integration' : 'unverified';
      const approvedBy = input.approvedBy ?? null;
      // The executor saves these calls as requests; this only holds if a call slips past it (settings changed mid-turn).
      if (workflow.askFirst && !staff && !approvedBy) {
        return { refused: "This workflow needs the team's approval first, and it wasn't asked: offer to have the team check (create_task)." };
      }
      // A person who approved the call has checked who is asking.
      if (workflow.identifiedOnly && identity === 'unverified' && !approvedBy) {
        return {
          refused:
            'This workflow only runs for customers the business has identified, and this chat can\'t prove who the customer is. Don\'t look it up another way: offer to have the team check (create_task, or transfer_to_human).',
        };
      }
      const contact = input.contactId ? await this.contactSnapshot(tx, input.contactId) : null;

      const problems: string[] = [];
      const inputs: Record<string, unknown> = {};
      const record: Record<string, unknown> = {};
      const fromChat: string[] = [];
      const fromRecord: string[] = [];
      for (const field of workflow.inputFields) {
        const source = field.source ?? 'chat';
        let value: unknown;
        if (source === 'chat') value = input.inputs[field.name];
        else {
          // Filled from the contact record; what the model passed is ignored. A staff test run can supply it.
          const onRecord = contact ? { 'contact.email': contact.email, 'contact.phone': contact.phone, 'contact.name': contact.name, 'contact.id': contact.id }[source] : null;
          value = onRecord ?? (staff ? input.inputs[field.name] : undefined);
        }
        if (value === undefined || value === null || value === '') {
          if (field.required) {
            problems.push(
              source === 'chat'
                ? `missing "${field.name}" (${field.description || field.type})`
                : `the customer's ${source.slice('contact.'.length)} isn't on record yet: ask for it and save it with save_contact_details first`,
            );
          }
          continue;
        }
        if (field.type === 'number' && typeof value !== 'number' && Number.isNaN(Number(value))) problems.push(`"${field.name}" must be a number`);
        inputs[field.name] = field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === true || value === 'true' : String(value);
        if (source === 'chat') fromChat.push(field.name);
        else {
          record[field.name] = inputs[field.name];
          fromRecord.push(field.name);
        }
      }
      if (problems.length) return { refused: `Cannot run workflow: ${problems.join('; ')}` };
      await recordEvent(tx, {
        orgId: scope.orgId,
        type: 'workflow.triggered',
        actor: input.actor ?? 'ai',
        actorUserId: input.actorUserId,
        contactId: input.contactId,
        conversationId: input.conversationId,
        payload: { workflow: workflow.key, inputs, ...(approvedBy ? { approvedBy } : {}) },
      });
      return { workflow, contact, inputs, record, trust: { identity, channel: conversation?.channel ?? null, fromChat, fromRecord, approvedBy } };
    });
    if ('refused' in prepared) return { ok: false, error: prepared.refused };
    const { workflow, contact, inputs, record, trust } = prepared;

    const body = {
      workflow: workflow.key,
      organization_id: scope.orgId,
      conversation_id: input.conversationId ?? null,
      contact,
      /** Every value; `trust` says which were typed in the chat and which came from the contact record. */
      inputs,
      record,
      trust,
      triggered_at: new Date().toISOString(),
    };
    if (workflow.mode === 'fire_and_forget') {
      await this.queue.add('workflow', { orgId: scope.orgId, workflowId: workflow.id, body }, { attempts: 5, backoffMs: 5_000 });
      return { ok: true, queued: true };
    }
    const res = await this.post(workflow.url, this.secrets.decrypt(workflow.secretEnc), body, workflow.timeoutMs, {
      'x-omni-workflow': workflow.key,
    });
    let response: unknown = res.text;
    try {
      response = JSON.parse(res.text);
    } catch {
      // plain-text responses are passed through as-is
    }
    return res.status >= 200 && res.status < 300
      ? { ok: true, status: res.status, response }
      : { ok: false, status: res.status, error: `Workflow returned HTTP ${res.status}`, response };
  }

  /** Worker: deliver a fire-and-forget workflow call. Throws to retry. */
  async runQueuedWorkflow(orgId: string, workflowId: string, body: unknown) {
    const [workflow] = await this.tenantDb.run(orgId, (tx) => tx.select().from(schema.workflows).where(eq(schema.workflows.id, workflowId)));
    if (!workflow || !workflow.isActive) return;
    const res = await this.post(workflow.url, this.secrets.decrypt(workflow.secretEnc), body, workflow.timeoutMs, { 'x-omni-workflow': workflow.key });
    if (res.status >= 500 || res.status === 429) throw new Error(`Workflow ${workflow.key} returned ${res.status}`);
  }

  // ---------- outbox dispatch ----------

  /** Nudge the dispatcher (it also runs on a timer, so nothing is lost if this is missed). */
  async kick(): Promise<void> {
    await this.queue.add('events', {}, { jobId: 'dispatch', delayMs: 200, attempts: 1, coalesce: true });
  }

  /**
   * Moves undispatched events to webhook deliveries and staff notifications. System-level: runs across
   * all orgs; `skip locked` lets several workers share the backlog without double-dispatching.
   */
  async dispatchPending(limit = 200): Promise<number> {
    const result = await this.db.transaction(async (tx) => {
      const events = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`
          select id from events where dispatched_at is null order by created_at limit ${limit} for update skip locked`),
      ).map((r) => String(r.id));
      if (!events.length) return 0;
      const rows = await tx.select().from(schema.events).where(inArray(schema.events.id, events)).orderBy(asc(schema.events.createdAt));
      const orgIds = [...new Set(rows.map((r) => r.organizationId))];
      const endpoints = await tx
        .select()
        .from(schema.webhookEndpoints)
        .where(and(inArray(schema.webhookEndpoints.organizationId, orgIds), eq(schema.webhookEndpoints.isActive, true)));
      const orgs = await tx
        .select({ id: schema.organizations.id, settings: schema.organizations.settings, name: schema.organizations.name })
        .from(schema.organizations)
        .where(inArray(schema.organizations.id, orgIds));
      const contactIds = [...new Set(rows.map((r) => r.contactId).filter((id): id is string => Boolean(id)))];
      const contactRows = contactIds.length
        ? await tx
            .select({
              id: schema.contacts.id,
              organizationId: schema.contacts.organizationId,
              firstName: schema.contacts.firstName,
              lastName: schema.contacts.lastName,
              isTest: schema.contacts.isTest,
            })
            .from(schema.contacts)
            .where(inArray(schema.contacts.id, contactIds))
        : [];
      const contactsById = new Map(contactRows.map((c) => [c.id, c]));
      const deliveryJobs: string[] = [];
      const created: Array<{ id: string; orgId: string; userId: string | null }> = [];
      // Requests and the team's answers, for open dashboards to refresh their approvals (including test chats').
      const approvalChanges: Array<{ orgId: string; approvalId: string; conversationId: string | null; status: 'pending' | 'approved' | 'rejected' }> = [];
      const emails: Array<{ to: string[]; subject: string; text: string }> = [];

      for (const event of rows) {
        // Runs across organizations: only the event's own organization's contact may name it.
        const found = event.contactId ? contactsById.get(event.contactId) : undefined;
        const contact = found?.organizationId === event.organizationId ? found : undefined;
        const approvalStatus = APPROVAL_EVENT_STATUS[event.type];
        const approvalId = (event.payload as { approvalId?: unknown } | null)?.approvalId;
        if (approvalStatus && typeof approvalId === 'string') {
          approvalChanges.push({ orgId: event.organizationId, approvalId, conversationId: event.conversationId, status: approvalStatus });
        }
        // Playground/test traffic never reaches external systems or staff inboxes.
        if (contact?.isTest) continue;
        for (const ep of endpoints) {
          if (ep.organizationId !== event.organizationId) continue;
          if (!ep.eventTypes.includes('*') && !ep.eventTypes.includes(event.type)) continue;
          const [delivery] = await tx
            .insert(schema.webhookDeliveries)
            .values({ organizationId: event.organizationId, endpointId: ep.id, eventId: event.id, eventType: event.type })
            .onConflictDoNothing()
            .returning({ id: schema.webhookDeliveries.id });
          if (delivery) deliveryJobs.push(delivery.id);
        }
        const note = notificationFor(event, contact ? displayName(contact) : null);
        if (note) {
          const [inserted] = await tx.insert(schema.notifications).values({
            organizationId: event.organizationId,
            userId: note.userId ?? null,
            type: event.type,
            title: truncate(note.title, 200),
            body: truncate(note.body, 1000),
            link: note.link,
            data: { eventId: event.id, ...(note.byUserId ? { byUserId: note.byUserId } : {}) },
          }).returning({ id: schema.notifications.id });
          // Their own action is already read for them.
          if (note.byUserId) {
            await tx
              .insert(schema.notificationReads)
              .values({ notificationId: inserted!.id, userId: note.byUserId, organizationId: event.organizationId })
              .onConflictDoNothing();
          }
          created.push({ id: inserted!.id, orgId: event.organizationId, userId: note.userId ?? null });
          const org = orgs.find((o) => o.id === event.organizationId);
          const recipients = note.inAppOnly ? [] : note.userId ? await this.emailOf(tx, note.userId) : (org?.settings.notificationEmails ?? []);
          if (recipients.length) {
            emails.push({
              to: recipients,
              subject: `[${org!.name}] ${note.title}`,
              text: `${note.body}\n\n${note.link ? `Open: ${this.opts.dashboardUrl}${note.link}` : ''}`,
            });
          }
        }
      }
      await tx.update(schema.events).set({ dispatchedAt: new Date() }).where(inArray(schema.events.id, events));
      return { count: rows.length, deliveryJobs, emails, created, approvalChanges };
    });
    if (typeof result === 'number') return result;
    // Queued only after the commit, so a worker never looks for a delivery row that isn't visible yet.
    // If the process dies in between, the rows stay 'pending' and `retryStalledDeliveries` picks them up.
    for (const id of result.deliveryJobs) {
      await this.queue.add('webhook-delivery', { deliveryId: id }, { jobId: `delivery_${id}`, attempts: 6, backoffMs: 10_000 });
    }
    for (const e of result.emails) await this.queue.add('notification', e, { attempts: 3 });
    // Open dashboards learn about new notifications at once (only the ID: they fetch it with their own access).
    // Published after the commit, so the fetch always finds the row. The bell's poll covers anything missed.
    for (const a of result.approvalChanges) {
      await this.opts.pubsub
        ?.publish(orgChannel(a.orgId), { type: 'approval.changed', approvalId: a.approvalId, conversationId: a.conversationId, status: a.status })
        .catch((err) => this.logger.warn({ err }, 'approval change publish failed'));
    }
    for (const n of result.created) {
      const message = { type: 'notification', id: n.id };
      await this.opts.pubsub
        ?.publish(n.userId ? userChannel(n.orgId, n.userId) : orgChannel(n.orgId), message)
        .catch((err) => this.logger.warn({ err }, 'notification publish failed'));
    }
    return result.count;
  }

  async retryStalledDeliveries(): Promise<void> {
    const stalled = await this.db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(and(eq(schema.webhookDeliveries.status, 'pending'), sql`${schema.webhookDeliveries.createdAt} < now() - interval '10 minutes'`, sql`${schema.webhookDeliveries.attemptCount} = 0`))
      .limit(100);
    for (const d of stalled) await this.queue.add('webhook-delivery', { deliveryId: d.id }, { jobId: `delivery_${d.id}`, attempts: 6, backoffMs: 10_000 });
  }

  /** Worker: POST one event to one endpoint. Throws on failure so the queue retries with backoff. */
  async deliver(deliveryId: string, meta: { attempt: number; maxAttempts: number }): Promise<void> {
    const [row] = await this.db
      .select({ delivery: schema.webhookDeliveries, endpoint: schema.webhookEndpoints, event: schema.events })
      .from(schema.webhookDeliveries)
      .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId))
      .innerJoin(schema.events, eq(schema.events.id, schema.webhookDeliveries.eventId))
      .where(eq(schema.webhookDeliveries.id, deliveryId));
    if (!row || row.delivery.status === 'success' || !row.endpoint.isActive) return;
    const { event, endpoint } = row;
    const contact = event.contactId ? await this.contactSnapshot(this.db, event.contactId) : null;
    const body = {
      id: event.id,
      type: event.type,
      organization_id: event.organizationId,
      created_at: event.createdAt.toISOString(),
      data: { ...event.payload, actor: event.actor, conversation_id: event.conversationId, contact },
    };
    let status = 0;
    let text = '';
    let error: string | null = null;
    try {
      const res = await this.post(endpoint.url, this.secrets.decrypt(endpoint.secretEnc), body, 10_000, {
        'x-omni-event': event.type,
        'x-omni-delivery': deliveryId,
      });
      status = res.status;
      text = res.text;
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const final = !error || meta.attempt >= meta.maxAttempts;
    await this.db
      .update(schema.webhookDeliveries)
      .set({
        status: error ? (final ? 'failed' : 'pending') : 'success',
        attemptCount: meta.attempt,
        responseStatus: status || null,
        responseBody: truncate(text, 2000),
        lastError: error,
        deliveredAt: error ? null : new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, deliveryId));
    if (error && !final) throw new Error(`Webhook delivery failed: ${error}`);
  }

  async sendEmail(message: { to: string[]; subject: string; text: string }) {
    await this.email.send(message);
  }

  private async post(url: string, secret: string, body: unknown, timeoutMs: number, headers: Record<string, string>) {
    const json = JSON.stringify(body);
    const res = await fetchLimited(url, {
      timeoutMs,
      maxBytes: 256_000,
      maxRedirects: 0,
      allowPrivate: this.opts.allowPrivateUrls,
      method: 'POST',
      body: json,
      headers: { ...headers, 'content-type': 'application/json', 'x-omni-signature': signWebhook(secret, json) },
    });
    return { status: res.status, text: res.body.toString('utf8') };
  }

  private async contactSnapshot(tx: Db, contactId: string) {
    const [c] = await tx.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    if (!c) return null;
    const tags = await tx
      .select({ name: schema.tags.name })
      .from(schema.contactTags)
      .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
      .where(eq(schema.contactTags.contactId, contactId));
    return {
      id: c.id,
      name: displayName(c),
      first_name: c.firstName,
      last_name: c.lastName,
      email: c.email,
      phone: c.phone,
      company: c.company,
      lifecycle_stage: c.lifecycleStage,
      lead_score: c.leadScore,
      lead_tier: c.leadTier,
      qualification_status: c.qualificationStatus,
      custom_fields: c.customFields,
      tags: tags.map((t) => t.name),
      source_channel: c.sourceChannel,
      first_touch: touchForWebhook(c.firstTouch),
      consent: consentForWebhook(c.consent),
    };
  }

  // ---------- webhook endpoints (dashboard) ----------

  async listEndpoints(scope: Scope) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.webhookEndpoints)
        .where(eq(schema.webhookEndpoints.organizationId, scope.orgId))
        .orderBy(asc(schema.webhookEndpoints.createdAt));
      return rows.map(({ secretEnc: _secret, ...rest }) => rest);
    });
  }

  async createEndpoint(scope: Scope, input: z.infer<typeof WebhookEndpointSchema>) {
    await assertSafeUrl(input.url, { allowPrivate: this.opts.allowPrivateUrls });
    const secret = randomToken('whsec', 24);
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .insert(schema.webhookEndpoints)
        .values({ organizationId: scope.orgId, ...input, secretEnc: this.secrets.encrypt(secret) })
        .returning();
      const { secretEnc: _secret, ...rest } = row!;
      // The signing secret is shown once; store it in n8n to verify `x-omni-signature`.
      return { ...rest, secret };
    });
  }

  async updateEndpoint(scope: Scope, id: string, input: Partial<z.infer<typeof WebhookEndpointSchema>>) {
    if (input.url) await assertSafeUrl(input.url, { allowPrivate: this.opts.allowPrivateUrls });
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(schema.webhookEndpoints)
        .set(input)
        .where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.organizationId, scope.orgId)))
        .returning();
      if (!row) throw notFound('Webhook endpoint');
      const { secretEnc: _secret, ...rest } = row;
      return rest;
    });
  }

  async deleteEndpoint(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, (tx) =>
      tx.delete(schema.webhookEndpoints).where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.organizationId, scope.orgId))),
    );
  }

  async listDeliveries(scope: Scope, endpointId: string) {
    return inScope(this.tenantDb, scope, (tx) =>
      tx
        .select()
        .from(schema.webhookDeliveries)
        .where(and(eq(schema.webhookDeliveries.endpointId, endpointId), eq(schema.webhookDeliveries.organizationId, scope.orgId)))
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(100),
    );
  }

  // ---------- workflows (dashboard) ----------

  async listWorkflows(scope: Scope) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx.select().from(schema.workflows).where(eq(schema.workflows.organizationId, scope.orgId)).orderBy(asc(schema.workflows.key));
      return rows.map(({ secretEnc: _secret, ...rest }) => rest);
    });
  }

  async createWorkflow(scope: Scope, input: z.infer<typeof WorkflowSchema>) {
    await assertSafeUrl(input.url, { allowPrivate: this.opts.allowPrivateUrls });
    const secret = randomToken('whsec', 24);
    return inScope(this.tenantDb, scope, async (tx) => {
      const existing = await tx
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.organizationId, scope.orgId), eq(schema.workflows.key, input.key)));
      if (existing.length) throw badRequest(`A workflow with key "${input.key}" already exists`);
      const [row] = await tx
        .insert(schema.workflows)
        .values({ organizationId: scope.orgId, ...input, secretEnc: this.secrets.encrypt(secret) })
        .returning();
      const { secretEnc: _secret, ...rest } = row!;
      return { ...rest, secret };
    });
  }

  async updateWorkflow(scope: Scope, id: string, input: Partial<Omit<z.infer<typeof WorkflowSchema>, 'key'>>) {
    if (input.url) await assertSafeUrl(input.url, { allowPrivate: this.opts.allowPrivateUrls });
    return inScope(this.tenantDb, scope, async (tx) => {
      const [row] = await tx
        .update(schema.workflows)
        .set(input)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, scope.orgId)))
        .returning();
      if (!row) throw notFound('Workflow');
      const { secretEnc: _secret, ...rest } = row;
      return rest;
    });
  }

  async deleteWorkflow(scope: Scope, id: string) {
    await inScope(this.tenantDb, scope, (tx) =>
      tx.delete(schema.workflows).where(and(eq(schema.workflows.id, id), eq(schema.workflows.organizationId, scope.orgId))),
    );
  }

  // ---------- notifications & activity ----------

  /**
   * A member's notifications: the organization-wide ones plus their own. Read state is per member: `readAt` is when
   * this member read it (organization-wide ones read before per-member reads existed stay read for everyone).
   * Without a member, only the organization-wide ones, with their shared read state.
   */
  async listNotifications(scope: Scope, userId: string | null, opts: { unreadOnly?: boolean } = {}) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const n = schema.notifications;
      const r = schema.notificationReads;
      const readAt = userId ? sql<Date | null>`coalesce(${n.readAt}, ${r.readAt})` : sql<Date | null>`${n.readAt}`;
      const where = [eq(n.organizationId, scope.orgId), userId ? or(isNull(n.userId), eq(n.userId, userId))! : isNull(n.userId)];
      if (opts.unreadOnly) where.push(sql`${readAt} is null`);
      const rows = await tx
        .select({ n, readAt })
        .from(n)
        .leftJoin(r, and(eq(r.notificationId, n.id), eq(r.userId, userId ?? '00000000-0000-0000-0000-000000000000')))
        .where(and(...where))
        .orderBy(desc(n.createdAt))
        .limit(100);
      return rows.map((row) => ({ ...row.n, readAt: row.readAt ? new Date(row.readAt) : null }));
    });
  }

  async markNotificationsRead(scope: Scope, userId: string, ids: string[] | 'all') {
    await inScope(this.tenantDb, scope, async (tx) => {
      const n = schema.notifications;
      const visible = await tx
        .select({ id: n.id, userId: n.userId })
        .from(n)
        .where(
          and(
            eq(n.organizationId, scope.orgId),
            isNull(n.readAt),
            or(isNull(n.userId), eq(n.userId, userId)),
            ids === 'all' ? undefined : inArray(n.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
          ),
        );
      // A member's own notification is simply read; an organization-wide one is read by this member only.
      const own = visible.filter((v) => v.userId === userId).map((v) => v.id);
      if (own.length) await tx.update(n).set({ readAt: new Date() }).where(inArray(n.id, own));
      const shared = visible.filter((v) => !v.userId);
      if (shared.length) {
        await tx
          .insert(schema.notificationReads)
          .values(shared.map((v) => ({ notificationId: v.id, userId, organizationId: scope.orgId })))
          .onConflictDoNothing();
      }
    });
  }

  private async emailOf(tx: Db, userId: string): Promise<string[]> {
    const [u] = await tx.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
    return u?.email ? [u.email] : [];
  }

  async listEvents(scope: Scope, opts: { contactId?: string; limit?: number }) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .select({ event: schema.events, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, email: schema.contacts.email })
        .from(schema.events)
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.events.contactId))
        .where(
          and(
            eq(schema.events.organizationId, scope.orgId),
            opts.contactId ? eq(schema.events.contactId, opts.contactId) : undefined,
            // Messages to chat-API customers exist for webhooks; the conversation already shows them.
            ne(schema.events.type, 'message.outbound'),
            // Test (playground) contacts stay out of the org-wide feed, as they do out of notifications and webhooks
            // (a test contact's own page still shows its history).
            opts.contactId ? undefined : sql`coalesce(${schema.contacts.isTest}, false) = false`,
          ),
        )
        .orderBy(desc(schema.events.createdAt))
        .limit(Math.min(opts.limit ?? 100, 500));
      return rows.map((r) => ({ ...r.event, contactName: displayName({ firstName: r.firstName, lastName: r.lastName }) ?? r.email ?? null }));
    });
  }
}
