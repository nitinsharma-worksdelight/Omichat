import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { badRequest } from '../../lib/errors';
import { parseInput, parsePatch } from '../../lib/validation';
import {
  DocumentUpdateSchema,
  FaqDocumentSchema,
  KnowledgeBaseInputSchema,
  TextDocumentSchema,
  UrlDocumentSchema,
} from '../../modules/knowledge/service';
import { requireAccess, requireUser } from '../auth';

const Id = z.object({ id: z.string().uuid() });
const Category = z.enum(['general', 'faq', 'services', 'pricing', 'policies', 'other']);

export async function registerKnowledgeRoutes(app: FastifyInstance, c: Container) {
  app.get('/knowledge-bases', async (req) => {
    const auth = await requireUser(c, req);
    return c.knowledge.listKnowledgeBases({ orgId: auth.orgId });
  });

  app.post('/knowledge-bases', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    return reply.status(201).send(await c.knowledge.createKnowledgeBase({ orgId: auth.orgId }, parseInput(KnowledgeBaseInputSchema, req.body)));
  });

  app.patch('/knowledge-bases/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.knowledge.updateKnowledgeBase({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(KnowledgeBaseInputSchema.partial(), req.body));
  });

  app.delete('/knowledge-bases/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.knowledge.deleteKnowledgeBase({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  app.get('/knowledge-bases/:id/documents', async (req) => {
    const auth = await requireUser(c, req);
    return c.knowledge.listDocuments({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.post('/knowledge-bases/:id/documents', async (req, reply) => {
    const auth = await requireAccess(c, req, 'admin', 'knowledge:write');
    const kbId = parseInput(Id, req.params).id;
    const body = parseInput(z.object({ type: z.enum(['text', 'faq', 'url']) }).passthrough(), req.body);
    if (body.type !== 'url' && body.refreshIntervalHours != null) throw badRequest('Only website documents can refresh on a schedule');
    const scope = { orgId: auth.orgId };
    const doc =
      body.type === 'text'
        ? await c.knowledge.createTextDocument(scope, kbId, parseInput(TextDocumentSchema, body))
        : body.type === 'faq'
          ? await c.knowledge.createFaqDocument(scope, kbId, parseInput(FaqDocumentSchema, body))
          : await c.knowledge.createUrlDocument(scope, kbId, parseInput(UrlDocumentSchema, body));
    return reply.status(201).send(doc);
  });

  /** multipart/form-data with one `file`; `title` and `category` go in the query string. */
  app.post('/knowledge-bases/:id/upload', async (req, reply) => {
    const auth = await requireAccess(c, req, 'admin', 'knowledge:write');
    const kbId = parseInput(Id, req.params).id;
    const q = parseInput(z.object({ title: z.string().trim().max(200).optional(), category: Category.optional() }), req.query);
    const file = await req.file();
    if (!file) throw badRequest('Attach a file in the "file" field');
    const buffer = await file.toBuffer();
    const doc = await c.knowledge.createFileDocument({ orgId: auth.orgId }, kbId, {
      filename: file.filename,
      mimeType: file.mimetype,
      buffer,
      title: q.title,
      category: q.category,
    });
    return reply.status(201).send(doc);
  });

  app.get('/documents/:id', async (req) => {
    const auth = await requireUser(c, req);
    return c.knowledge.getDocument({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.get('/documents/:id/chunks', async (req) => {
    const auth = await requireUser(c, req);
    return c.knowledge.listChunks({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.patch('/documents/:id', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.knowledge.updateDocument({ orgId: auth.orgId }, parseInput(Id, req.params).id, parsePatch(DocumentUpdateSchema, req.body));
  });

  app.post('/documents/:id/reingest', async (req) => {
    const auth = await requireUser(c, req, 'admin');
    return c.knowledge.reingest({ orgId: auth.orgId }, parseInput(Id, req.params).id);
  });

  app.delete('/documents/:id', async (req, reply) => {
    const auth = await requireUser(c, req, 'admin');
    await c.knowledge.deleteDocument({ orgId: auth.orgId }, parseInput(Id, req.params).id);
    return reply.status(204).send();
  });

  /** Languages a knowledge base's keyword search can use (the database's text search dictionaries). */
  app.get('/knowledge/languages', async (req) => {
    await requireUser(c, req);
    return c.knowledge.listLanguages();
  });

  /** Try retrieval directly — shows exactly what the bot would be given for a question. */
  app.post('/knowledge/search', async (req) => {
    const auth = await requireUser(c, req);
    const input = parseInput(
      z.object({ knowledgeBaseIds: z.array(z.string().uuid()).min(1), query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(20).optional() }),
      req.body,
    );
    return c.knowledge.search({ orgId: auth.orgId }, input);
  });
}
