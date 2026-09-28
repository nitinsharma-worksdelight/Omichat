# Omnichannel AI Chatbot — Architecture

Sources: the Claude Doc *"Building a Production AI Chatbot Like GHL's Conversation AI"* (requirements) and the
*"Omnichannel AI Blueprint"* diagram. This is a **standalone application** with its own database; the existing
LeadsMagnet apps (`agent-talk-dash`, `create-ai-agent`) integrate later through versioned APIs and signed
webhooks only.

## 1. The shape of the system

The Blueprint's rule: **one shared Conversation + AI Engine behind every channel.** Channels differ only in a thin
adapter at the edge. Everything below the adapter only ever sees a `NormalizedInboundMessage`.

```
 Website widget ─┐                                   (Phase 2+: WhatsApp · Messenger · Instagram · SMS · Email)
 Public API ─────┤  Channel adapters: verify → normalize → resolve org / contact
 Playground ─────┘
        │
        ▼
 Conversation Engine ── find-or-create conversation, persist message, status gate (ai_active / human_active)
        │   enqueue  ai-reply  (one job per conversation, burst-debounced, Redis lock per conversation)
        ▼
 AI Orchestrator ─────  guards (kill switch, budget, "talk to a human", limits)
        │               context: bot persona + business facts + contact profile + summary + last N messages
        │               RAG: hybrid search (pgvector + Postgres full-text, RRF) → grounded snippets with sources
        │               LLM provider (configured) with tools → tool loop (≤ 5 rounds) → Tool/Action Service
        ▼
 Tool/Action Service ─  the ONLY place side effects happen; validates every argument (zod), injects org/contact
        │               from the server, writes an audit row (tool_invocations)
        ├── CRM: contacts, custom fields, tags, notes, tasks, lead capture, lead qualification & scoring
        ├── Scheduling: calendars, availability, book / reschedule / cancel (DB-level double-booking guard)
        ├── Knowledge: search_knowledge_base
        └── Automation: domain events → outbox → signed webhooks (n8n) · named workflows · staff notifications
        ▼
 Response → persisted → streamed to the widget over SSE (via Redis pub/sub) / sent by the channel adapter
```

## 2. Where each technology is used

| Technology | Used for | Not used for |
|---|---|---|
| **Node.js 22+ / TypeScript** | The whole backend: API process (`main.ts`) + worker process (`worker.ts`), same codebase | — |
| **Fastify 5** | HTTP API, widget endpoints, SSE streaming, webhooks (raw body for signatures) | — |
| **Postgres 16+ (Supabase)** | System of record for everything: tenants, CRM, conversations, messages, bots, KB, appointments, events, audit, usage. RLS as a second tenant-isolation layer | Queues, caches |
| **pgvector** (inside Postgres) | Vector DB for knowledge chunks (HNSW index, cosine). Same DB as the relational data → one transaction for re-ingest, tenant filter before similarity | — (a dedicated vector DB only at millions of chunks) |
| **Postgres full-text** | Keyword half of hybrid retrieval (SKUs, names, exact phrases) | — |
| **Drizzle ORM** | Typed schema + queries + migrations | — |
| **Redis** | BullMQ queues, per-conversation locks, pub/sub for streaming tokens from worker → API → browser, rate limits | Durable data |
| **BullMQ** | `ai-reply`, `ingest`, `summary`, `webhook-delivery`, `notification`, `workflow` jobs with retries/backoff | — |
| **LLM provider** (configured: `LLM_PROVIDER` + `LLM_MODEL`) | Agent replies with tool use and conversation summaries. OpenAI (Responses API) is active; Anthropic is supported through the same `LlmProvider` interface. Provider and model are configuration only; a bot may optionally override the model/effort | Embeddings |
| **Embeddings API** (OpenAI `text-embedding-3-small`, 1536-d) | Chunk + query embeddings. Behind an `EmbeddingProvider` interface; the model name is stored per chunk | — |
| **Supabase** | Managed Postgres + pgvector, Storage (uploaded KB files), optional Auth (JWT verified by the API) | Edge functions for core logic |
| **n8n** | Downstream, per-business automations: receives signed event webhooks (`lead.qualified`, `appointment.booked`…) and runs client-specific flows (Slack, Sheets, HubSpot/GHL sync). Also callable by the bot through the `trigger_workflow` tool for client-specific lookups | **Anything on the live message path**: conversation state, AI orchestration, RAG, booking, CRM writes |
| **Cloudflare** (later) | CDN for `widget.js`, WAF/rate limits in front of webhooks, Turnstile on widget sessions | Core logic |
| **React + Vite + Tailwind** | Admin dashboard (bots, knowledge, leads, appointments, conversations, settings, playground) | — |
| **Vanilla TS widget** | Embeddable `<script>` chat bubble in Shadow DOM; fetch-based SSE streaming | — |

**Local development needs no Docker:** the server can run on **PGlite** (Postgres compiled to WASM, with pgvector)
and in-process queue/lock/pub-sub drivers. Production uses real Postgres + Redis by changing two env vars.

## 3. Repository layout

```
apps/server/            Fastify API + worker (one codebase, two entry points)
  src/main.ts           API process
  src/worker.ts         queue workers
  src/app.ts            HTTP app (routes, auth hooks, error handling)
  src/container.ts      composition root: builds every module with its dependencies
  src/config/           env parsing (zod)
  src/db/               Drizzle schema, client (pg | PGlite), tenant transactions (RLS), migrations, seed
  src/infra/            queue (bullmq | inline), lock, pubsub, storage, crypto, logger
  src/modules/
    auth/               local password auth or Supabase JWT, API keys, widget session tokens
    tenancy/            organizations, memberships, org settings, kill switch
    bots/               bot (AI agent) configuration: persona, instructions, capture, qualification, booking, tools
    contacts/           CRM: contacts, identities, custom fields, tags, notes, tasks, merge/dedupe
    leads/              lead capture validation + qualification scoring engine
    conversations/      conversations, messages, the Conversation Engine
    channels/           ChannelAdapter interface; webchat + api adapters; widget routes
    ai/                 LlmProvider interface + providers (openai, anthropic, mock) chosen by a registry from config;
                        prompt builder, context, orchestrator, summaries, config-driven pricing
    knowledge/          knowledge bases, documents, extraction, chunking, embeddings, hybrid retrieval
    tools/              tool registry + executor + audit; every AI action lives here
    scheduling/         calendars, availability engine, appointments, CalendarProvider (internal; Google/GHL later)
    automation/         domain events/outbox, webhook endpoints (n8n) + deliveries, workflows, notifications
apps/dashboard/         React admin app
apps/widget/            embeddable chat widget (vanilla TS, Shadow DOM, ~5 KB gzipped)
docs/                   this file, API.md, ROADMAP.md, DECISIONS.md
```

Modules talk to each other only through their exported service objects, wired in `container.ts`. Adding
WhatsApp later = a new adapter in `channels/` + a webhook route; nothing in `ai/` changes.

## 4. Multi-tenancy

- `organization_id` on **every** tenant table, indexed first in composite indexes.
- The tenant is **never** taken from the client body: it comes from the verified JWT/API key (dashboard), the
  widget session token (visitor), or the channel account a verified webhook resolves to.
- Every tenant query runs inside `tenantTx(orgId, fn)`: a short transaction that does
  `SET LOCAL ROLE app_tenant` + `set_config('app.org_id', …, true)`. **RLS policies** on every tenant table
  then enforce isolation even if application code forgets a `WHERE organization_id = …`.
- Tool arguments from the LLM never contain org/contact/conversation ids; the executor injects them.
- Per-org kill switch (`organizations.ai_enabled`), monthly AI budget, and per-visitor rate limits.

## 5. Data model (Phase 1)

```
organizations ─< memberships >─ users          api_keys, custom_field_defs, tags, pipeline (lifecycle) stages
organizations ─< channel_accounts (webchat widget keys, api)
organizations ─< bots ─< bot_knowledge_bases >─ knowledge_bases ─< documents ─< document_chunks (vector + tsv)
organizations ─< contacts ─< contact_identities (channel, external id)
                contacts ─< contact_tags, contact_notes, tasks, appointments
contacts ─< conversations ─< messages
conversations ─< ai_runs ─< tool_invocations           conversation_events (timeline)
calendars ─< appointments  (EXCLUDE constraint: no overlapping booked slots per calendar)
events (outbox) ─> webhook_endpoints ─< webhook_deliveries          workflows (named n8n webhooks)
notifications
```

Hot indexes: `messages(conversation_id, created_at)`, `conversations(organization_id, status, last_message_at)`,
HNSW on `document_chunks.embedding`, GIN on `document_chunks.tsv`, unique `contact_identities(org, channel, external_id)`,
unique partial indexes on `contacts(org, lower(email))` / `contacts(org, phone)`.

## 6. AI engine details

**Prompt layout (cache-friendly):** `tools` (fixed per bot version) → `system` = platform rules + bot persona +
instructions + business facts (cache breakpoint here) → `messages` = conversation summary + last ~20 turns →
the final user turn carries `<context>` (contact profile, captured fields, qualification progress, upcoming
appointments, local time, retrieved knowledge with source ids) **marked as data, not instructions**.

**Memory:** short-term = recent messages; rolling summary written back to `conversations.summary` by a
background job; long-term = the contact record (fields, tags, qualification answers, notes).

**Tool loop:** manual loop (not the SDK tool runner) because between rounds we re-check the conversation lock
(human takeover), validate every input with zod, write `tool_invocations`, and enforce a 5-round cap. Parallel
tool calls are executed together and returned in one message. `stop_reason: "refusal"` → graceful handoff.

**Lead qualification is deterministic:** the LLM *extracts* answers to the bot's questions
(`record_qualification_answers`); a rules engine *scores* them (points per answer, thresholds for hot/warm/cold,
disqualifiers) and applies outcomes (tags, lifecycle stage, events, notifications). Auditable and testable.

**Booking safety:** availability is computed server-side in the calendar's timezone; booking requires the
customer's explicit confirmation and the bot's required contact fields; an idempotency key and a Postgres
exclusion constraint make double booking impossible under concurrency.

**Handoff:** `transfer_to_human` tool + "talk to a human" keyword guard + refusal fallback → conversation set
to `human_active`, AI stops replying, staff notified. Staff reply/resume endpoints exist; the full live inbox
UI is a later phase.

## 7. Events and n8n

Every business action writes a row to `events` in the same transaction (outbox). A dispatcher fans each event
out to matching `webhook_endpoints`; deliveries are signed (`X-Signature: t=…,v1=HMAC-SHA256`) and retried with
exponential backoff. n8n subscribes to the events it cares about. `trigger_workflow` lets a bot call a
business's named n8n workflow (fire-and-forget or request/response with a 10 s timeout).

Event types (Phase 1): `contact.created`, `contact.updated`, `lead.captured`, `lead.qualified`,
`lead.disqualified`, `contact.tagged`, `appointment.booked`, `appointment.rescheduled`,
`appointment.cancelled`, `task.created`, `conversation.handoff_requested`, `workflow.triggered`.
