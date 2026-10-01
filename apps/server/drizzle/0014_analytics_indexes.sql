CREATE INDEX "contacts_org_lead_captured_idx" ON "contacts" USING btree ("organization_id","lead_captured_at") WHERE "contacts"."lead_captured_at" is not null;--> statement-breakpoint
CREATE INDEX "conversations_org_created_idx" ON "conversations" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "appointments_org_created_idx" ON "appointments" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "events_org_type_created_idx" ON "events" USING btree ("organization_id","type","created_at");--> statement-breakpoint
CREATE INDEX "deals_org_closed_idx" ON "deals" USING btree ("organization_id","closed_at") WHERE "deals"."closed_at" is not null;