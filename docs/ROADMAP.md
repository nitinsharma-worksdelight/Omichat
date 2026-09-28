# Roadmap

Phase 1 delivers the AI core on the website widget (plus a public API channel and a dashboard playground).
Every later phase plugs into the same engine without touching the AI orchestration.

## Phase 1 — AI core (this build)

Features: **AI conversations · lead capture · lead qualification · knowledge base / RAG · appointment booking ·
AI actions**.

| Step | What gets built | Done when |
|---|---|---|
| 1.1 Foundation | npm-workspaces monorepo, env config, logger, Fastify app, `/health`, PGlite/pg DB client, inline/BullMQ queue, lock and pub/sub drivers, docker-compose for Postgres+Redis | server boots on PGlite with zero external services |
| 1.2 Schema + tenancy | Drizzle schema for all Phase 1 tables, migrations, `tenantTx` with RLS, seed script | isolation test: org A cannot read org B even with the app filter removed |
| 1.3 Auth | local (password + JWT) or Supabase JWT mode, memberships/roles, org API keys, widget session tokens | protected routes reject missing/foreign tokens |
| 1.4 CRM + lead capture | contacts, identities, custom field defs, tags, notes, tasks, validation (email, E.164 phone), dedupe/merge | returning visitor who gives a known email is merged into the existing contact |
| 1.5 Conversation engine + webchat channel | conversations, messages, status gate, ai-reply job with debounce + lock, widget session/message/SSE endpoints, API channel | a message in → persisted → job enqueued exactly once per burst |
| 1.6 AI orchestrator | bot config, prompt builder, configurable LLM providers (OpenAI, Anthropic, mock), tool loop, guards, streaming, cost tracking, rolling summary | mocked-LLM replay tests pass; live reply streams to the widget |
| 1.7 Knowledge / RAG | KBs, documents (text, FAQ, URL, PDF/DOCX/TXT upload), ingestion job, chunking, embeddings, hybrid search, citations | retrieval test finds the right chunk; no cross-tenant results |
| 1.8 Qualification | question config, answer validation, scoring rules, tiers, outcomes | scoring unit tests; `lead.qualified` event fires once |
| 1.9 Booking | calendars, weekly hours, overrides, availability engine, book/reschedule/cancel tools | concurrent double-booking test: exactly one succeeds |
| 1.10 AI actions + automation | tags, notes, tasks, notify team, trigger workflow, handoff, events outbox, signed webhooks with retries | webhook signature test; delivery retry test |
| 1.11 Dashboard | login, bots editor, playground, knowledge, leads, appointments/calendars, conversations, settings (custom fields, tags, webhooks, workflows, widget embed code, API keys) | full flow works in the browser |
| 1.12 Widget | embeddable script, Shadow DOM, streaming, history restore | embed snippet works on a plain HTML page |

## Phase 2 — Messaging channels
Meta app (WhatsApp Cloud API, Messenger, Instagram) with one webhook stack, `ChannelAdapter` implementations,
24-hour-window rules + templates, delivery statuses, media download, cross-channel identity resolution.
Start Meta Business Verification / App Review **now** — it takes weeks.

## Phase 3 — Human agents
Live inbox (Socket.IO), assignment, takeover/return-to-AI, internal notes, canned replies, typing indicators,
handoff triggers from sentiment/repeated failure.

## Phase 4 — Follow-ups and workflows
Follow-up rules (no reply in N hours → nudge, WhatsApp templates outside 24 h), native automation rules
(event → conditions → actions) alongside n8n.

## Phase 5 — External calendars and CRMs
Google Calendar and GHL calendar providers (OAuth, busy-time sync, event creation), two-way contact sync with the
LeadsMagnet app and external CRMs.

## Phase 6 — SMS, Email, voice notes
Twilio/Telnyx SMS adapter, inbound/outbound email adapter, speech-to-text for voice notes, image understanding.

## Phase 7 — Analytics and hardening
Dashboards (volume, AI resolution rate, leads, bookings, cost per conversation), evals per bot template,
reranker, load tests, prompt-injection suite, per-org queue fairness, data retention/export jobs.

## Phase 8 — LeadsMagnet integration
SSO token exchange, account mapping, contact/appointment sync, usage export for billing. Blocked on fixing the
existing app's `x-user-id` trust and browser-exposed secrets.
