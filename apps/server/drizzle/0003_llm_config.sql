-- Bots follow the server's LLM configuration (LLM_MODEL / LLM_REASONING_EFFORT) unless overridden.
ALTER TABLE "bots" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "effort" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "effort" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "provider" text;--> statement-breakpoint
-- Existing values were copies of the old code default, not deliberate overrides: clear them.
UPDATE "bots" SET "model" = NULL, "effort" = NULL;
