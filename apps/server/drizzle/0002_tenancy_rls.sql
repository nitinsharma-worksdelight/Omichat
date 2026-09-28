-- No two booked appointments may overlap on the same calendar (enforced by Postgres, not by app code).
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_valid_range" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist ("calendar_id" WITH =, tstzrange("starts_at", "ends_at", '[)') WITH &&)
  WHERE ("status" = 'booked');
--> statement-breakpoint
-- Tenant isolation, second line of defence behind the application's own org filters.
-- The API runs every tenant query as: SET LOCAL ROLE app_tenant; set_config('app.org_id', <org>, true).
-- Migrations and system jobs run as the table owner, which RLS does not restrict.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT app_tenant TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organizations" USING ("id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_members" ON "users" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_id" = "users"."id" AND m."organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "api_keys" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_accounts" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bots" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "bot_knowledge_bases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bot_knowledge_bases" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contacts" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "contact_identities" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_identities" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "custom_field_defs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "custom_field_defs" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tags" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_tags" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "contact_notes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "contact_notes" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tasks" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_runs" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tool_invocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tool_invocations" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "knowledge_bases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_bases" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_chunks" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "calendars" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calendars" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointments" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "events" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_endpoints" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "webhook_deliveries" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflows" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
