# Omnichannel AI — Phase 1

A standalone, multi-tenant AI chat assistant platform (GoHighLevel "Conversation AI"-style). One shared
conversation + AI engine sits behind every channel. Phase 1 ships the engine on the website widget, a
server-to-server chat API and a dashboard playground.

**Phase 1 features:** AI conversations (persona, custom instructions, memory, follow-up questions) · lead
capture · lead qualification · knowledge base / RAG · appointment booking · AI actions (CRM updates, tags,
notes, tasks, notifications, n8n workflows, human handoff).

- Architecture and technology map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Phases and what comes next: [`docs/ROADMAP.md`](docs/ROADMAP.md)
- Decisions taken and open questions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- HTTP API: [`docs/API.md`](docs/API.md)

## Quick start (no Docker, no accounts needed)

Requires Node 22+.

```bash
npm install
npm run db:seed        # creates the demo clinic "Bright Smile Dental" and prints the login + widget key
npm run dev            # API on http://localhost:4000 (embedded Postgres, in-process queues)
npm run dev:dashboard  # dashboard on http://localhost:5173  → log in with demo@example.com / demo-password-123
npm run dev:widget     # widget demo on http://localhost:5180/demo.html?key=<widget key>
```

Without an LLM configured the assistant answers with a placeholder so you can click through every flow.
To use a real model, copy `apps/server/.env.example` to `apps/server/.env` and set the provider, model and key.
Provider and model are configuration only; switching is an `.env` change plus a restart:

```
LLM_PROVIDER=openai          # or: anthropic
LLM_MODEL=<model id>         # e.g. the model your team chose; no model is named in code
LLM_PRICE_INPUT_PER_MTOK=…   # optional prices → cost tracking and monthly budgets
LLM_PRICE_OUTPUT_PER_MTOK=…
OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY for the anthropic provider
```

`OPENAI_API_KEY` also switches knowledge-base embeddings from the local keyword embedder to OpenAI; existing
documents are re-embedded automatically.

Try the real bot from the terminal (throwaway in-memory database, prints every tool call and the lead's state):

```bash
npm run chat -w @omni/server
```

Embed the widget on any site:

```html
<script src="http://localhost:4000/widget.js" data-key="pk_…" async></script>
```

## Tests

```bash
npm test               # 71 tests: unit + integration on real Postgres (PGlite) with a scripted LLM
npm run typecheck
```

Covered: tenant isolation through Postgres RLS, availability (timezones, DST, buffers, notice), concurrent
double-booking, qualification scoring, lead capture validation and duplicate merging, hybrid retrieval and
cross-tenant safety, the full capture → qualify → book tool loop, invalid-tool-argument handling, cross-customer
protection, handoff (keyword, tool, refusal), human takeover mid-generation, burst debouncing, widget sessions
+ SSE streaming, allowed origins, API-key scopes, signed webhooks with retries, and n8n workflow calls.

## How it fits together

```
widget / API / playground ─▶ Conversation Engine ─▶ ai-reply queue ─▶ AI Orchestrator ─▶ LLM provider (tools)
                                 (Postgres)            (BullMQ)          │  context, RAG, guards
                                                                         ▼
                                           Tool/Action Service: CRM · qualification · booking · KB search ·
                                           tags · notes · tasks · notify · n8n workflows · handoff
                                                                         ▼
                                           events outbox ─▶ signed webhooks (n8n) + staff notifications
```

| Piece | Where |
|---|---|
| Node.js / TypeScript backend (Fastify) | `apps/server` — API process `src/main.ts`, worker process `src/worker.ts` |
| Postgres + pgvector (Supabase in production) | system of record + vector search; schema in `apps/server/src/db/schema`, migrations in `apps/server/drizzle` |
| Redis | BullMQ queues, per-conversation locks, streaming pub/sub, rate limits |
| LLM (configurable: OpenAI active, Anthropic supported) | `apps/server/src/modules/ai` — orchestrator, prompt builder; providers in `ai/llm/` chosen by `LLM_PROVIDER` |
| n8n | receives signed events; called by the bot via `trigger_workflow` — never on the live message path |
| Dashboard | `apps/dashboard` (React + Vite + Tailwind) |
| Widget | `apps/widget` (vanilla TS, Shadow DOM) |

## Production

```bash
cp apps/server/.env.example apps/server/.env   # set JWT_SECRET, ENCRYPTION_KEY, LLM_PROVIDER, LLM_MODEL, the provider key, …
docker compose up --build                       # Postgres+pgvector, Redis, API, worker
```

For Supabase: point `DATABASE_URL` at the pooler (transaction mode); migrations enable `vector` and
`btree_gist` and create the `app_tenant` role used for RLS. Run `npm run db:migrate` once per deploy
(or leave `AUTO_MIGRATE=true` on a single API instance). Scale API and worker containers independently.
The server refuses to start in production without real secrets, Redis and a configured LLM provider, model and key.

## Connecting n8n

1. Dashboard → Automations → Webhooks → add your n8n Webhook URL and choose events (e.g. `lead.qualified`,
   `appointment.booked`). Copy the signing secret.
2. In n8n, verify `x-omni-signature` (`t=<unix>,v1=<hex>` = HMAC-SHA256 of `"<t>.<raw body>"` with the secret)
   and branch on `type`. Every payload carries a contact snapshot.
3. For actions the bot should take (e.g. an order-status lookup), add a Workflow (key, description, URL,
   inputs) and enable its key on the bot. The bot calls it with `trigger_workflow`; request/response workflows
   return their JSON to the bot.
4. n8n can also call the API with an org API key (`POST /v1/channels/api/messages`, `/v1/contacts`, …).
