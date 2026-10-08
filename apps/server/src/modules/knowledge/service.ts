import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { rowsOf, schema, type Db } from '../../db/client';
import type { DocumentCategory } from '../../db/schema';
import { inScope, type Scope, type TenantDb } from '../../db/tenant';
import type { QueueDriver } from '../../infra/queue';
import type { StorageDriver } from '../../infra/storage';
import { sha256 } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Logger } from '../../lib/logger';
import { assertSafeUrl } from '../../lib/net';
import { chunkFaq, chunkSections, type Chunk } from './chunker';
import { STOP, words, type EmbeddingProvider } from './embeddings';
import { detectFileKind, extractFromFile, extractFromUrl, type Section } from './extract';

const Category = z.enum(['general', 'faq', 'services', 'pricing', 'policies', 'other']).default('general');
/** Website documents can be re-fetched daily or weekly; null = never. */
const RefreshInterval = z.union([z.literal(24), z.literal(168)]).nullable();

export const KnowledgeBaseInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(''),
  /** A text search configuration of the database ('english', 'spanish', 'hindi', …, or 'simple' for any language). */
  language: z.string().trim().toLowerCase().min(1).max(63).optional(),
});

export const TextDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(500_000),
  category: Category,
});

export const FaqDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).default('FAQs'),
  faq: z
    .array(z.object({ question: z.string().trim().min(1).max(1000), answer: z.string().trim().min(1).max(10_000) }))
    .min(1)
    .max(1000),
  category: Category.default('faq'),
});

export const UrlDocumentSchema = z.object({
  url: z.string().trim().url(),
  title: z.string().trim().max(200).optional(),
  crawl: z.boolean().default(false),
  maxPages: z.number().int().min(1).max(50).default(10),
  category: Category,
  refreshIntervalHours: RefreshInterval.optional(),
});

export const DocumentUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(500_000).optional(),
  faq: FaqDocumentSchema.shape.faq.optional(),
  category: z.enum(['general', 'faq', 'services', 'pricing', 'policies', 'other']).optional(),
  refreshIntervalHours: RefreshInterval.optional(),
});

/**
 * Words for keyword search. Unlike the embedder's tokens there is no English plural-stripping: each knowledge
 * base's own text search configuration stems (and drops its language's stop words) on the Postgres side.
 */
export function searchTerms(query: string): string[] {
  return [...new Set(words(query).filter((w) => !STOP.has(w)))].slice(0, 30);
}

export function languageLabel(language: string): string {
  return language === 'simple' ? 'Any language (exact words)' : language.charAt(0).toUpperCase() + language.slice(1);
}

const HOUR_MS = 3_600_000;

export interface RetrievedChunk {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  url: string | null;
  category: string | null;
  similarity: number | null;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** grounded: clearly relevant material found · weak: only loosely related · none: nothing found */
  grounding: 'grounded' | 'weak' | 'none';
  bestSimilarity: number | null;
}

const RRF_K = 60;
const CANDIDATES = 20;

type DocumentRow = typeof schema.documents.$inferSelect;

function toDocumentView(d: DocumentRow) {
  return {
    id: d.id,
    knowledgeBaseId: d.knowledgeBaseId,
    title: d.title,
    sourceType: d.sourceType,
    category: d.category,
    sourceUri: d.sourceUri,
    options: d.options,
    mimeType: d.mimeType,
    fileSize: d.fileSize,
    status: d.status,
    error: d.error,
    chunkCount: d.chunkCount,
    tokenCount: d.tokenCount,
    lastIngestedAt: d.lastIngestedAt,
    refreshIntervalHours: d.refreshIntervalHours,
    nextRefreshAt: d.nextRefreshAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    // Bodies are returned only for editable source types.
    content: d.sourceType === 'text' ? d.content : undefined,
    faq: d.sourceType === 'faq' ? d.faq : undefined,
  };
}

export class KnowledgeService {
  private iterativeScan = false;
  /** Text search configurations the database has; read once in init(). */
  private languages = new Set(['english', 'simple']);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StorageDriver,
    private readonly embeddings: EmbeddingProvider,
    private readonly queue: QueueDriver,
    private readonly logger: Logger,
    private readonly opts: { allowPrivateUrls: boolean; maxUploadBytes: number },
  ) {}

  /** pgvector ≥ 0.8 can keep scanning the HNSW index until enough rows pass the tenant filter. */
  async init(db: Db): Promise<void> {
    const [row] = rowsOf<{ extversion: string }>(
      await db.execute(sql`select extversion from pg_extension where extname = 'vector'`),
    );
    const [major = 0, minor = 0] = (row?.extversion ?? '0.0').split('.').map(Number);
    this.iterativeScan = major > 0 || minor >= 8;
    const configs = rowsOf<{ cfgname: string }>(
      await db.execute(sql`select cfgname from pg_ts_config where cfgnamespace = 'pg_catalog'::regnamespace`),
    );
    if (configs.length) this.languages = new Set(configs.map((c) => c.cfgname));
  }

  /** Languages keyword search can stem, as the database provides them; 'Any language' last. */
  listLanguages() {
    const named = [...this.languages].filter((l) => l !== 'simple').sort();
    return [...named, 'simple'].map((value) => ({ value, label: languageLabel(value) }));
  }

  private assertLanguage(language: string | undefined) {
    if (language !== undefined && !this.languages.has(language)) {
      throw badRequest(`Keyword search has no "${language}" dictionary. Use one of: ${[...this.languages].sort().join(', ')}`);
    }
  }

  /** A language the database can no longer resolve (e.g. after moving servers) falls back to exact words. */
  private searchConfig(language: string | undefined) {
    return language && this.languages.has(language) ? language : 'simple';
  }

  /** The languages of these knowledge bases' documents, as the prompt names them ('simple' names none). */
  async languagesOf(scope: Scope, kbIds: string[]): Promise<string[]> {
    if (!kbIds.length) return [];
    return inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .selectDistinct({ language: schema.knowledgeBases.language })
        .from(schema.knowledgeBases)
        .where(and(eq(schema.knowledgeBases.organizationId, scope.orgId), inArray(schema.knowledgeBases.id, kbIds)));
      return rows.map((r) => r.language).filter((l) => l !== 'simple').sort().map(languageLabel);
    });
  }

  /**
   * Queues website documents whose refresh is due. Claiming moves next_refresh_at on by a 6-hour lease first, so
   * overlapping sweeps don't double up and a lost job is retried; ingestion then sets the real next time.
   * Unchanged pages cost one fetch (the content hash matches); changed ones are re-embedded. System-level.
   */
  async enqueueDueRefreshes(db: Db): Promise<number> {
    const due = rowsOf<{ id: string; organization_id: string; next_refresh_at: string | Date }>(
      await db.execute(sql`
        update documents set next_refresh_at = now() + interval '6 hours'
        where id in (
          select id from documents
          where refresh_interval_hours is not null and next_refresh_at <= now() and source_type = 'url'
          order by next_refresh_at
          limit 100
          for update skip locked)
        returning id, organization_id, next_refresh_at`),
    );
    for (const d of due) {
      const jobId = `refresh_${d.id}_${new Date(d.next_refresh_at).getTime()}`;
      await this.queue.add('ingest', { orgId: d.organization_id, documentId: d.id }, { jobId, attempts: 3, backoffMs: 5_000 });
    }
    if (due.length) this.logger.info({ documents: due.length }, 'refreshing website documents');
    return due.length;
  }

  /**
   * Vectors from different embedding models aren't comparable. When EMBEDDINGS_PROVIDER/MODEL changes,
   * queue every document embedded with another model for re-ingestion (search ignores its old vectors
   * meanwhile; keyword search still finds it). System-level: runs across all organizations.
   */
  async reembedStale(db: Db): Promise<number> {
    const stale = rowsOf<{ organization_id: string; document_id: string }>(
      await db.execute(sql`
        select distinct d.organization_id, d.id as document_id
        from documents d join document_chunks c on c.document_id = d.id
        where c.embedding_model is distinct from ${this.embeddings.model}`),
    );
    const tag = this.embeddings.model.replace(/[^A-Za-z0-9_-]/g, '_');
    if (stale.length) {
      // Forget the content hash so ingestion doesn't treat these documents as unchanged.
      await db
        .update(schema.documents)
        .set({ contentHash: null })
        .where(inArray(schema.documents.id, stale.map((s) => s.document_id)));
    }
    for (const row of stale) {
      await this.queue.add('ingest', { orgId: row.organization_id, documentId: row.document_id }, { jobId: `reembed_${row.document_id}_${tag}`, attempts: 3, backoffMs: 5_000, removeOnFail: true });
    }
    if (stale.length) this.logger.info({ documents: stale.length, model: this.embeddings.model }, 're-embedding documents for the current embedding model');
    return stale.length;
  }

  // ---------- knowledge bases ----------

  async listKnowledgeBases(scope: Scope) {
    return inScope(this.tenantDb, scope, async (tx) => {
      const kbs = await tx
        .select()
        .from(schema.knowledgeBases)
        .where(eq(schema.knowledgeBases.organizationId, scope.orgId))
        .orderBy(asc(schema.knowledgeBases.createdAt));
      const counts = await tx
        .select({ kbId: schema.documents.knowledgeBaseId, n: count() })
        .from(schema.documents)
        .where(eq(schema.documents.organizationId, scope.orgId))
        .groupBy(schema.documents.knowledgeBaseId);
      const byKb = new Map(counts.map((c) => [c.kbId, c.n]));
      return kbs.map((kb) => ({ ...kb, documentCount: byKb.get(kb.id) ?? 0 }));
    });
  }

  async createKnowledgeBase(scope: Scope, input: z.infer<typeof KnowledgeBaseInputSchema>) {
    this.assertLanguage(input.language);
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.assertNameFree(tx, scope.orgId, input.name);
      const [row] = await tx.insert(schema.knowledgeBases).values({ organizationId: scope.orgId, ...input }).returning();
      return row!;
    });
  }

  /** Names are unique per organization, ignoring case ("General" and "general" would be told apart by nobody). */
  private async assertNameFree(tx: Db, orgId: string, name: string, exceptId?: string) {
    const [same] = await tx
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(
        and(
          eq(schema.knowledgeBases.organizationId, orgId),
          sql`lower(btrim(${schema.knowledgeBases.name})) = lower(${name.trim()})`,
          exceptId ? ne(schema.knowledgeBases.id, exceptId) : undefined,
        ),
      )
      .limit(1);
    if (same) throw conflict('A knowledge base with this name already exists', [{ path: 'name', message: 'You already have a knowledge base with this name' }]);
  }

  async updateKnowledgeBase(scope: Scope, id: string, input: Partial<z.infer<typeof KnowledgeBaseInputSchema>>) {
    this.assertLanguage(input.language);
    return inScope(this.tenantDb, scope, async (tx) => {
      const where = and(eq(schema.knowledgeBases.id, id), eq(schema.knowledgeBases.organizationId, scope.orgId));
      const [before] = await tx.select({ language: schema.knowledgeBases.language }).from(schema.knowledgeBases).where(where).for('update');
      if (!before) throw notFound('Knowledge base');
      if (input.name !== undefined) await this.assertNameFree(tx, scope.orgId, input.name, id);
      const [row] = await tx.update(schema.knowledgeBases).set(input).where(where).returning();
      if (input.language !== undefined && input.language !== before.language) {
        // Keyword search reads each chunk in its knowledge base's language: re-read this one's (no re-embedding).
        await tx.execute(sql`
          update document_chunks set tsv = to_tsvector(${input.language}::regconfig, coalesce(title, '') || ' ' || content)
          where knowledge_base_id = ${id}::uuid`);
      }
      return row!;
    });
  }

  async deleteKnowledgeBase(scope: Scope, id: string) {
    const docs = await inScope(this.tenantDb, scope, async (tx) => {
      const rows = await tx
        .select({ storagePath: schema.documents.storagePath })
        .from(schema.documents)
        .where(and(eq(schema.documents.knowledgeBaseId, id), eq(schema.documents.organizationId, scope.orgId)));
      const deleted = await tx
        .delete(schema.knowledgeBases)
        .where(and(eq(schema.knowledgeBases.id, id), eq(schema.knowledgeBases.organizationId, scope.orgId)))
        .returning({ id: schema.knowledgeBases.id });
      if (!deleted.length) throw notFound('Knowledge base');
      return rows;
    });
    await Promise.allSettled(docs.filter((d) => d.storagePath).map((d) => this.storage.delete(d.storagePath!)));
  }

  private async assertKb(tx: Db, orgId: string, kbId: string) {
    const [kb] = await tx
      .select({ id: schema.knowledgeBases.id })
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.id, kbId), eq(schema.knowledgeBases.organizationId, orgId)));
    if (!kb) throw notFound('Knowledge base');
  }

  // ---------- documents ----------

  async listDocuments(scope: Scope, kbId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.assertKb(tx, scope.orgId, kbId);
      const rows = await tx
        .select()
        .from(schema.documents)
        .where(and(eq(schema.documents.knowledgeBaseId, kbId), eq(schema.documents.organizationId, scope.orgId)))
        .orderBy(desc(schema.documents.createdAt));
      return rows.map(toDocumentView);
    });
  }

  async getDocument(scope: Scope, id: string) {
    return inScope(this.tenantDb, scope, async (tx) => toDocumentView(await this.documentRow(tx, scope.orgId, id)));
  }

  async listChunks(scope: Scope, documentId: string) {
    return inScope(this.tenantDb, scope, async (tx) => {
      await this.documentRow(tx, scope.orgId, documentId);
      return tx
        .select({
          id: schema.documentChunks.id,
          chunkIndex: schema.documentChunks.chunkIndex,
          title: schema.documentChunks.title,
          content: schema.documentChunks.content,
          tokenCount: schema.documentChunks.tokenCount,
          metadata: schema.documentChunks.metadata,
        })
        .from(schema.documentChunks)
        .where(eq(schema.documentChunks.documentId, documentId))
        .orderBy(asc(schema.documentChunks.chunkIndex));
    });
  }

  async createTextDocument(scope: Scope, kbId: string, input: z.infer<typeof TextDocumentSchema>) {
    return this.insertDocument(scope, kbId, { title: input.title, sourceType: 'text', category: input.category, content: input.content });
  }

  async createFaqDocument(scope: Scope, kbId: string, input: z.infer<typeof FaqDocumentSchema>) {
    return this.insertDocument(scope, kbId, { title: input.title, sourceType: 'faq', category: input.category, faq: input.faq });
  }

  async createUrlDocument(scope: Scope, kbId: string, input: z.infer<typeof UrlDocumentSchema>) {
    const url = await assertSafeUrl(input.url, { allowPrivate: this.opts.allowPrivateUrls });
    return this.insertDocument(scope, kbId, {
      title: input.title || url.hostname + (url.pathname === '/' ? '' : url.pathname),
      sourceType: 'url',
      category: input.category,
      sourceUri: url.toString(),
      options: { crawl: input.crawl, maxPages: input.maxPages },
      // The first due time is set once the first fetch succeeds (or fails).
      refreshIntervalHours: input.refreshIntervalHours ?? null,
    });
  }

  async createFileDocument(
    scope: Scope,
    kbId: string,
    input: { filename: string; mimeType: string; buffer: Buffer; title?: string; category?: DocumentCategory },
  ) {
    if (!detectFileKind(input.mimeType, input.filename)) {
      throw badRequest('Unsupported file type. Upload PDF, DOCX, TXT, MD, CSV or HTML.');
    }
    if (input.buffer.length > this.opts.maxUploadBytes) throw badRequest('File is too large');
    const safeName = input.filename.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'upload';
    const doc = await this.insertDocument(
      scope,
      kbId,
      {
        title: input.title || safeName.replace(/\.[^.]+$/, ''),
        sourceType: 'file',
        category: input.category ?? 'general',
        mimeType: input.mimeType,
        fileSize: input.buffer.length,
      },
      async (row) => {
        const key = `${scope.orgId}/${row.id}/${safeName}`;
        await this.storage.put(key, input.buffer, input.mimeType);
        return { storagePath: key };
      },
    );
    return doc;
  }

  private async insertDocument(
    scope: Scope,
    kbId: string,
    values: Partial<typeof schema.documents.$inferInsert> & { title: string; sourceType: DocumentRow['sourceType'] },
    beforeEnqueue?: (row: DocumentRow) => Promise<Partial<typeof schema.documents.$inferInsert>>,
  ) {
    const row = await inScope(this.tenantDb, scope, async (tx) => {
      await this.assertKb(tx, scope.orgId, kbId);
      const [inserted] = await tx
        .insert(schema.documents)
        .values({ ...values, organizationId: scope.orgId, knowledgeBaseId: kbId, status: 'pending' })
        .returning();
      if (beforeEnqueue) {
        const extra = await beforeEnqueue(inserted!);
        const [updated] = await tx.update(schema.documents).set(extra).where(eq(schema.documents.id, inserted!.id)).returning();
        return updated!;
      }
      return inserted!;
    });
    await this.enqueueIngest(scope.orgId, row);
    return toDocumentView(row);
  }

  async updateDocument(scope: Scope, id: string, input: z.infer<typeof DocumentUpdateSchema>) {
    const { refreshIntervalHours, ...changes } = input;
    // Only a new title, body or question list changes the chunks; the category and refresh schedule don't.
    const rechunk = changes.title !== undefined || changes.content !== undefined || changes.faq !== undefined;
    const row = await inScope(this.tenantDb, scope, async (tx) => {
      const doc = await this.documentRow(tx, scope.orgId, id);
      if (changes.content !== undefined && doc.sourceType !== 'text') throw badRequest('Only text documents have editable content');
      if (changes.faq !== undefined && doc.sourceType !== 'faq') throw badRequest('Only FAQ documents have editable questions');
      if (refreshIntervalHours != null && doc.sourceType !== 'url') throw badRequest('Only website documents can refresh on a schedule');
      const patch: Partial<typeof schema.documents.$inferInsert> = { ...changes };
      if (rechunk) patch.status = 'pending';
      if (refreshIntervalHours !== undefined) {
        patch.refreshIntervalHours = refreshIntervalHours;
        patch.nextRefreshAt = refreshIntervalHours === null ? null : scheduledRefreshAt(doc, refreshIntervalHours);
      }
      if (changes.category !== undefined && changes.category !== doc.category) {
        // Search filters on the category stored with each chunk; unchanged content wouldn't be re-chunked.
        await tx.execute(sql`
          update document_chunks set metadata = jsonb_set(metadata, '{category}', to_jsonb(${changes.category}::text))
          where document_id = ${id}::uuid`);
      }
      if (!Object.keys(patch).length) return doc;
      const [updated] = await tx.update(schema.documents).set(patch).where(eq(schema.documents.id, id)).returning();
      return updated!;
    });
    if (rechunk) await this.enqueueIngest(scope.orgId, row);
    return toDocumentView(row);
  }

  async reingest(scope: Scope, id: string) {
    const row = await inScope(this.tenantDb, scope, async (tx) => {
      await this.documentRow(tx, scope.orgId, id);
      const [updated] = await tx
        .update(schema.documents)
        .set({ status: 'pending', contentHash: null })
        .where(eq(schema.documents.id, id))
        .returning();
      return updated!;
    });
    await this.enqueueIngest(scope.orgId, row);
    return toDocumentView(row);
  }

  async deleteDocument(scope: Scope, id: string) {
    const doc = await inScope(this.tenantDb, scope, async (tx) => {
      const row = await this.documentRow(tx, scope.orgId, id);
      await tx.delete(schema.documents).where(eq(schema.documents.id, id));
      return row;
    });
    if (doc.storagePath) await this.storage.delete(doc.storagePath).catch((err) => this.logger.warn({ err }, 'storage delete failed'));
  }

  private async enqueueIngest(orgId: string, row: DocumentRow) {
    // The version suffix lets an edit made during ingestion queue a fresh run instead of being deduped away.
    await this.queue.add('ingest', { orgId, documentId: row.id }, { jobId: `ingest_${row.id}_${row.updatedAt.getTime()}`, attempts: 3, backoffMs: 5_000 });
  }

  private async documentRow(tx: Db, orgId: string, id: string): Promise<DocumentRow> {
    const [row] = await tx
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.id, id), eq(schema.documents.organizationId, orgId)));
    if (!row) throw notFound('Document');
    return row;
  }

  // ---------- ingestion (worker) ----------

  /** Extract → chunk → embed → replace the document's chunks atomically. Idempotent per content hash. */
  async ingest(orgId: string, documentId: string, meta: { attempt: number; maxAttempts: number }): Promise<void> {
    const doc = await this.tenantDb.run(orgId, async (tx) => {
      const [row] = await tx
        .update(schema.documents)
        .set({ status: 'processing', error: null })
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.organizationId, orgId)))
        .returning();
      return row;
    });
    if (!doc) return; // deleted since it was queued

    try {
      const { chunks, fingerprint } = await this.buildChunks(doc);
      if (!chunks.length) throw badRequest('No text could be extracted from this document');
      const contentHash = sha256(`${this.embeddings.model}\n${fingerprint}`);
      if (doc.contentHash === contentHash && doc.chunkCount > 0) {
        await this.markReady(orgId, documentId, {});
        return;
      }
      const vectors = await this.embeddings.embed(
        chunks.map((c) => `${c.title}\n\n${c.content}`),
        'document',
      );
      await this.tenantDb.run(orgId, async (tx) => {
        // The share lock orders this against a language change, which rewrites the knowledge base's keyword index.
        const [kb] = await tx
          .select({ language: schema.knowledgeBases.language })
          .from(schema.knowledgeBases)
          .where(eq(schema.knowledgeBases.id, doc.knowledgeBaseId))
          .for('share');
        await tx.delete(schema.documentChunks).where(eq(schema.documentChunks.documentId, documentId));
        for (let i = 0; i < chunks.length; i += 200) {
          await tx.insert(schema.documentChunks).values(
            chunks.slice(i, i + 200).map((c, j) => ({
              organizationId: orgId,
              knowledgeBaseId: doc.knowledgeBaseId,
              documentId,
              chunkIndex: i + j,
              title: c.title,
              content: c.content,
              tokenCount: c.tokenCount,
              metadata: { heading: c.heading, page: c.page, url: c.url, category: doc.category },
              embedding: vectors[i + j]!,
              embeddingModel: this.embeddings.model,
            })),
          );
        }
        await tx.execute(sql`
          update document_chunks set tsv = to_tsvector(${this.searchConfig(kb?.language)}::regconfig, coalesce(title, '') || ' ' || content)
          where document_id = ${documentId}::uuid`);
      });
      await this.markReady(orgId, documentId, {
        contentHash,
        chunkCount: chunks.length,
        tokenCount: chunks.reduce((s, c) => s + c.tokenCount, 0),
      });
      this.logger.info({ orgId, documentId, chunks: chunks.length }, 'document ingested');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The previous chunks stay searchable; a scheduled refresh tries again within 6 hours.
      await this.tenantDb.run(orgId, (tx) =>
        tx
          .update(schema.documents)
          .set({ status: 'failed', error: message.slice(0, 1000), nextRefreshAt: nextRefreshSql('least(refresh_interval_hours, 6)') })
          .where(eq(schema.documents.id, documentId)),
      );
      // Client errors (bad file, unreachable URL) won't fix themselves; only retry the rest.
      const permanent = (err as { statusCode?: number }).statusCode === 400;
      if (!permanent && meta.attempt < meta.maxAttempts) throw err;
      this.logger.warn({ orgId, documentId, err: message }, 'document ingestion failed');
    }
  }

  private async markReady(orgId: string, documentId: string, extra: Partial<typeof schema.documents.$inferInsert>) {
    await this.tenantDb.run(orgId, (tx) =>
      tx
        .update(schema.documents)
        .set({ ...extra, status: 'ready', error: null, lastIngestedAt: new Date(), nextRefreshAt: nextRefreshSql('refresh_interval_hours') })
        .where(eq(schema.documents.id, documentId)),
    );
  }

  private async buildChunks(doc: DocumentRow): Promise<{ chunks: Chunk[]; fingerprint: string }> {
    switch (doc.sourceType) {
      case 'text': {
        const text = doc.content ?? '';
        return { chunks: chunkSections(doc.title, [{ text }]), fingerprint: `${doc.title}\n${text}` };
      }
      case 'faq': {
        const pairs = doc.faq ?? [];
        return { chunks: chunkFaq(doc.title, pairs), fingerprint: `${doc.title}\n${JSON.stringify(pairs)}` };
      }
      case 'url': {
        const { title, sections } = await extractFromUrl(doc.sourceUri!, {
          crawl: doc.options.crawl ?? false,
          maxPages: doc.options.maxPages ?? 10,
          allowPrivate: this.opts.allowPrivateUrls,
        });
        const docTitle = doc.title || title;
        return { chunks: chunkSections(docTitle, sections), fingerprint: `${docTitle}\n${fingerprintOf(sections)}` };
      }
      case 'file': {
        if (!doc.storagePath) throw badRequest('File is missing from storage');
        const buffer = await this.storage.get(doc.storagePath);
        const sections = await extractFromFile(buffer, doc.mimeType ?? '', doc.storagePath);
        return { chunks: chunkSections(doc.title, sections), fingerprint: `${doc.title}\n${fingerprintOf(sections)}` };
      }
    }
  }

  // ---------- retrieval ----------

  /**
   * Hybrid retrieval: vector similarity + Postgres full-text, fused with Reciprocal Rank Fusion.
   * The tenant and knowledge-base filters apply inside both queries, before ranking — never after.
   */
  async search(
    scope: Scope,
    input: { knowledgeBaseIds: string[]; query: string; limit?: number; category?: DocumentCategory },
  ): Promise<RetrievalResult> {
    const limit = input.limit ?? 5;
    const query = input.query.trim().slice(0, 2000);
    if (!input.knowledgeBaseIds.length || !query) return { chunks: [], grounding: 'none', bestSimilarity: null };
    const [queryVector] = await this.embeddings.embed([query], 'query');
    const vec = `[${queryVector!.join(',')}]`;
    const terms = searchTerms(query);

    return inScope(this.tenantDb, scope, async (tx) => {
      const kbFilter = sql`knowledge_base_id in (${sql.join(input.knowledgeBaseIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
      const categoryFilter = input.category ? sql`and metadata->>'category' = ${input.category}` : sql``;
      if (this.iterativeScan) await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`);

      const vectorHits = rowsOf<{ id: string; similarity: number }>(
        await tx.execute(sql`
          select id, 1 - (embedding <=> ${vec}::vector) as similarity
          from document_chunks
          where organization_id = ${scope.orgId}::uuid and ${kbFilter} and embedding is not null
            and embedding_model = ${this.embeddings.model} ${categoryFilter}
          order by embedding <=> ${vec}::vector
          limit ${CANDIDATES}`),
      );
      const textHits = terms.length ? await this.keywordHits(tx, scope.orgId, input.knowledgeBaseIds, terms, categoryFilter) : [];

      const threshold = this.embeddings.relevanceThreshold;
      const similarity = new Map(vectorHits.map((h) => [h.id, Number(h.similarity)]));
      const fused = new Map<string, number>();
      // Vector candidates far below the relevance bar are noise unless keyword search also found them.
      const textIds = new Set(textHits.map((h) => h.id));
      vectorHits.forEach((h, i) => {
        if (Number(h.similarity) >= threshold * 0.5 || textIds.has(h.id)) fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (RRF_K + i + 1));
      });
      textHits.forEach((h, i) => fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));
      const top = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
      if (!top.length) return { chunks: [], grounding: 'none', bestSimilarity: vectorHits[0] ? Number(vectorHits[0].similarity) : null };

      const rows = await tx
        .select({
          id: schema.documentChunks.id,
          documentId: schema.documentChunks.documentId,
          knowledgeBaseId: schema.documentChunks.knowledgeBaseId,
          title: schema.documentChunks.title,
          content: schema.documentChunks.content,
          metadata: schema.documentChunks.metadata,
          sourceUri: schema.documents.sourceUri,
        })
        .from(schema.documentChunks)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.documentChunks.documentId))
        .where(inArray(schema.documentChunks.id, top.map(([id]) => id)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const chunks: RetrievedChunk[] = top
        .map(([id, score]): RetrievedChunk | null => {
          const r = byId.get(id);
          if (!r) return null;
          return {
            id,
            documentId: r.documentId,
            knowledgeBaseId: r.knowledgeBaseId,
            title: r.title,
            content: r.content,
            url: r.metadata.url ?? r.sourceUri ?? null,
            category: r.metadata.category ?? null,
            similarity: similarity.get(id) ?? null,
            score,
          };
        })
        .filter((c): c is RetrievedChunk => c !== null);

      const best = Math.max(...chunks.map((c) => c.similarity ?? 0));
      const inBoth = chunks.some((c) => textIds.has(c.id) && (c.similarity ?? 0) >= threshold * 0.75);
      const grounding = best >= threshold || inBoth ? 'grounded' : 'weak';
      return { chunks, grounding, bestSimilarity: Number.isFinite(best) ? best : null };
    });
  }

  /** Full-text candidates. Each knowledge base is searched in its own language, so its stemming and stop words apply. */
  private async keywordHits(tx: Db, orgId: string, kbIds: string[], terms: string[], categoryFilter: SQL) {
    const kbs = await tx
      .select({ id: schema.knowledgeBases.id, language: schema.knowledgeBases.language })
      .from(schema.knowledgeBases)
      .where(and(eq(schema.knowledgeBases.organizationId, orgId), inArray(schema.knowledgeBases.id, kbIds)));
    const byLanguage = new Map<string, string[]>();
    for (const kb of kbs) {
      const config = this.searchConfig(kb.language);
      byLanguage.set(config, [...(byLanguage.get(config) ?? []), kb.id]);
    }
    if (!byLanguage.size) return [];
    const branches = [...byLanguage].map(
      ([config, ids]) => sql`(
        select id, ts_rank_cd(tsv, q) as rank
        from document_chunks, to_tsquery(${config}::regconfig, ${terms.join(' | ')}) q
        where organization_id = ${orgId}::uuid and knowledge_base_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
          and tsv @@ q ${categoryFilter}
        order by rank desc
        limit ${CANDIDATES})`,
    );
    return rowsOf<{ id: string; rank: number }>(
      await tx.execute(sql`select id, rank from (${sql.join(branches, sql` union all `)}) hits order by rank desc limit ${CANDIDATES}`),
    );
  }
}

/** When a newly set schedule is due: counted from the last fetch (overdue → the next sweep); a failed page keeps its quick retry. */
function scheduledRefreshAt(doc: DocumentRow, hours: number): Date {
  const due = doc.status === 'failed' ? Date.now() + Math.min(hours, 6) * HOUR_MS : (doc.lastIngestedAt ?? new Date()).getTime() + hours * HOUR_MS;
  return new Date(Math.max(Date.now(), due));
}

/** next_refresh_at after `hours` (a SQL expression over the row); stays null for documents that don't refresh. */
function nextRefreshSql(hours: 'refresh_interval_hours' | 'least(refresh_interval_hours, 6)'): SQL {
  return sql`case when refresh_interval_hours is null then null else now() + ${sql.raw(hours)} * interval '1 hour' end`;
}

function fingerprintOf(sections: Section[]): string {
  return sections.map((s) => `${s.url ?? ''}#${s.page ?? ''}\n${s.text}`).join('\n\n');
}
