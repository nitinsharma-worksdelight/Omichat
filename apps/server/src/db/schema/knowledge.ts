import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid, vector } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { EMBEDDING_DIMENSIONS, createdAt, pk, ts, tsvector, updatedAt } from './_helpers';
import { organizations } from './core';

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    /** Postgres text search configuration for keyword search ('english', 'spanish', …; 'simple' = any language, no stemming). */
    language: text().notNull().default('english'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('knowledge_bases_org_idx').on(t.organizationId)],
);

export type DocumentSourceType = 'text' | 'faq' | 'url' | 'file';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type DocumentCategory = 'general' | 'faq' | 'services' | 'pricing' | 'policies' | 'other';

export const documents = pgTable(
  'documents',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid().notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    sourceType: text().$type<DocumentSourceType>().notNull(),
    category: text().$type<DocumentCategory>().notNull().default('general'),
    /** URL for `url` documents. */
    sourceUri: text(),
    /** Source-specific options, e.g. `{ crawl: true, maxPages: 10 }` for URLs. */
    options: jsonb().$type<{ crawl?: boolean; maxPages?: number }>().notNull().default({}),
    /** Raw body for `text` documents. */
    content: text(),
    /** Question/answer pairs for `faq` documents. */
    faq: jsonb().$type<Array<{ question: string; answer: string }>>(),
    storagePath: text(),
    mimeType: text(),
    fileSize: integer(),
    contentHash: text(),
    status: text().$type<DocumentStatus>().notNull().default('pending'),
    error: text(),
    chunkCount: integer().notNull().default(0),
    tokenCount: integer().notNull().default(0),
    lastIngestedAt: ts(),
    /** `url` documents only: re-fetch every 24 or 168 hours; null = never. */
    refreshIntervalHours: integer(),
    nextRefreshAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('documents_kb_idx').on(t.knowledgeBaseId, t.createdAt),
    index('documents_org_idx').on(t.organizationId),
    index('documents_next_refresh_idx').on(t.nextRefreshAt).where(sql`refresh_interval_hours is not null`),
  ],
);

export interface ChunkMetadata {
  heading?: string;
  page?: number;
  url?: string;
  category?: DocumentCategory;
}

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: pk(),
    organizationId: uuid().notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    knowledgeBaseId: uuid().notNull().references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    documentId: uuid().notNull().references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer().notNull(),
    title: text().notNull(),
    content: text().notNull(),
    tokenCount: integer().notNull(),
    metadata: jsonb().$type<ChunkMetadata>().notNull().default({}),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text(),
    /** to_tsvector(<knowledge base language>, title + content); written at ingestion, rebuilt when the language changes. */
    tsv: tsvector(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('document_chunks_doc_idx_uq').on(t.documentId, t.chunkIndex),
    index('document_chunks_org_kb_idx').on(t.organizationId, t.knowledgeBaseId),
    index('document_chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('document_chunks_tsv_gin').using('gin', t.tsv),
  ],
);
