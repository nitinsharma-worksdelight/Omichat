# Decisions and open questions

## Decisions taken for Phase 1 (change any of them — they are isolated behind interfaces)

| # | Decision | Why | Where to change |
|---|---|---|---|
| D1 | **Fastify + plain TypeScript modules** instead of NestJS | Same module boundaries (one folder + one service per module, wired in `container.ts`) without decorator metadata. The toolchain is moving (NestJS 12, TypeScript 7), and legacy decorators are the riskiest part of it. Fastify also feels like Express to the team | `apps/server/src/container.ts` |
| D2 | **Postgres + pgvector** (Supabase in prod) as both system of record and vector DB | One DB, transactional re-ingest, tenant filter before similarity search | `EmbeddingProvider`, `knowledge/retrieval.ts` |
| D3 | **Drizzle ORM**; PGlite for local dev/tests | Typed SQL, pgvector support, zero-dependency dev | `db/client.ts` |
| D4 | **LLM provider and model are configuration only** (`LLM_PROVIDER`, `LLM_MODEL`, optional `LLM_REASONING_EFFORT`, `LLM_UTILITY_MODEL`). OpenAI (`gpt-4o-mini`, Responses API, `store: false`) is active; Anthropic stays supported. Bots follow the configured model unless an admin sets a per-bot override (empty by default) | Switching provider/model must not need code changes; no model name appears in code | `apps/server/.env`, `ai/llm/registry.ts` |
| D5 | Embeddings: OpenAI `text-embedding-3-small` (1536-d); a local hashing embedder for dev/tests | Cheap and good; the local one needs no key | `EMBEDDINGS_PROVIDER` |
| D6 | Hybrid retrieval (vector + full-text, Reciprocal Rank Fusion), top 5, grounding threshold | Handles both paraphrases and exact terms; no-grounding → "I don't know" + offer human | `knowledge/retrieval.ts` |
| D7 | **Deterministic qualification scoring**; the LLM only extracts answers | Auditable, testable, no "vibes" scoring | `leads/qualification.ts` |
| D8 | Built-in calendar first (weekly hours, overrides, buffers, notice); Google/GHL providers later behind `CalendarProvider` | Booking works without OAuth setup; double-booking prevented by a DB constraint | `scheduling/` |
| D9 | One conversation per contact per channel account; the contact timeline spans channels | Simpler state, still a unified contact view | `conversations/engine.ts` |
| D10 | n8n only downstream (signed event webhooks + `trigger_workflow`) | Keeps latency, locking, tenancy and secrets in our code | `automation/` |
| D11 | Auth: `AUTH_MODE=local` (email + password, JWT) for dev/standalone; `AUTH_MODE=supabase` verifies Supabase JWTs | Works without a Supabase project; production can use Supabase Auth | `auth/` |
| D12 | Custom fields stored as `contacts.custom_fields` JSONB, validated against `custom_field_defs` | Simpler and faster than EAV tables; GIN-indexable | `contacts/` |
| D13 | npm workspaces (pnpm isn't installed on this machine) | Zero extra tooling | root `package.json` |
| D14 | Tool calls in one model turn run **sequentially, in the model's order** (not in parallel) | Business actions depend on each other within a turn: details must be saved before a booking, and a duplicate-merge can change the contact id mid-turn | `ai/orchestrator.ts` |
| D15 | Queue/lock/pub-sub have in-process implementations used when `REDIS_URL` is empty | One-command local dev and fast tests; production refuses to start without Redis | `infra/*`, `container.ts` |
| D16 | Provider endpoints are pinned (`LLM_BASE_URL` optional, default = the provider's official API); ambient `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` are ignored | Behaviour must not depend on whatever shell started the server | `ai/llm/registry.ts` |
| D17 | Model prices come only from configuration (`LLM_PRICE_*`, `LLM_UTILITY_PRICE_*`, `LLM_MODEL_PRICES`); an unpriced model is costed at $0 with a warning. Provider auth/billing failures hand the chat to a human and alert staff (at most hourly) | No prices or model names in code; operators learn quickly when the AI account needs attention | `ai/pricing.ts` |

## Known limitations of Phase 1

- **PGlite (local dev database) is single-process.** The server takes a lock file on its data directory and refuses to start if another live process holds it. Use one API process per `pglite://` directory, or Postgres.
- **Only the widget, the public API and the playground are channels.** WhatsApp/Messenger/Instagram adapters are Phase 2 (the `ChannelAdapter` interface and the normalized inbound path are in place).
- **Built-in calendar only.** Google/GHL sync plugs into `CalendarProvider` (Phase 5). Appointment confirmations to the customer (email/SMS) are not sent yet; staff are notified.
- **Follow-ups** (nudging silent leads) are Phase 4.
- **The live staff inbox** is basic (list, thread, take over, reply, resume); assignment rules and canned replies are Phase 3.
- **Local embeddings** (no `OPENAI_API_KEY`) are keyword-based; use real embeddings for semantic search quality.
- The URL crawler fetches static HTML only (no JavaScript rendering).

## Open questions (need your answers before Phase 2)

1. **Who signs up?** Only existing LeadsMagnet accounts (SSO), or open self-serve sign-up too?
2. **Agencies / white-label** — do agencies manage sub-accounts in this app at launch?
3. **WhatsApp numbers** — will businesses connect their own WABA (Embedded Signup → you need Tech Provider
   status) or will you operate numbers for them?
4. **Calendars at launch** — built-in only, Google, GHL, Outlook? Is GHL still the main CRM for your clients?
5. **Languages** — English only, or Hindi/Hinglish/French (Canada) too?
6. **Pricing model** — per conversation, per message, per seat? Who pays Meta's per-message fees?
7. **Compliance** — data retention period, GDPR/PIPEDA deletion requests, PII redaction in logs.
8. **Should voice agents and chat bots share one "AI employee"** (same persona + knowledge base)? This decides
   whether bots/KBs must later sync with the voice-agent side.
9. **Follow-up policy** — max nudges, timing, opt-out wording.
10. **Expected volume** — businesses, conversations/day — to size Postgres, Redis and LLM rate limits.
11. **Model choice** — `gpt-4o-mini` is configured now (cheapest). Re-evaluate with the live scenario (e.g. against `gpt-6-sol` / `gpt-6-luna`) before launch; it's a config change.
12. **Human agents at MVP** — just "notify + reply from dashboard", or a full live inbox with assignment rules?
