# Session context (2026-10-13 → 2026-10-15)

What was done in this session, why, and where things stand. `PROGRESS.md` has the per-feature detail; this file is the short map.

## 1. Git state

| Commit | What | Where it is |
|---|---|---|
| `e643825` | GHL-style AI Agents, API Call action, approvals realtime, availability fixes | `main` + `feature/ui-change` |
| `e47dda2` | Getting Started, Templates gallery, hidden tabs and actions | `main` + `feature/ui-change` |
| `f8f88bb` | Stop Bot, scenario-only Human Handover, Booking Advanced Options, QA fixes | `main` + `feature/ui-change` |
| `21292aa` | Empty commit to trigger the Vercel production build | `main` + `feature/ui-change` |
| `b6afb27` | QA bug sheet fixes, "New Employee N" names, UI polish | **`feature/ui-change` only** |

- `main` is at `21292aa`. To make `b6afb27` live: `git push origin feature/ui-change:main` (the user runs this; the assistant's classifier blocks direct pushes to `main`).
- The root `service.ts` is a stray backup. It is deliberately **never committed**.
- The backend is deployed separately. Booking Advanced Options, Handover scenarios, Stop Bot and the model check need the new server code, so the backend must be deployed too.

## 2. What was built

1. **Marketplace Templates** hidden in Create Agent (`hidden` flag on `AGENT_KINDS`).
2. **Stop Bot** (GHL screenshots): scenarios in `config.actions.stopScenarios`, `stop_bot` tool, per-conversation stop in `conversations.metadata.aiStop`, restart timer, tags, banner and Resume AI. Sweeper and approval follow-ups respect it.
3. **Human Handover, scenario-only (like GHL):**
   - No General Settings. Handover is on while any scenario is on (`handoff.enabled` / `keywords` are derived).
   - Three ready-made scenarios (Human Requested, Lack of information, Failed to resolve), off for new agents. Max 6 scenarios.
   - Each scenario: assignee, final message, reactivate timer (8 h), task due in 24 h, tags.
   - Existing bots are migrated on read and keep their behaviour (a "Complaint or sensitive issue" custom scenario is added).
   - Away message and waiting/fallback live under Timing & Pacing.
4. **Appointment Booking, Advanced Options** (GHL layout): booking link only, pause bot after booking, trigger workflows after booking, transfer employee after booking, plus cancel/reschedule switches. All off by default.
5. **Deploy tab:** only the Chat widget card is shown. The other channels and the marketplace tile are kept in code behind `hidden` / `SHOW_MARKETPLACE_TILE`.
6. **Custom Values (explained, not changed):** 7 fixed placeholders (`{business_name}`, `{agent_name}`, `{business_hours}`, `{business_website}`, `{business_phone}`, `{business_email}`, `{business_location}`), filled by the server (`fillCustomValues`) from the agent's settings, in Instructions only. User-defined placeholders do not exist yet (would need a new config list, plan not approved).

## 3. QA passes

**Handover / Stop Bot / Booking pass (8 bugs, all fixed):**
- Booking link accepted `javascript:` and other schemes (now http/https only, no spaces).
- An approved ask-first booking never told the customer when "pause after booking" was on.
- A team member leaving, or a deleted workflow or calendar, blocked every save of the bot (only newly chosen references are validated now).
- A scenario could assign a chat to someone who had left the team.
- Workflows that can never run after a booking (ask-first, off, needing other chat inputs) were accepted.
- A stale stop could be recorded after a human took over.
- Wrong notification text for scenario assignment.
- After-booking workflows ran one by one (now together).

**QA bug sheet (Downloads, 14 bugs):** 11 fixed, 1 already fixed, 2 not code bugs.
- Fixed: 001 model validated against the provider, 002 Timing & Pacing inline errors and plain field names, 003 default name, 005 unique-contacts definition shown, 006 empty-submit messages, 007 sidebar search sync, 008 date format, 009 Agent Logs heading, 010 Create folder hidden, 011 starter error after touch, 012 contact phone check.
- 013: only the Chat widget is shown (already done).
- 004 (slow pages and replies): not a code bug. List endpoints take 3–32 ms locally (1,500 contacts, 1,200 chats), so it is hosting, cold starts and model latency.
- 014 (`bad_key_` custom field): the server already refuses such keys. It is old test data that the user should delete in Automations → Custom fields.

**Default agent name:** "New Employee 1", then 2, 3… (one past the highest number, asked at creation). Template agents keep their template name. There is no naming step.

## 4. Decisions made

- Handover: always notify the team; away message replaces the scenario message outside team hours; reactivate waits while the team is replying.
- Model check: ask the provider only when a model is sent; if the provider can't say (down, key rejected, custom endpoint), never block a save.
- Stale references are not re-validated on unrelated saves.
- Hidden features stay in code behind flags, to switch on later.

## 5. Open questions for the user

1. After "pause bot after booking" (or a Stop Bot scenario with no timer), a customer who writes gets no reply and the team gets no alert. Should the team be alerted, or the pause get a time limit?
2. Should "talk to a human" phrases still hand over while a chat is stopped or paused? Today they are ignored.

## 6. Known risks and untested areas

- No paid/real-model calls were made; everything ran on the mock model. Real email sending was not tested.
- A booking turn that is cut off mid-way and retried sees a duplicate slot, so pause/transfer may be skipped (very rare).
- `identifiedOnly` workflows won't run after a booking in a web chat (only an activity note).
- Partial API PATCH of the `handoff` section replaces the whole section (existing contract) and can switch handover on via the legacy migration.
- Ambiguous local times in the DST fall-back hour were not tested.

## 7. How to verify

- Server tests: `cd apps/server && npx vitest run <files>`. Last runs: full suite 588/588 (before the bug-sheet work); related set 92/92; integration tier 19/19 on real Postgres 17 + Redis.
- Key test files: `qa-three-features`, `booking-advanced`, `handoff-scenarios`, `stop-bot`, `qa-bugsheet`, and `test-integration/handover-stop-booking`.
- Type-check and build: `npm run typecheck` and `npm run build` at the root. There is no lint script.
- Integration tier: start Postgres 17 (`initdb`, `pg_ctl` on port 55432, `LC_ALL=en_US.UTF-8`) and Redis (port 56379) ad hoc in the scratchpad, then `INTEGRATION_DATABASE_URL=postgres://omni@localhost:55432/postgres INTEGRATION_REDIS_URL=redis://localhost:56379/15 npx vitest run -c vitest.integration.config.ts`. Stop both afterwards.
- Browser checks: add temporary `verify-api` (port 4100, `pglite://.data/verify-agents`, mock LLM) and `verify-dashboard` (port 5273) entries to `.claude/launch.json`, then restore the file afterwards (a backup copy is kept in the scratchpad). Never touch the user's own servers on :4000 / :5173.

## 8. Working rules from the user

- Replies in short Hinglish unless asked for English or detail. When asked to plan or analyse with "don't change code", give the plan only and wait.
- No commit or push unless asked. `main` pushes are done by the user.
- No paid model calls without a cost estimate and an explicit OK.
- Fix UI timing issues at the root cause, never with `setTimeout`.
- Do not delete files or folders the user didn't ask to delete (an `rm -rf` of the scratchpad `it/` folder was refused; the folder turned out to be gone anyway).
