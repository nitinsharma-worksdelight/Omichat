# AI Handover — Omnichannel AI (repo `chat-bot`)

Written 2026-10-15 for another AI coding assistant taking over. Companion files: [`CURRENT_STATUS.md`](CURRENT_STATUS.md) (where things stand, next steps) and [`AI_RULES.md`](AI_RULES.md) (how this user wants work done — **read it before changing anything**).

Legend: **[verified]** = checked in the repo or a command output during this handover or the sessions it summarises; **[unverified]** = taken from notes/history or not checkable from here. Nothing here is a secret; no `.env` values were read or copied.

## 1. What this project is

A standalone, multi-tenant AI chat-assistant platform, modelled on GoHighLevel's "Conversation AI" **[verified: README, docs/ARCHITECTURE.md]**. One shared conversation + AI engine sits behind every channel. Today only the **website chat widget** (plus a server-to-server chat API and a dashboard test chat) is live; SMS/WhatsApp/Instagram/Facebook/TikTok/Email are not built and are hidden in the UI **[verified]**.

Original requirements came from two Claude Chat artifacts (a Claude Doc "Building a Production AI Chatbot Like GHL's Conversation AI" and an "Omnichannel AI Blueprint") **[unverified: the artifacts are not readable from here; only their summary in docs/ARCHITECTURE.md is]**.

Capabilities built **[verified in code/PROGRESS.md]**: AI conversations (persona, memory, summaries), lead capture, lead qualification, knowledge base / RAG, appointment booking (with Advanced Options), AI actions (CRM updates, tags, notes, tasks, deals, notifications, n8n workflows, custom API calls), human handover (scenario-based), Stop Bot, approvals ("ask the team first"), analytics, a GHL-style "AI Agents" dashboard (builder, deploy, templates, logs).

## 2. Tech stack **[verified: package.json files, docs/ARCHITECTURE.md]**

| Area | Technology |
|---|---|
| Language / runtime | TypeScript 6, Node.js ≥ 22.12 (npm workspaces: `apps/*`) |
| API | Fastify 5.12 (`apps/server`), Zod 4.6 validation |
| Database | Postgres 16+/17 with pgvector; **PGlite** (embedded Postgres in WASM) for local dev and unit tests; Drizzle ORM 0.45; row-level security (role `app_tenant`) as a second tenant-isolation layer |
| Queues / locks / realtime | BullMQ + Redis in production; in-process drivers in dev. Per-conversation lock, SSE streaming via Redis pub/sub |
| LLM | Provider-neutral `LlmProvider` interface: OpenAI (Responses API) and Anthropic implemented, `mock` for tests/local. Chosen by env `LLM_PROVIDER` + `LLM_MODEL`. Which model production uses **[unverified]** (an old note says `gpt-4o-mini` as of 2026-09-27) |
| Embeddings | OpenAI `text-embedding-3-small` when `OPENAI_API_KEY` is set, otherwise a local keyword/hash embedder |
| Auth | JWT (`jose`), optional Supabase JWT mode; org API keys with scopes |
| Dashboard | React 19 + Vite 8 + Tailwind 4, TanStack Query, hash router (`#/…`), `lucide-react` (`apps/dashboard`) |
| Widget | Vanilla TS in Shadow DOM, esbuild, fetch-based SSE (`apps/widget`) |
| Tests | Vitest 4 (server tests also import pure dashboard helpers); an integration tier on real Postgres + Redis |
| Deploy | Backend: Render blueprint `render.yaml` (Docker, region singapore, free plans: API sleeps after 15 min; free DB expires after 30 days). Dashboard: Vercel. Exact current prod config/URLs **[unverified]** |
| Integrations | n8n via signed webhooks and named workflows; Supabase optional |

## 3. Repository map **[verified]**

```
apps/server/src
  main.ts / worker.ts        API process / worker process (same codebase; workers run in the API by default)
  container.ts               dependency wiring (all services created here)
  config/env.ts              every env var (names only listed in .env.example; values are secrets)
  db/schema/*.ts, drizzle/   Drizzle schema + migrations
  http/app.ts, http/routes/* routes, auth (requireUser(role)), public widget routes under /widget/v1
  modules/
    ai/            orchestrator.ts (a turn), prompt.ts, stop.ts (Stop Bot state), sweeper.ts, llm/{openai,anthropic,mock,registry,types}.ts
    bots/          config.ts (BotConfigSchema: all bot settings as JSON), service.ts (CRUD, reference checks)
    conversations/ service.ts (messages, setStatus, stopBot/restartBot, assign)
    handoff/       service.ts (HandoffWatcher: overdue alerts, scenario take-back)
    scheduling/    availability.ts, service.ts (book/reschedule/cancel), notifications.ts
    tools/         definitions.ts (every AI tool), executor.ts, types.ts
    approvals/ automation/ (events, webhooks, notifications, workflows) contacts/ leads/ deals/ knowledge/ analytics/ tenancy/ auth/ channels/
  scripts/       chat-cli.ts (real-model terminal chat), search-eval.ts
apps/server/test/            unit + integration (PGlite, scripted mock LLM); test/helpers.ts
apps/server/test-integration/ real Postgres + Redis tier (skipped without env URLs)
apps/dashboard/src
  App.tsx, components/ (ui.tsx, Layout.tsx, overlay.tsx), lib/ (api, queries, types, format, validate, settingErrors, agentNames)
  pages/agents/        AI Agents: AiAgentsPage, AgentsList, AgentsDashboard, GettingStarted, Templates, CreateAgentModal,
                       editor/ (AgentEditorPage = Build/Deploy, PromptPanel, SettingsPanels, ActionModals, HumanHandoverModal,
                       StopBotModal, DeployPanel, CustomApiModal)
  pages/bots/          full settings editor (BotEditorPage), sections.tsx, editorNav.ts, draft.ts, warnings.ts, Playground.tsx
  pages/{conversations,contacts,deals,appointments,automations,approvals,analytics,knowledge,settings,overview}
apps/widget/src          widget.ts, handoff.ts, links.ts, starters.ts, drag.ts
docs/                    API.md, ARCHITECTURE.md, DECISIONS.md, IMPLEMENTATION_PLAN.md, ROADMAP.md
scripts/verify-phase.mjs progress hook (see §6)
PROGRESS.md              source of truth for phase status (very large, ~2,900 lines); SESSION-CONTEXT.md short map of 2026-10-13…15
```

## 4. How the core flow works **[verified in code]**

1. Customer message → channel adapter → `ConversationsService.receiveInbound` → saved, `ai-reply` job queued (debounced).
2. `AiOrchestrator.reply` (modules/ai/orchestrator.ts): checks conversation status (`ai_active` / `human_active` / `closed`), the Stop Bot state, org/bot switches; guards without the model (handoff starter, Human Requested phrases, reply cap, monthly budget); builds context + system prompt; runs the tool loop; delivers with `addOutboundIf` (only while still `ai_active`).
3. Every side effect goes through `ToolExecutor`/`tools/definitions.ts` (Zod-validated, org/contact injected by the server, audited in `tool_invocations`, can be set to "ask the team first" → approvals).
4. Bot settings are one JSON document (`bots.config`), parsed with defaults on every read. A PATCH **replaces whole config sections** and keeps omitted sections.
5. Conversation state lives partly in `conversations.metadata` (jsonb): `aiStop` (Stop Bot), `reactivateAt` / `reactivateAfterMinutes` / `handoffScenario` (handover take-back). A change of status clears them.
6. Events outbox → signed webhooks (n8n) and staff notifications.

Features touched most recently (details in PROGRESS.md and SESSION-CONTEXT.md): Stop Bot, scenario-only Human Handover (existing bots are migrated on read), Booking Advanced Options (`booking.linkOnly/bookingLink/pauseAfterBooking/triggerWorkflows/workflowKeys/transferEmployee/transferUserId`), model-override validation against the provider, "Untitled N" default agent names.

## 5. Setup, run, test commands **[verified from package.json/README]**

```bash
npm install
npm run db:seed          # demo clinic + login + widget key (check the output; do not copy credentials into docs)
npm run dev              # API :4000 on embedded Postgres, in-process queues
npm run dev:dashboard    # dashboard :5173
npm run dev:widget       # widget demo :5180
npm run typecheck        # all three apps
npm run build            # all three apps
cd apps/server && npx vitest run [files]     # unit tests (PGlite + mock LLM). No lint script exists.
npm run verify:phase -- <n> [--complete]     # typecheck + full tests, then records the result in PROGRESS.md
```

- **Integration tier** (real Postgres + Redis; there is no Docker on the user's Mac): start Postgres 17 + pgvector and Redis ad hoc, e.g. `initdb -D <dir>/pg -U omni --auth=trust` (set `LC_ALL=en_US.UTF-8`; binaries in `/opt/homebrew/opt/postgresql@17/bin`), `pg_ctl -D <dir>/pg -o "-p 55432 -k '' -c listen_addresses=localhost" start`, `redis-server --port 56379 --daemonize yes --save "" --appendonly no`, then `INTEGRATION_DATABASE_URL=postgres://omni@localhost:55432/postgres INTEGRATION_REDIS_URL=redis://localhost:56379/15 npx vitest run -c vitest.integration.config.ts` in `apps/server`. Stop both afterwards. Last run: 19/19.
- **Browser verification of UI work**: add temporary entries to `.claude/launch.json` (gitignored): an API on port 4100 (`DATABASE_URL=pglite://.data/verify-agents`, `LLM_PROVIDER=mock`, `LLM_MODEL=mock`, `DASHBOARD_ORIGINS=http://localhost:5273`, command `npx -w @omni/server tsx src/main.ts`) and a dashboard on 5273 (`VITE_API_URL=http://localhost:4100`, `npx -w @omni/dashboard vite --port 5273 --strictPort`). Restore the file afterwards. A local test account lives in `.data/verify-agents` (credentials are kept outside the repo; do not write them down).
- Env var **names** are in `apps/server/.env.example`; production needs real `JWT_SECRET`, `ENCRYPTION_KEY`, LLM provider/model/key, Redis (the server refuses to start otherwise).

## 6. Documentation map and caveats

- `PROGRESS.md` = single source of truth for phases and decisions. **Caveat:** its "Current phase" header still says H3 (2026-10-02) and does not describe the work after that (GHL-style agents, Stop Bot, handover, booking, QA passes). Use `CURRENT_STATUS.md` + `SESSION-CONTEXT.md` for the latest state.
- `README.md` says 71 tests (outdated; PROGRESS.md notes 238 at one point; the server suite was 588 at the last full run).
- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md` are user-owned: **do not edit** (see AI_RULES.md).
- There is **no `CLAUDE.md` / `AGENTS.md`** in the repo (an earlier session prompt mentioned one; it does not exist **[verified]**). Project rules for the AI live in `AI_RULES.md` (written from the user's saved notes and conversation history).
- The `PROGRESS.md` phase table is updated by `scripts/verify-phase.mjs`; edit text outside its marker blocks by hand.

## 7. Session history (Claude Code, project `-Users-deepaksharma-Workspace-chat-bot`)

Dates are the first/last timestamps of each session file; topics come from each session's first requests and PROGRESS.md **[summaries not re-verified line by line]**.

| Session id (prefix) | Dates | What it was |
|---|---|---|
| `1a703908` | 2026-09-25 → 09-29 | Initial build: requirements → architecture, stack, Phase 1 (AI conversations, lead capture, qualification, RAG, booking, AI actions) |
| `98225cef` | 2026-09-25 → 10-01 | Strict EXPLORE → AUDIT → RECOMMEND → PLAN → approval → IMPLEMENT workflow; Phases 1–9 and features F1–F6 |
| `c5b592b3` | 2026-09-30 → 10-01 | Context recovery in a fresh chat; F6 Human Handoff explore/audit/plan |
| `b675a87b` | 2026-10-01 → 10-06 | UI/UX redesign track (design direction from two reference dashboards, U1–U8) |
| `1926f3b7` | 2026-10-01 → 10-02 | Production-readiness audit; split into code-level vs server/deployment issues; H1–H10 hardening plan |
| `305b621e` | 2026-10-02 → 10-15 | QA bug report fixes (Q1–Q7), then the GHL-style AI Agents redesign and everything in CURRENT_STATUS.md §2 |

User memory notes (a separate Claude Code feature, outside the repo) exist at `~/.claude/projects/-Users-deepaksharma-Workspace-chat-bot/memory/`; their content is folded into `AI_RULES.md`. **[unverified whether another assistant can read them]**

## 8. Things I could not verify

- What is deployed right now on Render/Vercel, the production env values, which LLM model production uses, and whether the live backend has the latest commits.
- The two original requirement artifacts.
- A fresh full-suite run after the last commit (`b6afb27`): the full suite was last run at 588/588 before the bug-sheet work; since then only related files (92/92) and the integration tier (19/19, before the bug-sheet work) were run.
- Real-model behaviour: no paid LLM calls were made in the recent sessions; everything used the mock model.
