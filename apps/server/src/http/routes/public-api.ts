import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { badRequest } from '../../lib/errors';
import { parseInput } from '../../lib/validation';
import { convChannel, type MessageView, type RealtimeEvent } from '../../modules/conversations/service';
import { requireRole, requireScope } from '../../modules/auth/service';
import { requireAccess } from '../auth';

/** After a message of the turn, how long to wait for more (a follow-up, the status change) if `ai.done` never comes. */
const SETTLE_MS = 3_000;
/** A turn that ends without a message may still hand off with an apology right after. */
const APOLOGY_MS = 1_500;

/**
 * Server-to-server chat for other apps and n8n: send a customer message, optionally wait for the
 * assistant's reply. Authenticated with an org API key that has `conversations:write`. Every message
 * the customer should see also goes out as a `message.outbound` webhook, and can be polled.
 */
export async function registerPublicApiRoutes(app: FastifyInstance, c: Container) {
  app.post('/channels/api/messages', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'conversations:write');
    const input = parseInput(
      z.object({
        externalUserId: z.string().trim().min(1).max(200).describe('Your stable id for this customer'),
        content: z.string().trim().min(1).max(4000),
        messageId: z.string().max(200).optional().describe('Idempotency key'),
        contact: z
          .object({
            name: z.string().max(200).optional(),
            email: z.string().max(254).optional(),
            phone: z.string().max(40).optional(),
            /**
             * Your app proved this person owns the email/phone (e.g. they are signed in). Only then does a match merge
             * this customer into the existing contact; otherwise it becomes a duplicate review for staff. Needs the
             * `contacts:verify` scope (or an admin session).
             */
            verified: z.boolean().default(false),
            /** E.g. a form's opt-in checkbox: its answer and its label (the label is required for a yes). */
            marketingConsent: z.object({ granted: z.boolean(), text: z.string().trim().max(1000).optional() }).optional(),
          })
          .optional(),
        /** Where this customer came from: landingPage, referrer, utmSource/Medium/Campaign/Term/Content, gclid/fbclid/msclkid, at. */
        source: z.record(z.string(), z.unknown()).optional(),
        /** The customer's IANA timezone (e.g. America/Vancouver), kept when none is known yet. */
        timezone: z.string().max(64).optional(),
        wait: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
      }),
      req.body,
    );
    if (input.contact?.verified) {
      if (auth.kind === 'api_key') requireScope(auth, 'contacts:verify');
      else requireRole(auth, 'admin');
    }
    const consent = input.contact?.marketingConsent;
    if (consent?.granted && !consent.text) throw badRequest('marketingConsent.text is required for a yes: send the wording the customer agreed to');
    const channel = await c.channels.ensureSystemChannel(auth.orgId, 'api');
    const scope = { orgId: auth.orgId };

    const result = await c.conversations.receiveInbound({
      orgId: auth.orgId,
      channelAccountId: channel.id,
      externalUserId: input.externalUserId,
      content: input.content,
      externalMessageId: input.messageId,
      // Kept on a new conversation, so every message to this customer names them (`message.outbound`).
      metadata: { externalUserId: input.externalUserId },
      firstTouch: input.source,
      timezone: input.timezone,
    });
    let contactId = result.contactId;
    // A retried message (same messageId) was handled the first time: don't record its details or consent again.
    if (!result.duplicate && input.contact && (input.contact.name || input.contact.email || input.contact.phone)) {
      // Form fields are typed by the customer, so an email/phone someone else owns only merges when the app vouches
      // for it; otherwise staff review the match, and this customer never sees the other contact's data.
      const { name, email, phone, verified } = input.contact;
      const trust = verified ? 'verified' : 'unverified';
      contactId = (await c.contacts.captureDetails(scope, contactId, { name, email, phone }, 'contact', { trust, conversationId: result.conversationId })).contactId;
    }
    if (!result.duplicate && consent) {
      await c.contacts.recordConsent(scope, contactId, { purpose: 'marketing', granted: consent.granted, text: consent.text, source: 'api', conversationId: result.conversationId });
    }
    const base = { conversationId: result.conversationId, contactId, message: result.message };
    if (!input.wait || !result.aiQueued) return reply.status(202).send({ ...base, reply: null, replies: [] });

    // The reply job is debounced, so subscribing now cannot miss it. A turn's messages (the reply, a follow-up such
    // as the opt-in question, a handoff message) all come before `ai.done`, or before the status changes on a handoff.
    const replies: MessageView[] = [];
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    let settle: NodeJS.Timeout | undefined;
    const settleIn = (ms: number) => {
      clearTimeout(settle);
      settle = setTimeout(finish, ms);
    };
    const unsubscribe = c.pubsub.subscribe(convChannel(result.conversationId), (raw) => {
      const e = raw as RealtimeEvent;
      if (e.type === 'message' && e.message.direction === 'outbound') {
        replies.push(e.message);
        settleIn(SETTLE_MS);
      } else if (e.type === 'conversation.status') finish();
      else if (e.type === 'ai.done') {
        if (replies.length) finish();
        else settleIn(APOLOGY_MS);
      }
    });
    const timer = setTimeout(finish, input.timeoutMs);
    try {
      await finished;
      return { ...base, reply: replies[0] ?? null, replies };
    } finally {
      clearTimeout(timer);
      clearTimeout(settle);
      unsubscribe();
    }
  });

  /**
   * For integrations without webhooks: the customer's latest conversation (open, else the last closed one) and its
   * messages after `after` (a message ID), oldest first; without `after`, the latest `limit`.
   */
  app.get('/channels/api/messages', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'conversations:write');
    const q = parseInput(
      z.object({
        externalUserId: z.string().trim().min(1).max(200),
        after: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    const scope = { orgId: auth.orgId };
    const channel = await c.channels.ensureSystemChannel(auth.orgId, 'api');
    const conv = await c.conversations.latestForIdentity(scope, channel.id, 'api', q.externalUserId);
    if (!conv) return { conversationId: null, status: null, messages: [] };
    const messages = await c.conversations.messages(scope, conv.id, { after: q.after, limit: q.limit });
    return { conversationId: conv.id, status: conv.status, messages };
  });
}
