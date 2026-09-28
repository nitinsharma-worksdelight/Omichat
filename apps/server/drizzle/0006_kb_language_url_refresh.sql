-- Keyword search in each knowledge base's language: tsv stops being generated as English and is written at ingestion
-- (and rebuilt when a knowledge base's language changes). DROP EXPRESSION keeps the existing English values and the
-- GIN index, which match the 'english' default below, so nothing needs rebuilding.
ALTER TABLE "document_chunks" ALTER COLUMN "tsv" DROP EXPRESSION;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "refresh_interval_hours" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "next_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "language" text DEFAULT 'english' NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_next_refresh_idx" ON "documents" USING btree ("next_refresh_at") WHERE refresh_interval_hours is not null;