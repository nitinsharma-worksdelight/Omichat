# Current status — 2026-10-15

Snapshot for the next AI assistant. Overview and commands: [`AI_HANDOVER.md`](AI_HANDOVER.md). Rules: [`AI_RULES.md`](AI_RULES.md). Per-feature detail: `PROGRESS.md` (its "Current phase" header is stale, see §3).

**[verified]** = checked in the repo or in command output; **[unverified]** = could not be checked from here.

## 1. Git state **[verified]**

- Branch: `feature/ui-change` at `b6afb27` ("QA bug sheet fixes: model check, form validation, agent names, UI polish"), pushed to `origin/feature/ui-change`.
- `origin/main` is at `21292aa`: **it does not contain `b6afb27`**. Going live = `git push origin feature/ui-change:main`, which the user runs themselves (an assistant's auto-mode classifier blocked direct pushes to `main`; the user ran them by hand).
- Untracked, intentionally not committed: `service.ts` (stray backup of an old file, never commit) and the three handover files plus `SESSION-CONTEXT.md` created at the user's request (not committed; the user has not asked for that).
- Other branches: `main`, `qa-fixes-and-hardening` (local and remote).
- Recent commits: `b6afb27` bug-sheet fixes · `21292aa` empty commit to trigger a Vercel build · `f8f88bb` Stop Bot + scenario handover + booking options + QA fixes · `e47dda2` Getting Started/Templates · `e643825` GHL-style AI Agents + API Call.

## 2. Completed work (2026-10-09 → 10-15)

- **GHL-style AI Agents** (6 separate pages kept: Conversations, Leads, Deals, Appointments, Automations, Settings; builder with Build/Deploy; Getting Started; Templates gallery; GHL blue theme; API Call action backend). Voice AI / Content AI / Agent Studio tabs and "coming soon" actions hidden; Marketplace Templates hidden; Deploy shows only the Chat widget.
- **Stop Bot** — scenarios, `stop_bot` tool, per-conversation stop/restart, banner, tests (`test/stop-bot.test.ts`).
- **Human Handover, scenario-only (like GHL)** — General Settings removed; three ready-made scenarios + custom ones (max 6); existing bots migrated on read; away message under Timing & Pacing; reactivate timer, tasks, tags (`test/handoff-scenarios.test.ts`).
- **Booking Advanced Options** (GHL layout) — booking link only, pause after booking, trigger workflows, transfer employee (`test/booking-advanced.test.ts`).
- **QA pass on Handover / Stop Bot / Booking** — 8 bugs fixed (link scheme check, approved booking + pause, stale references blocking saves, removed assignee, workflow compatibility, stale stop after takeover, notification text, concurrent workflows). Tests: `test/qa-three-features.test.ts`, `test-integration/handover-stop-booking.test.ts` (real Postgres/Redis).
- **QA bug sheet (`Omni AI Dashboard - QA Bug Sheet.xlsx`, 14 bugs)** — 11 fixed, 1 already fixed, 2 not code bugs. Fixes: model override validated against the provider; Timing & Pacing inline errors and plain field names; empty-submit messages; sidebar search sync; date format; Agent Logs heading; Create folder hidden; starter error after touch; Add contact phone check; unique-contacts definition shown. Tests: `test/qa-bugsheet.test.ts`.
- **Default agent name** — "New Employee 1", "New Employee 2"… (one past the highest number, computed at creation). An intermediate "Name your agent" step was built and then **removed at the user's request**; Create Agent creates at once as before.
- Custom Values (`{business_name}` etc.) were explained, not changed.

## 3. Phase tracker (from PROGRESS.md) **[verified]**

Complete: Phases 1–3, 5–15, 18 (F1–F6, F9), 19–21 (H1–H3). Skipped: 0. Deferred until after F9: **4** (evaluation harness / model choice). Not started: **F7 Chat Widget (16)**, **F8 Follow-ups (17)**. Planned, awaiting approval: **H4 Cost and abuse limits, H5 Data integrity, H6 Production guards and observability, H7 KB ingestion, H8 Widget robustness/privacy/handoff UX, H9 Summaries and analytics correctness, H10 Remaining medium/low items**.
Note: PROGRESS.md's "Current phase"/"Next phase" text says H3 / F7 and was last aligned in early October; the later UI redesign (U1–U8), Q1–Q7 QA track and GHL-style agents work are recorded in their own sections. Which of F7/H4+ the user wants next is **not decided** — ask.

## 4. Current task

None in progress. The last request handled was writing this handover pack. Before it: the user asked to commit and push everything (done: `b6afb27` on `feature/ui-change`) and for a session context file (`SESSION-CONTEXT.md`).

## 5. Pending decisions, bugs and known issues

**Waiting for the user's answer**
1. After "pause bot after booking" (or a Stop Bot scenario without a timer), a customer who writes gets no reply and the team gets no alert. Alert the team? Add a time limit to the pause?
2. Should "talk to a human" phrases still hand over while a chat is stopped/paused? Today they are ignored (Stop Bot means silent).
3. User-defined Custom Values (`{any_name}` with a value each): not built; a plan was offered, **not approved**.
4. Whether to push `b6afb27` to `main` (user-run).

**Data / hosting items (not code)**
- QA bug BUG-014: the custom field with key `bad_key_` ("QA Budget (INR)") is old test data in the QA environment; the server already refuses such keys. The user should delete it in Automations → Custom fields. **[unverified whether done]**
- QA bug BUG-004 (slow pages, 10–14 s test-chat replies): measured 3–32 ms for list endpoints locally with 1,500 contacts/1,200 chats, so slowness is likely hosting (Render free tier sleeps/cold starts, region) and model latency. **[unverified in production]** The user kept hosting decisions separate from code.
- The Render backend must be redeployed to get the new server code (booking options, handover scenarios, Stop Bot, model check); otherwise the dashboard shows settings that the old server won't save. **[unverified what is deployed]**

**Known risks / limits (recent work)**
- A booking turn cut off mid-way and retried sees a duplicate slot, so pause/transfer may be skipped (very rare, not fixed).
- `identifiedOnly` workflows won't run after a booking in a web chat (only an activity note).
- Partial PATCH of the `handoff` config section (API clients) replaces the whole section and can switch handover on via the legacy migration (existing contract).
- DST fall-back hour (ambiguous local times) not tested.
- Templates gallery "Use template" still creates an agent immediately named "<template> <date time>" (only Create Agent uses "New Employee N").
- No real-model (paid) checks were run in recent work; real email sending was not tested.

**Older issues** are in PROGRESS.md → "Remaining issues" (e.g. several dashboard tabs stalling API requests over HTTP/1.1, README test count outdated, widget raw "Failed to fetch" message).

## 6. Verification status

| Check | Result | When / note |
|---|---|---|
| Full server suite (`cd apps/server && npx vitest run`) | 588/588, 56 files | before the bug-sheet work; **not re-run after `b6afb27`** |
| Related files for the bug sheet (9 files) | 92/92 | after the last code change |
| `test/qa-bugsheet.test.ts` | 17/17 | after the last code change |
| Integration tier (real Postgres 17 + Redis) | 19/19 | before the bug-sheet work |
| `npm run typecheck`, dashboard `npm run build` | pass | after the last code change |
| Lint | n/a | no lint script exists |
| Browser checks of each UI fix | done on a local mock server | not on production |

## 7. Exact next steps

1. Ask the user which is next: push `b6afb27` to `main`; answer the two open decisions in §5; start F7/F8/H4+ (needs explicit approval per `AI_RULES.md`).
2. Before any new work, run `git status` and read `AI_RULES.md`. Don't touch `service.ts`.
3. If the user wants it live: they run `git push origin feature/ui-change:main`; then check Vercel shows a Production deployment for the new commit, and that the Render backend runs the same code.
4. Re-run the full server suite once (`cd apps/server && npx vitest run`) to refresh the 588 baseline (now +17 tests), after the user OKs running it, and update the counts here and in PROGRESS.md.
5. Optionally refresh the stale "Current phase" header in PROGRESS.md (outside the verification-hook marker blocks) — only if the user agrees.
