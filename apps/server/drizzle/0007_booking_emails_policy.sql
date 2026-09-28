CREATE TABLE "appointment_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"error" text,
	"send_at" timestamp with time zone NOT NULL,
	"for_starts_at" timestamp with time zone NOT NULL,
	"reminder_minutes" integer,
	"recipient" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "notify_customer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "location" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "customer_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "send_confirmations" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "reminder_minutes" jsonb DEFAULT '[1440]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "reply_to_email" text;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "min_cancel_notice_minutes" integer;--> statement-breakpoint
ALTER TABLE "appointment_notifications" ADD CONSTRAINT "appointment_notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_notifications" ADD CONSTRAINT "appointment_notifications_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_notifications_due_idx" ON "appointment_notifications" USING btree ("send_at") WHERE status in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "appointment_notifications_appointment_idx" ON "appointment_notifications" USING btree ("appointment_id","created_at");--> statement-breakpoint
-- Tenant isolation, the same policy every tenant table got in 0002_tenancy_rls.sql (drizzle-kit doesn't generate it).
ALTER TABLE "appointment_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "appointment_notifications" USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "appointment_notifications" TO app_tenant;
