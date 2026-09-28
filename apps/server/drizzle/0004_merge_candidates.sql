CREATE TABLE "contact_merge_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"existing_contact_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"conversation_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_merge_candidates" ADD CONSTRAINT "contact_merge_candidates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merge_candidates" ADD CONSTRAINT "contact_merge_candidates_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merge_candidates" ADD CONSTRAINT "contact_merge_candidates_existing_contact_id_contacts_id_fk" FOREIGN KEY ("existing_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merge_candidates" ADD CONSTRAINT "contact_merge_candidates_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_merge_candidates_org_status_idx" ON "contact_merge_candidates" USING btree ("organization_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_merge_candidates_contact_idx" ON "contact_merge_candidates" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_merge_candidates_existing_idx" ON "contact_merge_candidates" USING btree ("existing_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_merge_candidates_pending_uq" ON "contact_merge_candidates" USING btree ("contact_id","field","value") WHERE "contact_merge_candidates"."status" = 'pending';--> statement-breakpoint
-- Tenant isolation, the same policy every tenant table got in 0002_tenancy_rls.sql (drizzle-kit doesn't generate it).
ALTER TABLE "contact_merge_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_merge_candidates" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_merge_candidates" TO app_tenant;