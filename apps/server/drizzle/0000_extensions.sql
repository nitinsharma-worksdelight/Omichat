-- pgvector for knowledge-base embeddings; btree_gist for the appointment no-overlap constraint.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
