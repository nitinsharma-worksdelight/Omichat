import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { badRequest } from '../../lib/errors';
import { parseInput, parsePatch } from '../../lib/validation';
import { ContactInputSchema, ContactListSchema, CustomFieldDefSchema } from '../../modules/contacts/service';
import { actorUserId, requireAccess, requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });

export async function registerContactRoutes(app: FastifyInstance, c: Container) {
  // ---- contacts / leads ----
  app.get('/contacts', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.list({ orgId: auth.orgId }, parseInput(ContactListSchema, req.query));
  });

  app.post('/contacts', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    // `source`: where an integration's lead came from (the same fields the widget reports).
    const { source, ...input } = parseInput(ContactInputSchema.extend({ source: z.record(z.string(), z.unknown()).optional() }), req.body);
    return reply.status(201).send(await c.contacts.create({ orgId: auth.orgId }, input, actorUserId(auth), { source }));
  });

  /** The UTM values in use, for source filters. */
  app.get('/contacts/source-options', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.sourceOptions({ orgId: auth.orgId });
  });

  // ---- consent (history is append-only: a change of mind is a new record) ----
  app.get('/contacts/:id/consents', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listConsents({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/contacts/:id/consents', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const input = parseInput(
      z.object({
        purpose: z.enum(['marketing']),
        granted: z.boolean(),
        /** The wording the customer agreed to (a form's checkbox label, say). */
        text: z.string().trim().min(1).max(1000).optional(),
        /** Staff: how and when the customer agreed or asked ("by phone on 5 October"). */
        note: z.string().trim().min(1).max(500).optional(),
      }),
      req.body,
    );
    const userId = actorUserId(auth);
    if (userId && !input.note) throw badRequest('Add a note saying how the customer agreed or asked');
    if (!userId && input.granted && !input.text) throw badRequest('Include the text the customer agreed to');
    const record = await c.contacts.recordConsent({ orgId: auth.orgId }, parseInput(Id, req.params).id, {
      ...input,
      source: userId ? 'staff' : 'api',
      actorUserId: userId ?? null,
    });
    return reply.status(201).send(record);
  });

  app.get('/contacts/:id', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.get({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.patch('/contacts/:id', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    return c.contacts.update({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(ContactInputSchema, req.body), actorUserId(auth));
  });

  app.delete('/contacts/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.contacts.delete({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.post('/contacts/:id/qualification/reset', async (req) => {
    const auth = await requireUser(c, req, 'agent');
    await c.qualification.reset({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return { ok: true };
  });

  app.get('/contacts/:id/appointments', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.scheduling.listForContact({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.get('/contacts/:id/events', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.automation.listEvents({ orgId: auth.orgId }, { contactId: parseInput(Id, req.params).id, limit: 200 });
  });

  app.get('/contacts/:id/conversations', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'conversations:read');
    return c.conversations.list({ orgId: auth.orgId }, { contactId: parseInput(Id, req.params).id, includeTest: true, limit: 50, offset: 0 });
  });

  // ---- duplicate reviews (an email/phone given in a chat that belongs to another contact) ----
  app.get('/contacts/:id/merge-candidates', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listMergeCandidates({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  /** Folds this contact into `intoContactId`: identities, conversations, appointments, notes, tasks and tags move over. */
  app.post('/contacts/:id/merge', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const { intoContactId } = parseInput(z.object({ intoContactId: z.string().uuid() }), req.body);
    return c.contacts.mergeContacts({ orgId: auth.orgId }, { duplicateId: parseInput(Id, req.params).id, primaryId: intoContactId }, actorUserId(auth));
  });

  app.post('/merge-candidates/:id/dismiss', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    return c.contacts.dismissMergeCandidate({ orgId: auth.orgId }, parseInput(Id, req.params).id, actorUserId(auth));
  });

  // ---- tags ----
  app.get('/tags', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listTags({ orgId: auth.orgId });
  });

  app.post('/tags', async (req, reply) => {
    const auth = await requireUser(c, req, 'agent');
    const input = parseInput(z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }), req.body);
    return reply.status(201).send(await c.contacts.createTag({ orgId: auth.orgId }, input));
  });

  app.delete('/tags/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.contacts.deleteTag({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.post('/contacts/:id/tags', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const { tags } = parseInput(z.object({ tags: z.array(z.string().trim().min(1).max(60)).min(1).max(20) }), req.body);
    return c.contacts.addTags({ orgId: auth.orgId }, parseInput(Id, req.params).id, tags, { addedBy: 'user', allowCreate: true });
  });

  app.delete('/contacts/:id/tags/:tagId', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const p = parseInput(z.object({ id: z.string().uuid(), tagId: z.string().uuid() }), req.params);
    await c.contacts.removeTag({ orgId: auth.orgId }, p.id, p.tagId, actorUserId(auth));
    return reply.status(204).send();
  });

  // ---- notes ----
  app.get('/contacts/:id/notes', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listNotes({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  /** `shareWithAssistant`: also remember the note as a team fact the AI uses with this customer (off by default). */
  app.post('/contacts/:id/notes', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const { body, shareWithAssistant } = parseInput(
      z.object({ body: z.string().trim().min(1).max(4000), shareWithAssistant: z.boolean().default(false) }),
      req.body,
    );
    return reply
      .status(201)
      .send(await c.contacts.addNote({ orgId: auth.orgId }, parseInput(Id, req.params).id, body, 'user', actorUserId(auth), { shareWithAssistant }));
  });

  // ---- what the AI remembers about the contact ----
  app.post('/contacts/:id/memory', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const { text } = parseInput(z.object({ text: z.string().trim().min(1).max(500) }), req.body);
    return reply.status(201).send(await c.contacts.addFact({ orgId: auth.orgId }, parseInput(Id, req.params).id, text, actorUserId(auth)));
  });

  app.delete('/contacts/:id/memory/:factId', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const p = parseInput(z.object({ id: z.string().uuid(), factId: z.string().min(1).max(80) }), req.params);
    await c.contacts.removeFact({ orgId: auth.orgId }, p.id, p.factId, actorUserId(auth));
    return reply.status(204).send();
  });

  // ---- tasks ----
  app.get('/tasks', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listTasks(
      { orgId: auth.orgId },
      parseInput(z.object({ status: z.enum(['open', 'done']).optional(), contactId: z.string().uuid().optional() }), req.query),
    );
  });

  app.post('/tasks', async (req, reply) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const input = parseInput(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4000).optional(),
        contactId: z.string().uuid().nullable().optional(),
        dueAt: z.coerce.date().nullable().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        assigneeUserId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    return reply.status(201).send(await c.contacts.createTask({ orgId: auth.orgId }, { ...input, createdBy: 'user' }));
  });

  app.patch('/tasks/:id', async (req) => {
    const auth = await requireAccess(c, req, 'agent', 'contacts:write');
    const input = parseInput(
      z.object({
        status: z.enum(['open', 'done']).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        dueAt: z.coerce.date().nullable().optional(),
        assigneeUserId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    return c.contacts.updateTask({ orgId: auth.orgId }, parseInput(Id, req.params).id, input);
  });

  // ---- custom fields ----
  app.get('/custom-fields', async (req) => {
    const auth = await requireAccess(c, req, 'viewer', 'contacts:read');
    return c.contacts.listFieldDefs({ orgId: auth.orgId });
  });

  app.post('/custom-fields', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.contacts.createFieldDef({ orgId: auth.orgId }, parseInput(CustomFieldDefSchema, req.body)));
  });

  app.patch('/custom-fields/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.contacts.updateFieldDef({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(CustomFieldDefSchema.omit({ key: true }).partial(), req.body));
  });

  app.delete('/custom-fields/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.contacts.deleteFieldDef({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });
}
