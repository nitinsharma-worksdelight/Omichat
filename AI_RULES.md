# AI rules for this project (from the user)

For any AI coding assistant working in this repo. These come from the user's saved notes and their conversations over 2026-09-25 → 2026-10-15. Where something is my reading rather than the user's own words, it is marked **[inferred]**. Where I can't tell if a rule still applies, it is marked **[unverified]**. When unsure, ask the user.

## 1. Communication

- The user writes in **Hinglish** (Hindi in Latin letters + English). Reply in the same style, **short by default**: lead with the answer in 2–5 short lines; no long sections or tables unless they ask for detail. They said: "Please everything in short always jab tk me na khu in detail".
- They sometimes ask for English explicitly (e.g. a daily status report "in English"); when they do, use English.
- When they say "just tell me", "in short", or "don't change any code", answer only; do not edit files.
- Final reports after QA/bug work: concise summary per bug with root cause, fix and test result (they asked for this form); say plainly what was not verified.
- Never claim something is fixed, tested or live without having checked it. Distinguish "confirmed bug" from "environment / not a code bug".

## 2. Workflow

- Standing rule from 2026-09-26 for roadmap work: **EXPLORE → AUDIT → RECOMMEND → PLAN → ask for approval → IMPLEMENT only that approved phase → test and verify → review → stop**. Never roll into the next phase on your own. The user chooses the order (UI redesign track, QA fix track Q1–Q7, hardening H1–H10, features F1–F9).
- Plan-only requests: when the user says "inspect and plan first", "analyse", "discuss", or "don't change code", deliver the plan/analysis and **wait for approval** before touching files.
- In the latest sessions (Oct 2026) the user also gave direct instructions such as "implement it", "fix every confirmed bug", "hide this", "commit karke push kar do", and the work was implemented without a separate approval round. **[inferred]** Treat a clear, specific instruction as approval for exactly that scope. For anything bigger, new, or ambiguous (new feature, new phase, schema change, removing behaviour) ask first. Do not widen scope.
- "Do not change unrelated features." Smallest safe change; no unrelated refactors; reuse existing components and architecture; avoid new DB migrations unless required.
- If a fix needs a product decision, missing credentials, a destructive migration or a breaking change: ask for that specific change and carry on with the rest.
- UI timing/flicker bugs: **no `setTimeout`/delay hacks**. Find the root cause and make the correct state the first one rendered; prove it with per-frame checks, not a screenshot.
- UI work should follow the user's reference screenshots as exactly as possible (they send GHL screenshots). Ask when a detail in a screenshot is unclear instead of guessing.

## 3. Git and deployment

- **Do not commit or push unless the user asks** ("commit karke push kar do"). When they do: commit everything intended and push the current branch.
- Never commit the root `service.ts` (stray backup). Never force-push or rewrite history.
- Pushes to `main` ("live karna") have been done **by the user** because an assistant's auto-mode classifier blocks direct pushes to `main`. Don't try to work around a block; explain what is needed and let the user run it (`git push origin feature/ui-change:main`).
- Current branch convention: work on `feature/ui-change`; `main` is the production branch (Vercel auto-deploys the dashboard from it; the backend is on Render, deployed separately).
- Do not deploy, and do not touch production data. Never send real customer messages.

## 4. Testing and verification requirements

- After a fix: reproduce → fix → regression test → verify → run the relevant tests, then typecheck/build. For a bug list, **run only the relevant tests unless the user asks for the full suite** (they said so on the bug-sheet task). Never skip typecheck on touched apps (`npm run typecheck`; dashboard `npm run build`). There is no lint script.
- Every bug fix needs a bug-specific test where practical (server tests may import the dashboard's pure helpers; keep helpers free of React/browser APIs so they stay testable, e.g. `lib/settingErrors.ts`, `lib/agentNames.ts`).
- UI changes must be **verified in the browser** against the real running dashboard (temporary servers on :4100 / :5273, mock LLM), not just by typecheck. Read the DOM; screenshots are secondary.
- Use a safe test environment: mock LLM, PGlite, temporary Postgres/Redis for the integration tier. Never run anything against production.
- **Paid model calls need approval**: before any call to a real LLM (evals, real-model smoke checks, `npm run chat`), give a cost estimate and get an explicit OK for that run; one approval doesn't cover the next. Free checks (mock model, typecheck, tests) need no ask. Never print or read API keys from `apps/server/.env`.
- Update `PROGRESS.md` only after verifying the work (the user's wording: "Update PROGRESS.md only after verifying the implementation").

## 5. Environment constraints

- macOS, zsh. `set -- $var` doesn't word-split in zsh; BSD `sed -i ''` needs the empty string; prefer small Python scripts for multi-line edits.
- **No Docker.** The integration tier uses Homebrew Postgres 17 + pgvector and Redis, started ad hoc (ports 55432 / 56379) and stopped afterwards. Steps are in `AI_HANDOVER.md` §5.
- **The user runs their own dev servers** (API on :4000 with `pglite://.data/preview`, dashboard on :5173): don't stop them or start previews on those ports. Use :4100 / :5273 for verification and restore `.claude/launch.json` afterwards.
- Local dev DB is PGlite and single-process: one API per `pglite://` directory.
- **Deletion:** do not delete files or folders (including temp/scratch folders) unless the user asked. In the last session an `rm -rf` of a scratchpad folder was refused by the user; the folder turned out to be gone anyway. Ask first, or leave it.
- Secrets: never write API keys, passwords, tokens, JWT/encryption secrets or `.env` values into code, docs, tests, commits or chat. The dashboard's `.env.production` is public (browser) config only.

## 6. Code style

- Write code that reads like the surrounding code: same comment density, naming and idiom. The repo is not Prettier-clean at HEAD, so don't reformat files you aren't otherwise changing.
- Comments explain *why*, in plain English, usually one short block above the code. Error and UI messages are plain-language ("Enter a whole number between 1 and 500."), not raw field paths.
- Bot settings are one JSON config parsed with defaults on every read; new settings must default to **off/unchanged** so existing bots behave exactly as before.
- Keep server rules mirrored where the dashboard validates the same thing (e.g. phone, email, website, timing limits).

## 7. Documents you must not edit

- `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md` (user-owned). `docs/IMPLEMENTATION_PLAN.md` and `PROGRESS.md` are updated as the work is approved/verified (the `scripts/verify-phase.mjs` hook owns the marker blocks in PROGRESS.md; edit only text outside them).

## 8. Decisions that must not be changed (unless the user says so)

**Product / platform**
- Only the **website chat widget** is available; other channels are hidden "Coming soon" (SMS, WhatsApp, Instagram, Facebook, TikTok, Live chat, Email, marketplace tile). Hidden things stay in code behind flags (`hidden`, `SHOW_FOLDERS`, `SHOW_MARKETPLACE_TILE`) to switch back on later.
- Hidden: Voice AI, Content AI and Agent Studio tabs, Marketplace Templates, "Create folder", Transfer Bot / Auto Followup actions.
- GHL look: GHL blue theme; the six pages (Conversations, Leads, Deals, Appointments, Automations, Settings) stay separate from the AI Agents flow; the left sidebar for the agents flow shows AI Agents.
- Default new-agent name: **"New Employee N"**, no naming step in Create Agent (user reversed an earlier naming step on 2026-10-15). Templates keep "<template> <date>".
- Provider-neutral LLM layer; the provider and model are configuration (no model name hard-coded). A model override is checked with the provider when saved; if the provider can't say, a save is never blocked.

**Human Handover (accepted 2026-10-14)**
- Scenario-only like GHL: no General Settings section anywhere. Handover is on while any scenario is on; the team is **always** notified on a handover; migrated old bots get a "Complaint or sensitive issue" scenario ON; new agents start with all three ready-made scenarios OFF; outside team hours the away message replaces the scenario message; reactivation keeps waiting while the team is replying; max 6 scenarios; "Create a task" is due in 24 h.
- System handoffs (AI error, monthly budget, reply limit) keep working with the built-in message.

**Stop Bot / Booking**
- Stop Bot: the conversation stays the AI's; messages that arrive while stopped are never answered later; staff Resume AI or a takeover ends the stop.
- Booking Advanced Options: all off by default; "link only" removes the availability and booking tools but keeps list/reschedule/cancel; workflows after a booking must be ones that can run without a person (not ask-first, inputs from the booking).

**QA track decisions (2026-10-02)**
- Visitor IP: admin-only + an org setting (orgs from before the setting keep recording; new orgs start off).
- Phone: keep strict `libphonenumber` validation (fix messages, not rules).
- Custom field keys: cleanup/preview only, no rename.
- BUG-13: separate "Reopen" action (not takeover).
- BUG-15: demo served from the API address; no hosting changes yet.
- BUG-14 (hosting): decided separately from code fixes.
- Priorities named by the user: AI Conversations → Long-term Memory → RAG → Lead Capture → Lead Qualification → Appointment Booking.

## 9. Not verified

- Whether the strict phase-approval rule (§2) still applies word for word to small direct requests; the observed behaviour in October is described there as **[inferred]**.
- What the user's other tools or assistants are allowed to do (e.g. whether the auto-mode `main` block applies to them).
- The content of the user's Claude memory notes is summarised here; the files live outside the repo at `~/.claude/projects/-Users-deepaksharma-Workspace-chat-bot/memory/`.
