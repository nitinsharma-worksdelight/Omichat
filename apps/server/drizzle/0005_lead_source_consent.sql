CREATE TABLE "contact_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"text" text,
	"text_version" text,
	"source" text NOT NULL,
	"conversation_id" uuid,
	"request_message_id" uuid,
	"evidence_message_id" uuid,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_touch" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "consent" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_consents" ADD CONSTRAINT "contact_consents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_consents_contact_idx" ON "contact_consents" USING btree ("contact_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_consents_org_created_idx" ON "contact_consents" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_first_touch_gin" ON "contacts" USING gin ("first_touch" jsonb_path_ops);--> statement-breakpoint
-- Tenant isolation, the same policy every tenant table got in 0002_tenancy_rls.sql (drizzle-kit doesn't generate it).
ALTER TABLE "contact_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_consents" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_consents" TO app_tenant;
