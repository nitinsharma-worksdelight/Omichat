# Progress

Single source of truth for phase status. Plans: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Current phase

**F5 (Phase 14) — AI Actions** · **✅ Complete** (2026-09-29): F5a and F5b built and verified. Next: F6 (Phase 15) —
Human Handoff, not started · updated 2026-09-29

Plan: `docs/IMPLEMENTATION_PLAN.md` → F5 (two steps, F5a and F5b). Feature order: F1–F5 done → F6 → … →
F9, one at a time, then Phase 4 (deferred until after F9). The hook tracks F1–F9 as phases 10–18.

## Phase status

<!-- phase-status:start -->
| Phase | Title | Status | Last verified |
|---|---|---|---|
| 0 | Baseline and safety net | ⏭️ Skipped (2026-09-27) | — |
| 1 | Safe identity handling | ✅ Complete (2026-09-27) | 2026-09-27 |
| 2 | Booking correctness | ✅ Complete (2026-09-27) | 2026-09-27 |
| 3 | Reliable AI turns | ✅ Complete (2026-09-27) | 2026-09-27 |
| 4 | Evaluation harness and model choice | ⏸️ Deferred (until after F9) | — |
| 5 | Conversation memory | ✅ Complete (2026-09-28) | 2026-09-28 |
| 6 | Lead capture completeness | ✅ Complete (2026-09-28) | 2026-09-28 |
| 7 | Per-bot qualification (only if needed) | ✅ Complete (2026-09-28) | 2026-09-28 |
| 8 | Knowledge-base search quality | ✅ Complete (2026-09-28) | 2026-09-28 |
| 9 | Booking completeness | ✅ Complete (2026-09-28) | 2026-09-28 |
| 10 | F1 · Bot Personality | ✅ Complete (2026-09-28) | 2026-09-28 |
| 11 | F2 · Conversation Context | ✅ Complete (2026-09-28) | 2026-09-28 |
| 12 | F3 · Conversation Summary | ✅ Complete (2026-09-28) | 2026-09-28 |
| 13 | F4 · CRM Integration (with deals and API-channel delivery) | ✅ Complete (2026-09-28) | 2026-09-28 |
| 14 | F5 · AI Actions | ✅ Complete (2026-09-29) | 2026-09-29 |
| 15 | F6 · Human Handoff | ⏳ Not started | — |
| 16 | F7 · Chat Widget | ⏳ Not started | — |
| 17 | F8 · Follow-ups | ⏳ Not started | — |
| 18 | F9 · Analytics / Management | ⏳ Not started | — |
<!-- phase-status:end -->

Statuses: ⏭️ Skipped · ⏸️ Deferred · ⏳ Not started · 📝 Planned — awaiting approval · 🔨 In progress ·
🧪 Implemented — verifying · ❌ Verification failed · ✅ Complete. Only a passing
`npm run verify:phase -- <n> --complete` run can set ✅ Complete. The hook refuses to complete a deferred phase.

## Completed work

- **2026-09-26 — Full audit.** Stack, the five Phase 1 features, the LLM layer, architecture problems and the
  gap analysis. Typecheck clean on all three apps.
- **2026-09-27 — Phase 1 explore, audit and plan.** Findings and the proposed approach are in
  `docs/IMPLEMENTATION_PLAN.md` → Phase 1. New findings beyond the first audit:
  - `trigger_workflow` would also send the matched customer's data to n8n
  - playground tests with a real customer's email pollute that real record
  - a unique-index race during capture crashes the tool
- **2026-09-27 — Phase 1 implemented and verified.**
  - An email or phone captured by the AI in a chat that belongs to another contact is no longer merged. It's kept
    as a pending *duplicate review*, and the visitor's contact is never linked to the other contact.
  - In the visitor's own conversation, the AI still uses what they said (an "effective contact" view). Nothing
    from the other contact reaches the AI's context, tools or workflows, and the tool reply doesn't reveal the match.
  - Staff merge or dismiss reviews from the contact page (agents and API keys with `contacts:write`). Test contacts
    can't be merged into real ones. Staff get a notification, and webhooks receive `contact.duplicate_detected`.
  - The public API's `contact` payload is trusted and merges as before.
  - A unique-index race during capture becomes a review instead of a crash.
  - The progress hook exists: `npm run verify:phase -- <n> [--complete]`.
- **2026-09-27 — Phase 2 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 2.
  - Findings confirmed from the first audit:
    - the duplicate-check key ignores the appointment's status and current time
    - `confirmation_sent_to` makes the bot claim a confirmation was sent
    - buffers and the daily cap aren't protected under concurrency
  - New findings:
    - cancelling twice reports a failure for a cancellation that did happen
    - a dashboard double click gets a 409 for the contact's own booking
    - staff aren't notified when an appointment is rescheduled
  - Proposed change from the original sketch: detect duplicates by contact + calendar + start time, instead of a
    key built from the triggering message.
- **2026-09-27 — Phase 2 implemented and verified.**
  - A repeated booking now means "this contact already holds this exact slot" and returns that booking. So:
    - cancel-then-rebook of the same slot creates a real booking
    - reschedule-then-rebook of the original time creates a real booking
    - a retried AI turn or a dashboard double click gets the existing booking back (`already_booked` / HTTP 200)
  - `book_appointment` no longer claims a confirmation was sent: `customer_confirmation_sent: false`, and one
    prompt line says nothing is sent automatically.
  - Bookings and reschedules on one calendar are processed one at a time (transaction-scoped Postgres advisory
    lock), so buffers and the daily cap hold under concurrency.
  - Cancelling twice, or rescheduling to the same time, are harmless repeats with no second event.
- **2026-09-27 — Phase 3 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 3.
  - Confirmed findings:
    - a retry re-runs `add_note`, `create_task`, `notify_team` and `trigger_workflow`, creating duplicates
    - turns have no time limit (up to 6 model calls of up to 120 s each)
    - the Redis lock's fixed 180 s TTL can expire mid-reply
    - `handoff.notifyTeam` is never read
  - New findings: the providers already support abort signals, but the orchestrator never sends one. An aborted
    call wouldn't count as a retryable error.
  - Changes from the original sketch:
    - no DB migration, because earlier attempts are found through `ai_runs.trigger_message_id`
    - replayed calls are matched by order, not arguments
    - the summary-cadence fix is proposed to move to Phase 5
- **2026-09-27 — Phase 3 implemented and verified.**
  - **Retries replay instead of repeating.** When a turn is retried, `add_note`, `create_task`, `notify_team` and
    `trigger_workflow` (the last per workflow) replay the earlier attempt's result instead of acting again.
    - Calls are matched by order, not wording.
    - A call the earlier attempt didn't make still runs.
    - Replays are logged as `replayed` and show as "reused" in the dashboard timeline.
    - No DB change was needed.
  - **Time limit per reply.** Every reply has a limit (`AI_TURN_TIMEOUT_MS`, default 90 s) covering model calls and
    tools. A reply that runs out is retried; after the last attempt the customer gets an apology and a person.
  - **Self-renewing lock.** The Redis conversation lock renews itself (TTL 60 s, renewed every 20 s). If the lock is
    lost, the reply stops before acting or answering and is retried, so there are never two replies.
  - **`handoff.notifyTeam` respected.** Handoffs caused by an AI error or the monthly budget always alert staff.
    Webhooks receive every handoff.
- **2026-09-27 — Phase 4 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 4. No paid
  calls were made: request sizes were measured with the fake model on the seeded demo.
  - **Measured.**
    - The fixed prefix (13 tools + system prompt) is about 3.5K tokens.
    - A 5-message booking conversation makes 8 model calls, about 33K input tokens in total.
    - 81% of each call repeats the previous one, so it can be cached.
  - **Model facts verified.** Prices, context sizes and effort support for `gpt-6-luna`, `gpt-6-sol`,
    `claude-haiku-4-5` and `claude-sonnet-5`. The installed SDKs already accept effort `none` and
    `thinking: disabled`.
  - **New findings.**
    - `gpt-6-*` reason at `medium`, and Claude Sonnet 5 thinks at `high`, unless told otherwise. There's no
      "no reasoning" setting.
    - The Anthropic provider has never run, and it sends effort even to Haiku 4.5, which rejects it.
    - Earlier tool results aren't in the model's history, so a slot accepted one message later must be rebuilt from
      the bot's own wording.
    - Haiku 4.5 probably can't cache our prompt (its minimum is 4,096 tokens).
  - **Proposed:**
    - a free-to-build eval harness with about 22 scripted scenarios and code-only checks
    - 8 model configurations
    - effort `none`
    - Anthropic provider tests
    - three paid run stages, each approved separately (about $4–11 in total)
- **2026-09-27 — Phase 4 deferred** until after Phase 9, by your decision. It is marked deferred, not complete, and
  its plan is kept with a list of what to refresh first. New order: 5 → 6 → 7 → 8 → 9, then 4. The dependency
  check found no blocker for Phases 5–9.
- **2026-09-27 — Phase 5 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 5.
  - **Already there:** rolling summaries, long-term facts in `contacts.memory` (written by `add_note`, last 10 shown
    each turn), and the contact record in every turn.
  - **Confirmed:** the summary cost bug. After 30 messages every reply queues a summary job, because BullMQ drops
    finished jobs and the job ID repeats. A summary is written about every 2 exchanges.
  - **New findings:**
    - Summaries don't start until 30 messages, so between messages 21 and 30 the start of a conversation is in
      neither the history nor a summary.
    - Nothing is remembered across conversations.
    - Nothing closes idle conversations, and the model can't see time gaps.
    - Summary jobs ignore the AI switch and the monthly budget.
    - Knowledge search runs for "hi" and "thanks".
    - Memory reaches the model unlabelled, and the summary tag isn't escaped.
  - **Checked and safe:** memory never crosses between people through Phase 1's pending claims.
- **2026-09-28 — Phase 5 implemented and verified.**
  - **No gaps in long conversations.**
    - The model sees the summary plus every message not yet summarized: at least 20, at most 40.
    - Past 30 unsummarized messages, one background job folds the oldest into the summary.
    - A 50-message chat now makes 2 summary calls instead of 5. Short chats make none from this rule.
  - **Summary jobs:**
    - they read only new messages
    - they stop when the AI switch is off or the monthly budget is spent
    - they save only if nothing newer was saved, so a slow job can't roll a summary back
  - **Recaps.**
    - A recap is written 30 minutes after the last customer or staff message (`AI_SUMMARY_IDLE_MINUTES`), and right
      away when staff close a conversation.
    - Chats with a single customer message are skipped.
    - The contact page's Conversations tab shows each recap.
  - **Returning customers** see recaps of their last 2 other conversations on any channel, with date and channel,
    capped at 2,700 characters. They are looked up only by the conversation's own contact, so a visitor who merely
    typed someone's email sees nothing of theirs. After a staff merge, the history comes along.
  - **What the bot already did.** Each turn lists the last 10 actions, plus the slots most recently offered with
    their exact start values (dropped after 24 hours). A slot accepted a message later can now be booked exactly.
    The Phase 4 audit finding is fixed.
  - **Smaller additions:**
    - long pauses are marked in the history ("3 days after the previous message")
    - greetings, thanks and goodbyes skip knowledge search
    - memory is labelled as notes, not instructions
    - customer text, recaps and summaries can't open or close the framing tags, now including the customer's newest
      message
- **2026-09-28 — Phase 6 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 6.
  - **The requirements doc** was read through the Docs connector, and all ~101K characters were searched. It asks for
    name, phone, email and intent captured in the chat, plus custom fields for segmenting; both already work. It
    says nothing about consent or lead source, which the first audit added as production needs (privacy law and
    marketing attribution).
  - **Findings:**
    - Only the first channel is recorded as a lead's source. The widget sends the page URL of each message, but not
      the landing page, referrer or UTM tags, and nothing reads what it stores.
    - Stored page URLs keep the full query string, which can hold personal data.
    - Contacts created by staff are labelled as API leads.
    - Consent is never recorded: the privacy notice is only something the model is asked to mention, and it may
      paraphrase it.
    - There are no ready-made business-detail fields.
  - **Proposed:**
    - first-touch source from the widget and the API
    - page URLs trimmed to UTM and click-ID parameters
    - a marketing opt-in whose exact wording is posted by the server, with the customer's reply as evidence
    - staff and API consent records
    - custom field templates
- **2026-09-28 — Phase 6 implemented and verified.**
  - **Where each lead came from.**
    - On the visitor's first page load, before they ever chat, the widget records the first touch: the landing page
      without its query string, the referrer when it's another site, UTM tags and ad click IDs.
    - It is sent with each message and stored on the contact once (`first_touch`), never overwritten.
    - The public API (`source`) and `POST /v1/contacts` accept the same fields. A merge keeps the earlier first touch.
    - Shown on the contact page (Source card); the Leads list gains Source, Campaign and Consent filters and a Source
      column; webhooks' contact snapshot carries `first_touch`.
  - **Page-URL privacy.** Stored page URLs keep only UTM and click-ID parameters, trimmed by the widget and again
    by the server for every channel.
  - **Marketing opt-in with proof.**
    - A bot can have an exact opt-in question. The AI asks by calling a tool, and the server posts the wording
      verbatim as its own message right after the reply.
    - A yes is recorded only after that question was posted and the customer answered; a reply that's plainly a
      "no" can't be recorded as a yes.
    - Each record keeps the exact text, a version hash, the question and answer messages, and the source.
    - Withdrawals are accepted anytime, with the customer's message as evidence.
    - Staff record or withdraw with a note; integrations send the wording they showed.
    - History is append-only, moves with merges, and goes to webhooks (`contact.consent_updated`).
  - **Smaller:** contacts created by staff no longer say `api`; "Add from template" adds Industry, Company size,
    Website, Budget and Job title.
- **2026-09-28 — Phase 7 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 7.
  - **Per-bot storage isn't needed now.** Each widget's visitors are separate contacts, so one person reaches two
    bots only after a merge, a bot switch or an integration. One shared record per contact is also how GHL works.
  - **Two problems that hit every organization,** reproduced for free:
    - A disqualified lead stays disqualified after answering differently (score 80 against a threshold of 60, still
      disqualified), and the AI is told not to offer a booking.
    - After the business edits its question options, an old answer that no longer fits still counts, so the bot
      doesn't ask again and the lead is re-scored as disqualified.
  - **Also:** the prompt shows answers to other bots' questions, and qualification events don't say which bot asked.
  - **Recommended:** narrow the phase to these fixes, with no new table and no migration, instead of per-bot storage.
- **2026-09-28 — Phase 7 implemented and verified** (narrowed to qualification fixes, as approved).
  - **A disqualified lead can become qualified.** When their answers now qualify, they become qualified and the
    qualified outcome runs once: tags, lifecycle stage, team alert, and `lead.qualified` with
    `previousStatus: "disqualified"`. The AI's guidance switches to the qualified next step, such as offering a
    booking. A qualified lead stays qualified until staff reset it.
  - **Only answers that fit count.** Scoring, the next question and the prompt use only stored answers that still
    fit this bot's current questions. One that no longer fits is asked again but stays stored as history; this
    covers edited options or type, a switched bot, and another bot asking the same key differently.
  - **Which bot asked.** Each answer records the asking bot, qualification events carry `botId`, and the contact page
    shows "asked by …" and marks answers that no longer fit.
  - **Editor warning.** The bot editor warns when another bot uses the same question key with a different type or
    options.
- **2026-09-28 — Phase 8 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 8.
  - **Baseline**, measured for free with the local embedder (22 questions: demo plus a Spanish and Hindi FAQ):
    - English: 11 of 14 right first, 12 of 14 in the top 5
    - Spanish: 3 of 4 in both
    - Hindi: 2 of 2 in both, but only because the queries repeated the FAQ's wording
    - Hinglish: 1 of 2 in both
    - Missed: synonyms ("toothache" for "dental emergency", "installments" for "payment plans") and a Spanish question
      about English content.
  - **Findings:**
    - Keyword search is English-only (index and query).
    - Our word splitting breaks Hindi and other Indic words into fragments, so keyword search can't match them.
    - Website sources are never refreshed.
    - Nothing measures search quality.
    - The database already offers 30 text-search languages, and the search test box already shows scores.
  - **Proposed:**
    - a question set with free CI floors, plus a paid production measurement before and after (well under $0.01
      each, with your OK)
    - a language setting per knowledge base
    - whole-word splitting in every script
    - a search-again-in-the-knowledge-base's-language hint
    - scheduled website refresh
    - a reranker only if production numbers show a gap
- **2026-09-28 — Phase 8 implemented and verified** (as approved).
  - **Keyword search in each knowledge base's language.** A knowledge base has a language: English by default, any of
    the database's 29 dictionaries (Spanish, French, Hindi, Tamil, …), or "Any language" (exact words). Search matches
    each knowledge base in its own language, so Spanish "cuesta" finds "cuestan". Changing the language re-indexes
    that knowledge base only, with no re-embedding. An unknown language is refused.
  - **Whole words in every script.** Hindi, Tamil and other scripts that write vowels as marks are no longer split
    into fragments, in keyword search and in the local dev embedder (renamed `local-hash-v2`, so dev databases
    re-embed themselves once; OpenAI embeddings aren't affected).
  - **Help across languages.** The prompt names the documents' language(s) and tells the AI to search again in that
    language when a customer writes in another one and the snippets don't answer.
  - **Websites stay current.** A web page can refresh daily or weekly (off by default). A worker checks every 10
    minutes. An unchanged page costs one fetch and no embedding; a changed page is re-ingested. If a fetch fails,
    the page keeps answering from its last good version and is tried again within 6 hours.
  - **Dashboard:** the knowledge base's language (badge and setting), "Keep up to date" on web pages (add and edit),
    "refreshes daily (last …, next …)", and a clear note when a fetch failed but the old version is still used.
  - **Also fixed:** changing a document's category didn't reach search (the chunks kept the old category, so the
    AI's category filter missed them). The new category now applies immediately, without re-ingesting.
  - **Measured** with a 31-question set (English, Spanish, Hindi, Hinglish, cross-language). Before/after numbers are
    under Tests / verification. Production top-5 is 31 of 31 before and after, so no reranker is proposed.
- **2026-09-28 — Phase 9 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → Phase 9.
  - **Reproduced for free** (fake model, fixed clock):
    - Nothing reaches the customer: no confirmation, no reminder, no notice when staff move or cancel a booking.
    - No cancellation policy: the AI moved a booking 20 minutes before it started and cancelled one 10 minutes before.
    - Staff are alerted to bookings and cancellations, not to reschedules.
    - The customer's timezone is never recorded, so times are only given in the calendar's timezone.
    - A claimed email (one that belongs to another customer) is shown to the AI but not stored on the visitor, so a
      sender must use only stored addresses.
  - **Also found:** the email sender can't attach a calendar file or set a reply-to, and has no timeout or idempotency
    key. No real email provider is set up locally (the log provider is used). Only the web chat, playground and API
    channels exist, so reminders can only be emails for now.
  - **Proposed:**
    - confirmation, update and cancellation emails with a calendar file, and reminders (1 day before by default),
      switchable per calendar
    - a database log of every email, sent by a worker with leases and idempotency keys, only to stored addresses
    - truthful email reporting by the AI
    - a cancellation policy per calendar, with the team offered inside the window
    - the customer's timezone from the widget, the AI or staff, with both times shown
    - a staff alert for reschedules, and "Resend confirmation"
- **2026-09-28 — Phase 9 implemented and verified** (as approved, one phase).
  - **Emails to the customer, per calendar (on by default):** a confirmation with a calendar file when a booking is
    made (by the AI, staff or the API), a change notice when it moves, a cancellation notice, and reminders (1 day
    before by default, or 1 day and 2 hours). A day-based reminder keeps the local time across a daylight-saving
    change. The emails show the location, the calendar's instructions, the change policy, and the customer's own time
    when their timezone differs. They come from the business's name, and replies go to the calendar's reply-to address.
  - **Safe sending:** every email is a row in `appointment_notifications`, written in the booking's own transaction and
    sent by a worker (right after the change, and every minute for reminders). Rows are claimed with a lease, every
    email carries its row ID as the idempotency key (retries send identical bytes), and each is re-checked before
    sending. A reminder for a moved, cancelled, completed or no-show booking is dropped.
  - **Only the right person:** only the email stored on the contact is used, never a claimed one under review, and
    playground contacts are never emailed. Every skip is logged with its reason. After a staff merge the booking's
    emails follow the surviving contact.
  - **Failures:** retried after 1, 5, 15 and 60 minutes, then logged as failed with an in-app alert for staff. An
    address the provider refuses isn't retried.
  - **The AI tells the truth:** `book_appointment` reports `customer_confirmation_sent: true` and the address only when
    one is on its way; otherwise false with the reason. Change and cancellation results do the same.
  - **Cancellation policy per calendar:** "any time" by default, or until 2, 12, 24 or 48 hours before. Inside the
    window the AI can't move or cancel the booking and offers the team (`transfer_to_human`); nothing can be changed by
    the AI after the start. Staff and the API can always change a booking.
  - **Customer timezone:** from the widget (the browser's), the integration API, staff, or the AI when the customer says
    where they are. Tool results, the context and the emails show both times when it differs from the calendar's.
  - **Staff:** an alert when a booking moves; each appointment's email log with "Resend confirmation"; an "Email the
    customer" checkbox when booking, moving or cancelling; the calendar's email and policy settings; the contact's
    timezone.
- **2026-09-28 — Feature track: audit and order.** Nine features audited against the code (baseline 150/150 tests).
  The per-feature findings are in `docs/IMPLEMENTATION_PLAN.md` → Feature track audit.
  - **Order (approved):** F1 Bot Personality → F2 Conversation Context → F3 Conversation Summary → F4 CRM Integration
    (with deals/opportunities and the API-channel delivery fix) → F5 AI Actions → F6 Human Handoff → F7 Chat Widget →
    F8 Follow-ups → F9 Analytics, then Phase 4.
  - **Most important finding:** customers on the integration API never receive staff replies or the server's
    follow-up messages, such as the marketing opt-in question. Integrations only get the AI's first reply (fixed in
    F4).
- **2026-09-28 — F1 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → F1.
  - **Mostly built already:** persona, 12,000-character instructions, business facts, guardrails, prompt preview,
    playground.
  - **Gaps:** no goals of the business's own; tone only from a menu of five; no starting points; bots created in
    the dashboard have no company name, so the prompt says "the business".
  - **Proposed:**
    - goals and a personality in the business's own words
    - four starting templates
    - the organization's name as the company-name fallback
    - no migration, and no prompt change for bots that don't use the new settings
- **2026-09-28 — F1 (Phase 10) implemented and verified** (as approved).
  - **Goals:** a main goal and up to 5 more, in a new Goals tab after Persona. They come first in the prompt's goals,
    ahead of the built-in ones, followed by one line: work towards them when it helps the customer, answer first,
    never pressure or repeat a declined offer.
  - **Personality in the business's own words** (up to 600 characters), shown under the tone.
  - **Four starting templates** in the Persona tab (Receptionist, Sales assistant, Support agent, Booking
    coordinator). They fill the role, tone, reply length, personality and main goal, ask first when a personality or
    main goal is already written, and save only on Save.
  - **Company name fallback:** an empty company name means the organization's name in the prompt, the prompt
    preview and the widget header; the editor shows it as the placeholder.
  - **No change for other bots:** a snapshot of the demo bot's prompt, taken before the change, still matches.
- **2026-09-28 — F2 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → F2.
  - **Already in place:** the Phase 5 history and memory, labelled staff replies, and a per-turn context with the
    contact, qualification, upcoming appointments, earlier actions and knowledge.
  - **Reproduced for free:**
    - the widget's greeting never reaches the model, so "yes please!" to "Want 20% off teeth whitening?" arrives
      alone
    - the page the visitor is on is stored but unused
    - staff notes never reach the model, and staff can't add to or correct what the AI remembers (read-only card,
      no API)
    - the lifecycle stage and past appointments aren't in the context
  - **Proposed:**
    - the greeting note and the page
    - team facts that staff add or remove, and notes shared per note
    - the stage and the last 3 past appointments
    - one system-prompt line (the F1 snapshot updated on purpose)
    - no migration
- **2026-09-28 — F2 (Phase 11) implemented and verified** (as approved).
  - **The greeting:** in web-chat and playground conversations, the first turn starts with a note of the greeting the
    visitor saw, so "yes please!" arrives with its subject. The note stays until the first message is folded into
    the summary. One rule picks the greeting for the widget, the AI and the playground: the widget's own, else the
    bot's, else "Hi! How can I help?".
  - **The page:** the page of the customer's latest message (stored without other query parameters since Phase 6)
    is in the context. API conversations have none.
  - **Team notes:**
    - staff (agent and up) and API keys with `contacts:write` can add a fact to what the AI remembers and remove any
      fact, on the contact page or through the API
    - when staff add a note, a checkbox (off by default) shares it with the assistant as a team fact; other notes
      stay internal
    - team facts come first, marked "(noted by the team)", then the AI's own: up to 15 per turn (was 10)
    - facts saved before this phase get a stable ID from their text and time, so they can be removed too (no
      migration)
  - **Standing and history:** the lifecycle stage, and the last 3 past appointments from the past 12 months with
    their outcome (completed, no-show, cancelled), whether or not booking is on.
  - **One system-prompt line:** notes from the team are more reliable than the AI's own; use them, the page and the
    recent appointments to understand what the customer means and pick up where things left off, without pointing
    out what it can see. The demo bot's prompt snapshot changed by exactly that line.
- **2026-09-28 — F3 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → F3.
  - **Already in place (Phase 5):** a summary per conversation, rewritten after 30 minutes of quiet and on close,
    folded for long chats, used as the AI's memory, and shown above the thread and on the contact page.
  - **Reproduced for free:**
    - after the AI hands off a 3-message chat, or staff take over, there's no summary and none is queued
    - closing sends `conversation.closed` without the summary, no event ever carries it, and API keys can't read
      conversations (401)
    - one paragraph with no parts (intent, outcome, next step, mood), no time, no refresh and no set language
    - found on the way: the widget's live stream passes the handoff reason to the visitor's browser (not shown)
  - **Proposed:**
    - recaps with parts, stored in one new column (a small migration), with the AI's memory unchanged
    - a recap at every handoff and on demand (Refresh)
    - a `conversation.summarized` webhook
    - a summary bar on the conversation page, and lines on the contact page
    - the widget stream limited to what the widget uses
- **2026-09-28 — F3 (Phase 12) implemented and verified** (as approved).
  - **Recaps with parts:** every recap (after a quiet spell, on close, at handoff, on request) asks for a JSON answer:
    the summary text as before, plus what the customer wants, the outcome, the next step and their mood. The model
    also sees the conversation's status and handoff reason. The summary text stays the AI's memory, so the reply
    prompt is unchanged (the demo bot's snapshot still matches). A plain-text answer is kept as the summary without
    parts; a JSON answer without a summary saves nothing. Folds of long chats keep their Phase 5 prompt and never
    touch the parts.
  - **Storage:** the parts, when and why the recap was written, and the last message it covers, in
    `conversations.summary_details` (migration `0008`, one nullable column, no backfill).
  - **Fresh when it matters:** a recap is queued straight away whenever a conversation moves to "needs a human" (the
    AI handing off for any reason, or staff taking over, including by replying), and agents can ask for one with
    Refresh (`POST /v1/conversations/:id/summary`), which says why when there's nothing to do.
  - **Language:** English, or the bot's language when it has a fixed one.
  - **Integrations:** a `conversation.summarized` webhook for every recap (23 event types), with the summary, its
    parts, the trigger and the status. Test conversations never go out.
  - **Staff:** a summary bar under the conversation's header (what the customer wants and the next step, opening to
    the outcome, mood, when and why, "N new messages since", the full summary and Refresh), updated live; each
    conversation on the contact page shows what the customer wanted and the outcome; activity and timeline read
    "Summary updated (at handoff): …".
  - **Widget stream:** passes only the widget's own events, without the handoff reason or staff-only events.
- **2026-09-28 — F4 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → F4.
  - **Already in place:** contacts with tags, custom fields, notes, tasks, consents and appointments; 23 signed
    webhook events; n8n workflows; API keys with 4 scopes that reach contacts and the chat API.
  - **Reproduced for free:**
    - a chat-API customer never gets the opt-in question sent after the AI's reply, or a staff reply: no event
      carries them, and API keys can't read conversations (401)
    - even with every scope, API keys get 401 on tags, notes, tasks, custom-field definitions, calendars,
      availability, appointments and conversations
    - no deals or pipelines (404)
    - the dashboard never shows or changes a contact's owner
  - **Proposed:** two steps in hook phase 13, with a check-in between.
    - F4a (no migration): a `message.outbound` webhook, every turn message on the waiting request and a polling
      endpoint; new scopes for conversations and appointments; notes, tasks, tags and field definitions for keys;
      editable key scopes
    - F4b (one migration): pipelines and deals with an API, 6 events and a Deals board; the contact's Deals tab and
      owner; currency
- **2026-09-28 — F4a (Phase 13, first step) implemented and verified** (as approved).
  - **Messages to chat-API customers:**
    - every message sent to one (AI replies, follow-ups such as the opt-in question, handoff messages, staff replies)
      goes out as a signed `message.outbound` webhook with the customer's `externalUserId`, recorded with the message
      itself
    - the waiting request returns every message of the turn as `replies` (`reply` stays the first), and returns at
      once on a handoff
    - `GET /v1/channels/api/messages?externalUserId=&after=` for integrations that poll
  - **API access:** new scopes `conversations:read`, `appointments:read` and `appointments:write`. The contact scopes
    now also cover tags, notes, tasks and custom-field definitions (reading only for the definitions). Admins can
    rename a key or change its scopes without replacing it.
  - **Dashboard:** the 7 scopes with descriptions in Settings → API keys, and an Edit dialog for a key's name and
    scopes.
- **2026-09-28 — F4b (Phase 13, second step) implemented and verified; F4 complete** (as approved).
  - **Pipelines:** every organization has a "Sales" pipeline (New, Qualified, Proposal, Negotiation): new ones from
    sign-up, older ones on first use (once, even under concurrent first uses). Admins add pipelines and rename,
    reorder, add and remove stages. A stage with deals says where they go; the last pipeline, or one with deals, can't
    be deleted.
  - **Deals:** a title, a contact, pipeline and stage, value and currency, owner, expected close date, open, won or
    lost (with a reason), the conversation it came from, and who created it (team or integration). Winning or losing
    records when; reopening clears it.
  - **Currency:** an organization setting (ISO 4217, default USD) that new deals use.
  - **Events:** `deal.created`, `deal.updated` (with the changed fields), `deal.stage_changed` (from and to),
    `deal.won`, `deal.lost` (with the reason), `deal.deleted`: for webhooks and the activity feed (30 event types).
  - **Contacts:** merging moves deals; deleting a contact deletes them. A contact's owner, like a deal's, must be a
    team member.
  - **API:** pipelines and deals with scopes `deals:read` and `deals:write`; a per-stage summary for the board.
  - **Dashboard:**
    - a Deals page (in the navigation after Leads): the pipeline as a board with each stage's count and total, filters
      for status and owner, and "Load more" per stage
    - a drawer to create or edit a deal, move it, mark it won or lost, reopen or delete it
    - a pipeline editor and "New pipeline"
    - a Deals tab and the owner on the contact page; "Create deal" in a conversation (linked to it, titled from its
      summary)
    - the currency in Settings, and the deal scopes for API keys
- **2026-09-28 — F5 explore, audit and plan.** Details are in `docs/IMPLEMENTATION_PLAN.md` → F5.
  - **Already in place:** 16 tools with per-bot limits (tools, tags, workflows); every call validated, logged, on
    the timeline, and never repeated on retries.
  - **Reproduced for free:**
    - a default bot has 7 tools and none for lifecycle stage, owner, removing tags or deals
    - a web-chat visitor got another person's order and address from a lookup workflow: the model passed the email
      the visitor typed, and nothing told the workflow that the email wasn't the visitor's own
    - every action runs at once; there's no approval step
  - **Proposed:** two steps in hook phase 14, with a check-in between.
    - F5a (one small column): 5 CRM actions, each off until turned on per bot; deals and the owner in the context;
      workflow inputs bound to the contact record, where each value came from in every call, and an "Identified
      customers only" switch
    - F5b (one table): "Ask the team first" per action and per workflow, with approve or reject on the conversation
      page
- **2026-09-28 — F5a (Phase 14, first step) implemented and verified** (as approved).
  - **CRM actions**, each off until a business turns it on for a bot (Bot → Actions → CRM actions):
    - `set_lifecycle_stage`: to one of the stages the bot may set (only those the organization still has)
    - `assign_owner`: to one of the team members the bot may assign; the model sees their names (never emails) and
      the contact's current owner
    - `remove_tags`: tags from the bot's allowed list; with no list, only tags the assistant added itself
    - `create_deal` and `update_deal` in the bot's pipeline, for this customer only: one open deal per customer (a
      second create returns the open one); stage, value and expected close date; won or lost only with "May mark deals
      won or lost"
    - the turn's context lists the customer's open deals (up to 3, with IDs) and the owner, only for bots with those
      actions; the prompt gets a "Keeping the CRM up to date" section only for the actions a bot has, so other bots
      keep exactly the same prompt
    - every change is on the conversation's timeline (the tool call and its event, e.g. "Lifecycle stage set to
      “customer”"), with the AI as the actor
  - **Safe workflows:**
    - an input can take its value from the contact record (email, phone, name or contact ID) instead of the chat: the
      server fills it, whatever the model passes, and a missing required value refuses the call ("ask for it and save
      it first")
    - every call says where values came from: `record`, and `trust` (identity: integration, unverified or staff; the
      channel; which inputs came from the chat and which from the record)
    - a per-workflow "Identified customers only" switch refuses web-chat visitors (the assistant offers the team
      instead) and runs for chat-API customers; it's off for existing workflows
    - the workflow editor: each input's source (a record value is always text), the switch, and a warning for
      request/response workflows that take an email, phone or account from the chat
  - **Deals board:** test (playground) contacts' deals are left out of the board and its totals, like test
    conversations and contacts; they still show on the test contact's page.
  - **Bot editor:** a stage, member or pipeline that no longer exists stays visible under CRM actions ("no longer a
    stage", "A former team member", "A deleted pipeline") so it can be cleared.
- **2026-09-29 — After the F5a check-in** (as asked: re-check, fix "unknown", then F5b).
  - **Real-model re-check** of the direct CRM wording (see Tests / verification): better; two follow-ups:
    - a second `create_deal` for a customer with an open deal is refused (an error the model acts on), with the deal's
      ID and "call update_deal" (before, it succeeded quietly and the value the customer gave was lost)
    - the "Keeping the CRM up to date" section says these records are internal: no talk of deals, stages or tags to
      the customer
  - **Placeholder details** (lead capture): values such as "unknown", "N/A", "none" or "(not given yet)" are never
    saved as a name, email, phone or company, from the AI or an integration; the AI is told why. The context now shows
    missing details as "(not given yet)" instead of "unknown", which the model had copied.
- **2026-09-29 — F5b (Phase 14, second step) implemented and verified; F5 complete** (as approved).
  - **Ask the team first**, per bot for any of 9 actions (bookings: book, move, cancel; add and remove tags; lifecycle
    stage; owner; create and update deals), and per workflow. Off until set, so nothing changes for existing bots.
  - **When the assistant calls such an action:** the validated request is saved (what, for whom, which conversation, a
    summary in words); nothing happens yet; the model is told it's waiting and to tell the customer a team member will
    confirm; the team gets a notification linking to the conversation. The same request asked again while it waits,
    or a retried turn, doesn't make a second one.
  - **The team (agent and up):** requests show on the conversation page and on a new Approvals page (with a count in
    the navigation), each with Approve or Decline (with an optional reason) and an optional message to the customer
    that doesn't take the conversation over. Approve runs the action once, exactly as asked, with the bot's settings
    and the conversation as they are now; if it can't go through now (switched off, no longer fits, slot taken) it
    stays waiting. A request nobody answers expires after 7 days.
  - **Afterwards:** the assistant's next turn sees each request and its answer (waiting, approved, declined with the
    reason, or expired). Events `action.approval_requested`, `action.approved` and `action.rejected` go to webhooks and
    the activity feed; the timeline shows the request ("asked the team") and the decision.
  - **Workflows:** a workflow that asks first also admits web-chat visitors when it's "Identified customers only" (the
    person approving checks who is asking); the call tells the workflow who approved it (`trust.approvedBy`).
- **2026-09-29 — Website chat: embed address and draggable bubble** (audited, then approved: both changes, dragging
  only while the chat is closed).
  - **Embed address:** the embed code showed `http://localhost:4000` in production because `PUBLIC_API_URL` defaulted
    to it. It's now optional: unset, the embed code uses the address the request reached the API at (proxy-aware), so
    it's right locally, on staging and in production with no setup; set it only for a custom domain (a trailing `/`
    is trimmed). Production logs a warning if it's set to localhost.
  - **Draggable bubble** (Settings → Website chat → Appearance, off by default):
    - visitors drag the bubble anywhere, all four corners included, with a mouse, a finger or a pen, while the chat is
      closed; a small movement (6px, 10px for touch) still counts as a click, and the click that ends a drag doesn't
      open the chat
    - the spot is remembered in the visitor's browser relative to the screen, so a corner stays a corner after
      resizing or rotating; it's ignored if the business changes Position or turns dragging off
    - the chat window opens where there's room (below a bubble in the top half, shifted to stay on screen); on phones
      the open chat stays full screen
    - with dragging off, the widget looks and behaves exactly as before
- **2026-09-29 — Website chat: "Powered by" line and the visitor's IP address** (audited, then approved: IP on the
  conversation, a `TRUST_PROXY` setting, plain text, none for playground chats).
  - **Footer:** under the message box, centred on two lines: "Powered by LeadsMagnet AI" and "Chats are recorded so
    our team can assist you." (11px, the widget's muted colour, plain text; 8px below the box, 10px above the bottom
    edge). Nothing else in the widget changed.
  - **Visitor IP:** taken server-side from `req.ip` (never from anything the visitor sends), cleaned up
    (`::ffff:1.2.3.4` → `1.2.3.4`; anything that isn't an IP is skipped), and kept on the conversation as
    `metadata.visitorIp` and `visitorIpAt`:
    - a new visitor's first message sets it on the conversation it starts (opening the chat creates nothing)
    - a returning visitor's new session updates it only if it changed
    - playground chats record none (it would be the team member's address)
    - it stays out of message records, the AI's input, the widget's responses and webhooks; staff see it on the
      conversation page's Details panel ("IP address", with when it was last seen on hover; only when there is one)
      and in `GET /v1/conversations/:id`
  - **`TRUST_PROXY`:** which proxies to believe about the client's address: `true` (default, as before), `false`, or
    the proxies' addresses and ranges (e.g. `uniquelocal`). Fastify ignores a number of hops (it can't tell a proxy
    from a visitor), so a number is refused at startup. A debug-level log of the forwarded addresses at session start
    helps find the right value.
- **2026-09-29 — Website chat: the bubble no longer jumps on load** (root cause reported first, then approved).
  - **Cause:** the widget was added to the page at the default spot (bottom right) straight away, and its settings
    (side, dragging, the saved spot) were applied only when they arrived from the API, so the frames drawn meanwhile
    showed the bubble on the right before it jumped to the saved spot.
  - **Fix:** the widget stays hidden until its settings are applied, then appears in the same step, so its first
    visible frame is its final look and place. No timers or delays. A chat restored open is focused once it's shown.
    An unknown or disabled key still never shows it, as before.
- **2026-09-29 — Conversation starters** (audited, then approved: "send message" and "talk to the team" actions,
  shown under the greeting until the visitor's first message, and in the Playground too).
  - **Configuration:** a new "Conversation starters" tab in the bot editor (a `conversationStarters` section of the
    bot's configuration: no new table or migration; bots saved before it have none). Admins add, edit, delete,
    show or hide, and move starters up or down; an empty bot offers four editable suggestions (book, reschedule,
    cancel, talk to the team). Each starter: button text (1–60 characters, one line), the message a click sends
    (empty = the button text, up to 500), what a click does, shown or hidden, and its position. Up to 10 per bot;
    the same text twice is refused (ignoring case), and so is a shown "talk to the team" starter while Human handoff
    is off. Mistakes show on the field and on the tab.
  - **Website chat:** the enabled starters come with the widget's settings and appear as buttons under the greeting,
    only in a fresh chat; the visitor's first message (clicked or typed) removes them. Another tab opened before
    that message keeps its starters until reloaded (a click there adds its message to the same chat). A click
    sends the starter's message as the visitor's own: "send message" starters are answered by the AI with its usual
    tools (booking, rescheduling, cancelling); "talk to the team" hands the chat to the team straight away, like a
    handoff keyword, without asking the AI. The server checks the clicked starter against the bot's current ones: a
    deleted, hidden or other bot's starter is just a message.
  - **Double clicks and failures:** all starters are unclickable while a message is sending; a retry after a failed
    send reuses the same message id, so the server keeps one message even if the first try got through. A failed
    starter message is taken back off the screen and the starters come back.
  - **Mobile and accessibility:** buttons wrap in the phone's full-screen chat and are 44px tall for fingers; they're
    real buttons in a "Suggested questions" group, reachable with Tab, with a visible focus ring; pressed with the keyboard,
    focus moves on to the message box (a tap doesn't pop up a phone's keyboard). Light and dark mode use the widget's
    colours.
  - **Fixed on the way:** a chat restored open could miss its greeting when its session came back before the widget's
    settings; the greeting and starters now wait for both.
  - **Playground:** shows the saved starters under the greeting and sends them like the widget does.
- **2026-09-29 — Website chat redesign** (from the approved design canvas; choices: light header, "LeadsMagnet AI",
  starters styled as the design's suggested questions). Looks only: `apps/widget/src/widget.ts` (its styles and the
  DOM it builds); behaviour, APIs, drag and placement are unchanged, with the window still 380×640 and the bubble 56px.
  - **Look:** the design's neutral light and dark colours, with the bot's colour (Settings → Website chat) as the only
    accent and its tints mixed from it; a light header with the logo (or initials), an online dot, an "AI" label and a
    chevron to minimize; messages in rows with a small picture and "Maya · 2:14 PM" underneath; the visitor's in the
    bot's colour; the team's with a person icon, a "Team member" label and an outlined bubble; sources as chips; a
    "Today" label over loaded history; a typing bubble with what the assistant is doing; a handoff divider; a red
    error banner above a rounded message box with a focus ring, "Write a message…" and an arrow button; the footer
    "Chats are recorded…" then "Powered by LeadsMagnet AI".
  - **Bubble:** a new chat icon that turns into a chevron while the chat is open (pointing up when the window opens
    below it); a keyboard focus ring; a "Drag to move" tip on hover while it's at its corner; a ring while dragged.
    The window scales in from the bubble when the visitor opens it (not for a chat restored on page load, nor with
    reduced motion).
  - **Phone:** the design's larger sizes: 44px targets, 16px message text (so iPhones don't zoom), room for the home bar.
  - **Kept from the design only in part:** the greeting shows the time it appeared (not a permanent "Just now"); a
    draggable bubble neither lifts on hover nor grows while dragged (either would shift where a drag starts); the
    typing bubble stays under the chat as before; the "Drag to move" tip stops once the bubble has been moved.
- **2026-09-29 — Settings preview matches the redesign** (on request). The preview in Settings → Website chat is now a
  small copy of the new widget: light header with the avatar (or initials) and online dot, the "AI" label and the
  subtitle the widget would show, the greeting with its picture and "Maya · Just now", the selected bot's enabled
  starters (up to 3, "+N more"; a sample visitor message when there are none), the message box, the new footer, and
  the bubble with its chevron (and launcher text). It follows every field as you type (colour, position, title,
  subtitle, avatar, launcher text, bot) and the dashboard's light or dark mode, like the widget follows the visitor's.
- **2026-09-30 — Bot editor redesign, Phase 1: layout** (design canvas "Bot Editor Redesign", concept A plus B's
  overview; choices: an Active / Paused pill, and Booking counts as essential only when there's a calendar). Dashboard
  only; saving, validation, permissions, the sections' fields and the test chat work as before.
  - **Grouped menu instead of 13 tabs:** Overview; Personality (Identity & voice, Goals, Instructions); What {name}
    knows (Business info, Knowledge bases); Conversations (Conversation starters, Lead capture, Qualification,
    Booking, Handoff); Rules & tools (Guardrails, Actions, Model). Each item shows On/Off, a count (starters shown,
    knowledge bases) or Default/Custom for the model, plus the unsaved and needs-fixing markers. `?tab=` still names
    the open section with the same values as before, so older links work; no `tab` opens the overview.
  - **Overview:** "X of 6 set up" (5 without a calendar) with a card per essential (Identity & voice, What it knows,
    Conversation starters, Lead capture, Booking, Handoff), each Done or To do with a summary written from the
    settings, the next step as the main button, "Get the website code", and a "More settings" list.
  - **Header:** the bot's initial, its name (still editable, now sized to the text), version, an Active / Paused pill
    (same setting, saved with Save), "All changes saved" / "Unsaved changes", Prompt preview, Test chat (renamed from
    Playground) and Save.
  - **Saving:** a bar at the bottom while there are changes (what changed, Discard, Save). A refused save lists each
    problem with its section and a "Go to it" link.
  - **Search:** a search box at the top of the menu and Cmd/Ctrl+K find sections by name or by what's in them
    (greeting, calendar, handoff message…); arrows, Enter and Esc work; not while another dialog is open.
  - **Main menu:** icons only on a bot's editor (names kept for screen readers, tooltips on hover), with a button to
    expand it that this browser remembers; every other page keeps the full menu. (Replaced the same day by one
    collapse setting for every page: see "Main menu collapses on every page" below.)
- **2026-09-30 — Bot editor redesign, Phase 2: test chat** (as approved). The test chat is drawn like the website
  chat; it uses the same endpoints, session, live updates and "What the AI did" data as before.
  - **The chat:** a card with the business's initials and online dot, its name (from the saved bot, else the
    organization), the "AI" label and "{assistant} · usually replies instantly"; the greeting with its picture and
    time; starters as the widget's suggested questions until the first message; the visitor's messages on the right
    in the accent colour, the assistant's with its picture and "{name} · time", a team member's with a person icon
    and "Team member"; sources as chips; typing dots with what the AI is doing; the handoff note as a divider; the
    widget's message box (grows with the text, Enter sends) and footer.
  - **Kept above the chat:** "Test chat", the conversation's status, the live dot, the unsaved-changes note and Reset.
  - **"What the AI did":** a card under the chat, closed by default, showing "N tool calls · N events" (or "Send a
    message to see it"); open, it lists the same timeline with "Open in Conversations →" and takes at most 40% of
    the panel, so the message box stays in view.
  - **Shared:** the initials helper moved from Settings into `lib/format.ts` (Settings' preview is unchanged).
- **2026-09-30 — Bot editor redesign, Phase 3: friendlier sections** (as approved). Same settings, values, checks and
  saving; only how they're laid out and worded changed.
  - **Every section:** a heading with its group, name and a plain one-line purpose (using the assistant's name), then
    cards of related settings, each with its own heading and help text. On narrow screens a card's fields stack.
  - **Identity & voice, as drawn:** a summary card (initial, name, "Role at Company", chips for tone, reply length,
    language and emoji) with "Use a template" as a menu of the four templates (it still asks before replacing text);
    Identity (name, company, role); Voice (tone as pills, reply length as three choices, language, emoji,
    personality); Greeting, with a live preview of the greeting bubble as the website chat shows it.
  - **Switchable features** (lead capture, qualification, booking, handoff): the switch sits in the first card's
    header with a line on what it does now ("On · Asks for name and phone; email… are optional", "Off · Leads aren't
    scored"). The settings under it stay editable when it's off, as before.
  - **Search finds single settings:** 55 of them ("greeting", "calendar", "tone"…). Picking one opens its section,
    scrolls to it, puts the cursor in it and highlights it briefly. With nothing typed it lists the sections as before.
  - **Narrow layouts:** starter and question forms stack on a narrow card; the lead-capture table scrolls sideways on
    its own instead of widening the page.
  - **Kept from the design only in part:** Language stays a text box with suggestions (the drawing had a drop-down),
    so any language name or code still works.
- **2026-09-30 — Main menu collapses on every page** (on request; option chosen: one setting everywhere, starting
  expanded). The Collapse / Expand button at the bottom of the main menu is on every page, and the choice applies to
  every page and survives a reload (remembered in this browser). The bot editor no longer shrinks the menu by itself;
  it follows the same setting. The collapsed look is unchanged (icons with tooltips, names for screen readers, the
  approvals dot). One place, the shared layout; no page has its own copy.

## Remaining issues

| Issue | Severity | Planned in |
|---|---|---|
| ~~Anonymous visitor merged into an existing contact on an unverified email/phone~~ | P0 | ✅ Fixed in Phase 1 |
| A genuine returning customer isn't linked until staff merge them (accepted trade-off; verification codes could auto-approve later) | P3 | Not planned yet |
| Dashboard duplicate-review banner not checked in a browser (skipped by decision; the API flow behind it is tested) | Test gap | Next time the dashboard is previewed |
| README still says 71 tests (now 238) | Docs | Not planned |
| The widget shows the browser's raw error ("Failed to fetch") when a message can't be sent over the network (found while testing starters; typed messages did this before) | P3 | Not planned |
| A second tab opened before the visitor's first message keeps showing the conversation starters until it's reloaded (a click there adds its message to the same chat) | P3 | Not planned |
| At 1024px wide, a knowledge base's documents table doesn't shrink, so the page scrolls sideways (198px with the menu expanded, 38px collapsed; found while checking the menu change, not caused by it) | P3 | Not planned |
| ~~`book_appointment` can return a cancelled or moved appointment as booked~~ | P0 | ✅ Fixed in Phase 2 |
| ~~The AI is told a confirmation was sent when none is~~ | P0 | ✅ Fixed in Phase 2 |
| ~~Buffers and the daily cap can break when two bookings happen at once~~ | P1 | ✅ Fixed in Phase 2 (verified by review only; see next row) |
| The calendar lock can only be proven under real concurrency on Postgres: PGlite runs one transaction at a time, and this machine has no Postgres | Test gap | When CI has Postgres |
| ~~Cancelling twice reports a failure; rescheduling to the same time records another event~~ | P2 | ✅ Fixed in Phase 2 |
| `appointments.idempotency_key` is no longer written or read (the column is kept; old rows keep their values) | P3 | Drop in a later migration if wanted |
| ~~Staff aren't notified when an appointment is rescheduled (no notification for `appointment.rescheduled`)~~ | P3 | ✅ Fixed in Phase 9 |
| ~~Retried AI turns repeat side effects~~ | P1 | ✅ Fixed in Phase 3 |
| ~~The conversation lock can expire mid-reply~~ | P1 | ✅ Fixed in Phase 3 (renewal tested against a fake Redis only; see next row) |
| Lock renewal hasn't run against a real Redis (none on this machine) | Test gap | When CI or staging has Redis |
| ~~Turns have no overall time limit; customers can wait minutes~~ | P1 | ✅ Fixed in Phase 3 |
| If the lock is lost on a reply's last attempt, the customer's message goes unanswered until they write again (the reply can't safely apologize without the lock) | P3 | Accepted; needs a Redis failure to happen |
| The model has never been evaluated on this bot | P1 | Phase 4 (deferred until after F9) |
| ~~Earlier tool results aren't in the model's history: a slot accepted in a later message must be rebuilt from the bot's wording~~ | P2 | ✅ Fixed in Phase 5 (offered slots and actions are listed each turn) |
| The Anthropic provider has never run (no tests), so don't switch to Anthropic before Phase 4 | P2 | Phase 4 (deferred) |
| Setting an effort with Claude Haiku 4.5 would fail every reply (it doesn't accept one) | P3 | Phase 4 (deferred) |
| Claude Haiku 4.5 probably can't cache our prompt (prefix ~3.5K tokens; minimum 4,096) | Cost | Phase 4 (deferred) |
| Test runs leave `apps/server/.data/test-uploads-<pid>` folders behind | Hygiene | Not planned |
| ~~`handoff.notifyTeam` is never read~~ | P2 | ✅ Fixed in Phase 3 |
| ~~The summary throttle doesn't work with BullMQ: after 30 messages a summary is written about every 2 exchanges~~ | P2 | ✅ Fixed in Phase 5 |
| ~~No summary until 30 messages: between messages 21 and 30 the start of a conversation is in neither the history nor a summary~~ | P2 | ✅ Fixed in Phase 5 |
| ~~Nothing is remembered across conversations~~ | P2 | ✅ Fixed in Phase 5 |
| ~~Summary jobs ignore the organization's AI switch and monthly budget~~ | P2 | ✅ Fixed in Phase 5 |
| ~~Summaries and memory reach the model unlabelled; the summary tag isn't escaped~~ | P2 | ✅ Fixed in Phase 5 |
| ~~The model can't see time gaps~~ | P3 | ✅ Fixed in Phase 5 |
| ~~Knowledge search runs for "hi" and "thanks"~~ | P3 | ✅ Fixed in Phase 5 |
| Nothing closes idle conversations (staff or merges only) | P3 | Not planned (Phase 5 recaps work without closing) |
| ~~Only the first channel is recorded as a lead's source~~ | P2 | ✅ Fixed in Phase 6 |
| ~~Stored page URLs keep the full query string~~ (new ones are trimmed; older stored messages keep theirs) | P2 | ✅ Fixed in Phase 6 |
| ~~No consent is recorded~~ | P2 | ✅ Fixed in Phase 6 (marketing opt-in with proof) |
| ~~Contacts created by staff are labelled with source `api`~~ (older contacts keep the label) | P3 | ✅ Fixed in Phase 6 |
| ~~No ready-made business-detail fields~~ | P3 | ✅ Fixed in Phase 6 |
| The opt-in flow hasn't been tried with the real model (the fake model plays the tool calls in the tests) | Test gap | Phase 4 (deferred) |
| Messages stored before Phase 6 keep full page URLs (only new ones are trimmed) | P3 | Not planned (a one-off cleanup could trim them) |
| ~~A disqualified lead stays disqualified even after answering so they qualify~~ | P2 | ✅ Fixed in Phase 7 |
| ~~Stored answers aren't checked against the current questions~~ | P2 | ✅ Fixed in Phase 7 |
| ~~The prompt shows answers to other bots' questions; qualification events don't say which bot asked~~ | P3 | ✅ Fixed in Phase 7 |
| Bots whose questions share a key and compatible options share that answer (no per-bot records, by decision); the bot editor warns when they differ | P3 | Accepted (per-bot storage only if a customer needs it) |
| The contact page's "asked by / doesn't fit" labels and the editor warning haven't been checked in a browser (covered by the typecheck) | Test gap | Next time the dashboard is previewed |
| ~~Keyword search is English-only (index and query), so non-English content gets English stemming and stopwords~~ | P2 | ✅ Fixed in Phase 8 (a language per knowledge base) |
| ~~Word splitting breaks Hindi and other Indic words into fragments, so keyword search can't match them~~ | P2 | ✅ Fixed in Phase 8 |
| ~~Website (URL) sources are fetched once and never refreshed, so price changes on the site don't reach the bot~~ | P2 | ✅ Fixed in Phase 8 (off / daily / weekly) |
| ~~Search quality has never been measured with the production (OpenAI) embeddings~~ | Test gap | ✅ Measured in Phase 8 (`npm run search-eval`) |
| ~~Changing a document's category didn't reach search: the chunks kept the old category~~ | P2 | ✅ Fixed in Phase 8 |
| Hindi has no stop-word list in Postgres (nor do Tamil, several other dictionaries and "Any language"), so common words like की, क्या, है match every Hindi chunk. In the production run, a Hindi question answered only by an English document dropped from rank 2 to 4 (cross-language MRR 0.61 → 0.53); it stays in the top 5, which the AI sees. Proposed fix: a short stop-word list for these languages | P3 | Not planned yet (your call) |
| Cross-language questions: with production embeddings the right document is first for 1 of 3 (all 3 in the top 5), before and after | P3 | Accepted (a reranker only if top-5 drops below 90%) |
| Pages whose text changes on every load (timestamps, rotating offers) are re-embedded at every refresh. The cost is tiny (about $0.001 a day for a 50-page crawl) | P3 | Accepted |
| The 10-minute refresh timer hasn't run in a deployed worker; the tests drive the refresh check directly, and the browser check used a manual re-ingest | Test gap | First deployment with a refreshed page |
| ~~Customers get no confirmation, reminder or change notice for their bookings~~ | P2 | ✅ Fixed in Phase 9 |
| ~~No cancellation policy: the AI can cancel or move a booking minutes before it starts~~ | P2 | ✅ Fixed in Phase 9 |
| ~~The customer's timezone is never recorded; times are only given in the calendar's timezone~~ | P3 | ✅ Fixed in Phase 9 |
| ~~The email sender has no timeout, attachments, reply-to or idempotency key~~ | P3 | ✅ Fixed in Phase 9 |
| No email has reached a real inbox: no Resend key or verified sending domain is set up (the log provider is used), and the Resend sender has no test against the real service | Setup | Before launch (skipped by decision) |
| How calendar apps (Gmail, Outlook, Apple) apply the change and cancellation calendar files hasn't been tried; the emails also state the change in words | Test gap | With the real-inbox check |
| Bookings made before Phase 9 get no reminders (no backfill); changing a calendar's reminders applies to bookings made or moved afterwards | P3 | Accepted |
| Email wording is English only (a calendar's instructions can be in any language) | P3 | Not planned yet |
| Bounces aren't tracked (Resend reports them by webhook) | P3 | Not planned yet |
| No links in the emails to change or cancel without chatting (needs a public page) | P3 | Not planned yet |
| SMS or WhatsApp reminders wait for those channels (integrations can use the `appointment.*` webhooks) | P3 | When the channels exist |
| The 1-minute email timer hasn't run in a deployed worker; the tests call the sender directly, and the browser check used the send that follows each booking | Test gap | First deployment |
| Recaps and memory haven't been tried with the real model (the fake model plays both roles in the tests) | Test gap | Phase 4 (deferred) |
| The recap line on the contact page hasn't been checked in a browser (covered by the typecheck) | Test gap | Next time the dashboard is previewed |
| With Redis, a failed fold job keeps its ID; the ID now includes a 10-message step so a failure can't block later folds. Verified by review only: the in-process test queue doesn't keep failed jobs | Test gap | When CI or staging has Redis |
| ~~Request/response workflows trust identity values the model passes as inputs: reproduced in the F5 audit (a web-chat visitor got another person's order and address)~~ | P2 | ✅ Fixed in F5a for workflows that use it (record-bound inputs, `trust` in every call, "Identified customers only") |
| Existing request/response workflows keep taking identity values from the chat until the business binds them to the record or turns on "Identified customers only" (the editor warns) | P3 | Accepted (by decision: off until set) |
| ~~In the real-model check, `gpt-4o-mini` used the new actions less than it should (missed the stage, owner and tag removal; opened the deal a message late)~~ | P2 | ✅ Mostly fixed after the check-in: with the direct wording the re-check set the stage, opened the deal on the first message and removed the tag (see the next rows) |
| `gpt-4o-mini` doesn't assign owners from the business's instructions: missed in both real-model checks (it tells the customer "Maya looks after implant patients" without assigning her). Rules for who gets which customer would make it reliable | P3 | F6 (Phase 15, with routing and assignment) |
| In the re-check the model called `create_deal` again instead of `update_deal`, so the $5,000 it heard wasn't recorded, and one reply mentioned "your open deal" to the customer. A repeat `create_deal` is now refused with the open deal's ID and a pointer to `update_deal`, and the prompt says these records are internal. Not tried with the real model | P3 | Next real-model run (F5b's check, or Phase 4) |
| ~~`save_contact_details` can save the context's placeholder as a name: in the real-model check the model copied `name: unknown` from the context and the contact was named "unknown"~~ (contacts already named that way keep the name) | P2 | ✅ Fixed after the F5a check-in |
| When SMS or WhatsApp arrive, their customers count as unverified for "Identified customers only" until decided otherwise | P3 | When those channels exist |
| Removing a stage, a member or a pipeline doesn't update the bots that list it: the editor shows it for clearing, and saving the bot (also through the API) is refused until it's cleared, as for unknown workflows | P3 | Accepted |
| Two conversations of one customer at the same moment could each open a deal (the one-open-deal check isn't locked); retried turns can't (they replay) | P3 | Accepted (rare) |
| ~~Every AI action runs at once: there's no way to have the team approve chosen actions first~~ | Feature | ✅ Fixed in F5b |
| An ask-first action that would change nothing (for example, the stage the customer already has) still asks the team | P3 | Not planned yet |
| After the team approves or declines, the assistant doesn't write to the customer by itself: the team's optional message is the reply, and the assistant knows the outcome on the customer's next message | P3 | Accepted (by design; F8 follow-ups could add one) |
| Whether the real model tells customers to wait for the team (and never claims it's done) hasn't been tried; the fake model plays it in the tests | Test gap | Next real-model run (or Phase 4) |
| Requests can be decided by staff only, not through the API | P3 | Not planned yet (an `approvals` API-key scope later if needed) |
| The draggable bubble can't be moved with the keyboard (it stays a normal button; its spot is only cosmetic) | P3 | Accepted |
| On Render, `TRUST_PROXY` is still the default (`true`), so a visitor can fake the IP stored on their conversation (and the widget's rate-limit key). Set it to the proxies in front of the API (Render's private network plus Cloudflare's published ranges) after checking the real forwarded addresses once with `LOG_LEVEL=debug` | P2 | Next deploy (needs your OK) |
| A visitor's IP address is personal data: the privacy policy may need to mention it; it's deleted with the conversation or contact | Privacy | Your call |
| Dragging with a real mouse was tried once in the browser check (the preview pane's scaling made aiming unreliable); the other checks drove the same code with pointer events | Test gap | Next time the widget is previewed |
| Web-chat visitors can't prove who they are (for example with a code by email), so "identified" means chat-API customers only | Feature | Not planned yet |
| No git baseline (Phase 0 skipped) | Process | Open |
| DECISIONS.md and ARCHITECTURE.md mention files that don't exist | Docs | Not planned (those docs are frozen) |
| ~~Customers on the integration API never receive staff replies or the server's follow-up messages (e.g. the marketing opt-in question): integrations only get the AI's first reply~~ | P1 | ✅ Fixed in F4a |
| ~~No deals/opportunities or pipelines~~ | Feature | ✅ Fixed in F4b |
| ~~API keys can't book, move or cancel appointments or read availability, and can't manage tags, notes, tasks or custom-field definitions~~ (definitions stay staff-only to change, by decision) | P3 | ✅ Fixed in F4a |
| ~~The dashboard never shows or changes a contact's owner (the API can set it)~~ | P3 | ✅ Fixed in F4b (the owner must now be a team member) |
| ~~The AI can't create, move or close deals~~ | Feature | ✅ Fixed in F5a (closing only with its switch) |
| Removing a stage at the very moment someone adds a deal to it fails with a server error (retrying works) | P3 | Accepted (rare; the database refuses the removal, so nothing is lost) |
| After a currency change, a stage with deals in both currencies shows one total per currency (existing deals keep theirs) | P3 | Accepted (by design) |
| Deals have no custom fields, products or forecasts | Feature | Not planned yet (F9 may add forecasts) |
| ~~Bots created in the dashboard have no company name, so the prompt says "the business"~~ | P3 | ✅ Fixed in F1 (the organization's name is the fallback) |
| How goals and the personality text change the real model's replies isn't measured (the tests check the prompt, not the model) | Test gap | Phase 4 (deferred until after F9) |
| ~~Notes staff add to a contact never reach the AI~~ (only notes shared with the assistant do, by decision) | P3 | ✅ Fixed in F2 |
| ~~The widget's greeting never reaches the model, so a reply to it ("yes please!") arrives without its subject~~ | P2 | ✅ Fixed in F2 |
| ~~The page the visitor is on is stored but never reaches the model~~ | P3 | ✅ Fixed in F2 |
| ~~Staff can't add to or correct what the AI remembers: a wrong fact stays and is sent every turn~~ | P3 | ✅ Fixed in F2 |
| ~~The lifecycle stage and past appointments aren't in the AI's context~~ | P3 | ✅ Fixed in F2 |
| The page in the context is whatever the widget reports; it isn't checked against the widget's allowed sites, so a visitor could send a made-up page (it only affects their own conversation) | P3 | Accepted |
| How the real model uses the greeting, page, team notes and past appointments isn't measured (the tests check what it's sent) | Test gap | Phase 4 (deferred until after F9) |
| ~~Summaries aren't refreshed at handoff, are unstructured, and never reach integrations~~ (API reads for integrations come with F4) | P3 | ✅ Fixed in F3 |
| ~~The widget's live stream passes every conversation event to the visitor's browser, including the handoff reason (the widget doesn't show it)~~ | P3 | ✅ Fixed in F3 |
| A customer's own messages can steer their summary's mood: in the real-model check, text telling the summarizer to set the mood to positive worked (it didn't copy the next step or claim anything was approved). The mood is only a hint, and only for that customer's conversation. Proposed fix: one prompt line, then a one-call re-check | P3 | F6 (Phase 15), before the mood is used for staff priorities |
| Bots set to "auto" language get English summaries; a team that works in another language would need a team-language setting | P3 | Accepted (decision) |
| The Refresh job ID (one per conversation per minute) hasn't run under BullMQ; a failed one only blocks that minute | Test gap | When CI or staging has Redis |
| ~~API keys can't read conversations, their messages or summaries~~ | P3 | ✅ Fixed in F4a |
| A waiting chat-API request waits its whole timeout (60 s by default) when no reply comes: the organization's AI is off, or a newer message took over the turn. The reply job ends without telling it. Found in the F4a review; it was already so before | P3 | Not planned yet |
| What an API key creates (notes, tasks, bookings) is recorded as the team's: the activity says "Team" and a booking "booked by team" | P3 | Not planned yet (F9 could label integrations) |
| A handed-off customer can wait forever (no timeout, fallback, team hours or assignment), and staff get no brief | P2 | F6 (Phase 15) |
| The widget's built-in text is English-only and can't be edited; the widget's greeting silently overrides the bot's | P3 | F7 (Phase 16) |
| No follow-ups for inactive leads | Feature | F8 (Phase 17) |
| Overview numbers are inaccurate: "qualified" counts contacts updated this month, "handed to humans" only those waiting now, and months are in UTC | P3 | F9 (Phase 18) |

## Files changed

- **2026-09-27 (planning):** created `docs/IMPLEMENTATION_PLAN.md` and `PROGRESS.md`.
- **Phase 1 (2026-09-27):**
  - Server:
    - `apps/server/src/db/schema/crm.ts`
    - `apps/server/drizzle/0004_merge_candidates.sql` (new), `apps/server/drizzle/meta/0004_snapshot.json` (new),
      `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/contacts/service.ts`
    - `apps/server/src/modules/tools/definitions.ts`
    - `apps/server/src/modules/ai/orchestrator.ts`
    - `apps/server/src/modules/automation/events.ts`, `apps/server/src/modules/automation/service.ts`
    - `apps/server/src/http/routes/contacts.ts`, `apps/server/src/http/routes/public-api.ts`
  - Tests:
    - `apps/server/test/identity.test.ts` (new)
    - `apps/server/test/contacts.test.ts`, `apps/server/test/tenancy.test.ts`
  - Dashboard:
    - `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`
    - `apps/dashboard/src/components/activity.tsx`
    - `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`, `apps/dashboard/src/pages/contacts/ContactsPage.tsx`
  - Repo:
    - `scripts/verify-phase.mjs` (new)
    - `package.json` (`verify:phase` script)
    - `docs/API.md`, `PROGRESS.md`
- **Phase 2 (2026-09-27):**
  - Server:
    - `apps/server/src/modules/scheduling/service.ts`
    - `apps/server/src/modules/tools/definitions.ts`
    - `apps/server/src/modules/ai/prompt.ts`
    - `apps/server/src/http/routes/scheduling.ts`
  - Tests: `apps/server/test/booking.test.ts`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (Phase 2 plan), `PROGRESS.md`
- **Phase 3 (2026-09-27):**
  - Server:
    - `apps/server/src/modules/ai/orchestrator.ts`
    - `apps/server/src/modules/tools/executor.ts`, `apps/server/src/modules/tools/types.ts`,
      `apps/server/src/modules/tools/definitions.ts`
    - `apps/server/src/infra/lock.ts`
    - `apps/server/src/modules/conversations/service.ts`
    - `apps/server/src/modules/automation/service.ts`
    - `apps/server/src/config/env.ts`
    - `apps/server/src/container.ts`
    - `apps/server/src/db/schema/conversations.ts` (status type only, no SQL change)
    - `apps/server/src/modules/ai/llm/mock.ts` (test support)
    - `apps/server/.env.example`
  - Tests:
    - `apps/server/test/reliability.test.ts` (new), `apps/server/test/lock.test.ts` (new)
    - `apps/server/test/helpers.ts`
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/components/activity.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (Phase 3 plan; Phase 5 note), `PROGRESS.md`
- **Phase 4 planning (2026-09-27):** `docs/IMPLEMENTATION_PLAN.md` (the detailed Phase 4 plan, and a Phase 5 note
  about offered slots) and `PROGRESS.md`. No code changed.
- **Phase 4 deferral and Phase 5 planning (2026-09-27):** `docs/IMPLEMENTATION_PLAN.md` (the order, a deferral note
  on Phase 4, Phase 8's dependency, the detailed Phase 5 plan) and `PROGRESS.md`. No code changed.
- **Phase 5 (2026-09-27):**
  - Server:
    - `apps/server/src/modules/ai/orchestrator.ts`
    - `apps/server/src/modules/ai/prompt.ts`
    - `apps/server/src/modules/ai/summary.ts`
    - `apps/server/src/modules/ai/budget.ts` (new)
    - `apps/server/src/modules/conversations/service.ts`
    - `apps/server/src/container.ts`
    - `apps/server/src/config/env.ts`
    - `apps/server/src/scripts/chat-cli.ts`
    - `apps/server/.env.example`
  - Tests: `apps/server/test/memory.test.ts` (new), `apps/server/test/helpers.ts`
  - Dashboard: `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`, `apps/dashboard/src/lib/types.ts`
  - Docs: `PROGRESS.md`
- **Phase 6 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed Phase 6 plan) and `PROGRESS.md`.
  No code changed.
- **Phase 6 (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/crm.ts`
    - `apps/server/drizzle/0005_lead_source_consent.sql` (new, with RLS added by hand),
      `apps/server/drizzle/meta/0005_snapshot.json` (new), `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/leads/attribution.ts` (new)
    - `apps/server/src/modules/contacts/service.ts`
    - `apps/server/src/modules/conversations/service.ts`
    - `apps/server/src/modules/tools/definitions.ts`, `apps/server/src/modules/tools/types.ts`
    - `apps/server/src/modules/ai/orchestrator.ts`, `apps/server/src/modules/ai/prompt.ts`
    - `apps/server/src/modules/bots/config.ts`
    - `apps/server/src/modules/automation/events.ts`, `apps/server/src/modules/automation/service.ts`
    - `apps/server/src/http/routes/widget.ts`, `apps/server/src/http/routes/public-api.ts`,
      `apps/server/src/http/routes/contacts.ts`
  - Tests: `apps/server/test/lead-source.test.ts` (new), `apps/server/test/consent.test.ts` (new),
    `apps/server/test/tenancy.test.ts`
  - Widget: `apps/widget/src/widget.ts` (and the rebuilt `apps/widget/dist/widget.js`)
  - Dashboard:
    - `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`, `apps/dashboard/src/components/activity.tsx`
    - `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`, `apps/dashboard/src/pages/contacts/ContactsPage.tsx`
    - `apps/dashboard/src/pages/bots/sections.tsx`, `apps/dashboard/src/pages/automations/AutomationsPage.tsx`
  - Docs: `docs/API.md`, `PROGRESS.md`
- **Phase 7 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed Phase 7 plan) and `PROGRESS.md`.
  No code changed.
- **Phase 8 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed Phase 8 plan) and `PROGRESS.md`.
  No code changed.
- **Phase 9 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed Phase 9 plan) and `PROGRESS.md`.
  No code changed.
- **Feature track and F1 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the order, the feature audit, the
  detailed F1 plan and short entries for F2–F9) and `PROGRESS.md`. No code changed.
- **F1 / Phase 10 (2026-09-28):**
  - Server: `apps/server/src/modules/bots/config.ts`, `apps/server/src/modules/ai/prompt.ts`,
    `apps/server/src/modules/ai/orchestrator.ts`, `apps/server/src/http/routes/bots.ts`,
    `apps/server/src/http/routes/widget.ts`
  - Tests: `apps/server/test/personality.test.ts` (new), `apps/server/test/__snapshots__/personality.test.ts.snap`
    (new)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/pages/bots/sections.tsx`,
    `apps/dashboard/src/pages/bots/BotEditorPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F1 marked as built), `PROGRESS.md`
- **F2 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed F2 plan) and `PROGRESS.md`. No code changed.
- **F2 / Phase 11 (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/crm.ts` (the fact type only; no SQL change)
    - `apps/server/src/modules/contacts/service.ts`, `apps/server/src/http/routes/contacts.ts`
    - `apps/server/src/modules/ai/prompt.ts`, `apps/server/src/modules/ai/orchestrator.ts`
    - `apps/server/src/modules/scheduling/service.ts` (past appointments)
    - `apps/server/src/modules/channels/service.ts` (the shared greeting rule), `apps/server/src/http/routes/widget.ts`,
      `apps/server/src/http/routes/bots.ts` (playground)
  - Tests: `apps/server/test/context.test.ts` (new), `apps/server/test/__snapshots__/personality.test.ts.snap` (one
    line), `apps/server/test/orchestrator.test.ts` (two assertions)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F2 marked as built), `PROGRESS.md`
- **F3 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed F3 plan) and `PROGRESS.md`. No code changed.
- **F3 / Phase 12 (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/conversations.ts`, `apps/server/drizzle/0008_conversation_summary_details.sql` (new),
      `apps/server/drizzle/meta/0008_snapshot.json` (new), `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/ai/summary.ts`, `apps/server/src/modules/ai/prompt.ts` (the `status` tag is escaped)
    - `apps/server/src/modules/conversations/service.ts`, `apps/server/src/modules/automation/events.ts`
    - `apps/server/src/http/routes/conversations.ts`, `apps/server/src/http/routes/widget.ts`
    - `apps/server/src/container.ts`
  - Tests: `apps/server/test/summary.test.ts` (new)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`,
    `apps/dashboard/src/components/activity.tsx`, `apps/dashboard/src/pages/conversations/ConversationsPage.tsx`,
    `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F3 marked as built), `PROGRESS.md`
- **F4 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed F4 plan, split into F4a and F4b) and
  `PROGRESS.md`. No code changed.
- **F4a / Phase 13, first step (2026-09-28):**
  - Server:
    - `apps/server/src/modules/auth/service.ts` (scopes, key update), `apps/server/src/http/routes/org.ts`
    - `apps/server/src/modules/conversations/service.ts` (the event for messages to chat-API customers, polling
      lookup, timeline filter), `apps/server/src/modules/automation/events.ts`,
      `apps/server/src/modules/automation/service.ts` (activity filter)
    - `apps/server/src/http/routes/public-api.ts`, `apps/server/src/http/routes/contacts.ts`,
      `apps/server/src/http/routes/conversations.ts`, `apps/server/src/http/routes/scheduling.ts`
    - `apps/server/src/container.ts`
  - Tests: `apps/server/test/integrations.test.ts` (new)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/pages/settings/SettingsPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F4a marked as built), `PROGRESS.md`
- **F4b / Phase 13, second step (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/deals.ts` (new), `apps/server/src/db/schema/index.ts`,
      `apps/server/src/db/schema/core.ts` (the currency setting)
    - `apps/server/drizzle/0009_deals.sql` (new, with RLS added by hand), `apps/server/drizzle/meta/0009_snapshot.json`
      (new), `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/deals/service.ts` (new), `apps/server/src/http/routes/deals.ts` (new),
      `apps/server/src/http/app.ts`, `apps/server/src/container.ts`
    - `apps/server/src/modules/tenancy/bootstrap.ts` (default pipeline), `apps/server/src/modules/tenancy/service.ts`
      (currency)
    - `apps/server/src/modules/contacts/service.ts` (merge moves deals; owner check),
      `apps/server/src/modules/automation/events.ts`, `apps/server/src/modules/auth/service.ts` (scopes)
  - Tests: `apps/server/test/deals.test.ts` (new)
  - Dashboard: `apps/dashboard/src/pages/deals/DealsPage.tsx` (new), `apps/dashboard/src/App.tsx`,
    `apps/dashboard/src/components/Layout.tsx`, `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`,
    `apps/dashboard/src/components/activity.tsx`, `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`,
    `apps/dashboard/src/pages/conversations/ConversationsPage.tsx`, `apps/dashboard/src/pages/settings/SettingsPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F4 marked as built), `PROGRESS.md`
- **F5 planning (2026-09-28):** `docs/IMPLEMENTATION_PLAN.md` (the detailed F5 plan, split into F5a and F5b) and
  `PROGRESS.md`. No code changed.
- **F5a / Phase 14, first step (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/automation.ts`, `apps/server/drizzle/0010_workflow_identified_only.sql` (new),
      `apps/server/drizzle/meta/0010_snapshot.json` (new), `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/bots/config.ts`, `apps/server/src/modules/bots/service.ts` (reference checks)
    - `apps/server/src/modules/tools/definitions.ts` (5 new tools), `apps/server/src/modules/tools/types.ts`,
      `apps/server/src/modules/tools/executor.ts`
    - `apps/server/src/modules/ai/prompt.ts`, `apps/server/src/modules/ai/orchestrator.ts`,
      `apps/server/src/http/routes/bots.ts` (prompt preview)
    - `apps/server/src/modules/automation/service.ts` (sources, trust, the switch),
      `apps/server/src/modules/automation/events.ts`
    - `apps/server/src/modules/contacts/service.ts` (owner, tag removal), `apps/server/src/modules/deals/service.ts`
      (the AI as a source; test deals), `apps/server/src/container.ts`
  - Tests: `apps/server/test/crm-actions.test.ts` (new), `apps/server/test/reliability.test.ts` (a type fix)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`, `apps/dashboard/src/lib/queries.ts`,
    `apps/dashboard/src/components/activity.tsx`, `apps/dashboard/src/pages/bots/sections.tsx`,
    `apps/dashboard/src/pages/bots/BotEditorPage.tsx`, `apps/dashboard/src/pages/automations/AutomationsPage.tsx`,
    `apps/dashboard/src/pages/deals/DealsPage.tsx`, `apps/dashboard/src/pages/conversations/ConversationsPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F5a marked as built), `PROGRESS.md`
- **F5b / Phase 14, second step (2026-09-29):**
  - Server:
    - `apps/server/src/db/schema/approvals.ts` (new), `apps/server/src/db/schema/index.ts`,
      `apps/server/src/db/schema/automation.ts` (`ask_first`), `apps/server/src/db/schema/conversations.ts` (the
      `pending` tool status)
    - `apps/server/drizzle/0011_action_approvals.sql` (new, with RLS added by hand),
      `apps/server/drizzle/meta/0011_snapshot.json` (new), `apps/server/drizzle/meta/_journal.json`
    - `apps/server/src/modules/approvals/service.ts` (new), `apps/server/src/http/routes/approvals.ts` (new),
      `apps/server/src/http/app.ts`, `apps/server/src/container.ts`
    - `apps/server/src/modules/tools/executor.ts` (asking first, replay, running approved calls),
      `apps/server/src/modules/tools/types.ts`, `apps/server/src/modules/tools/definitions.ts`
    - `apps/server/src/modules/bots/config.ts` (`askFirst`), `apps/server/src/modules/automation/service.ts`
      (workflow `askFirst`, `approvedBy`, the notification), `apps/server/src/modules/automation/events.ts`
    - `apps/server/src/modules/ai/prompt.ts` (the approval line; requests and CRM actions in earlier actions),
      `apps/server/src/modules/ai/orchestrator.ts`, `apps/server/src/http/routes/bots.ts` (prompt preview)
  - Tests: `apps/server/test/approvals.test.ts` (new), `apps/server/test/reliability.test.ts` (a type fix)
  - Dashboard: `apps/dashboard/src/components/approvals.tsx` (new), `apps/dashboard/src/pages/approvals/ApprovalsPage.tsx`
    (new), `apps/dashboard/src/App.tsx`, `apps/dashboard/src/components/Layout.tsx`,
    `apps/dashboard/src/components/activity.tsx`, `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/format.ts`,
    `apps/dashboard/src/pages/conversations/ConversationsPage.tsx`, `apps/dashboard/src/pages/bots/sections.tsx`,
    `apps/dashboard/src/pages/automations/AutomationsPage.tsx`
  - Docs: `docs/API.md`, `docs/IMPLEMENTATION_PLAN.md` (F5b marked as built), `PROGRESS.md`
- **Website chat: "Powered by" line and the visitor's IP (2026-09-29):**
  - Server: `apps/server/src/lib/ip.ts` (new), `apps/server/src/config/env.ts` (`TRUST_PROXY`), `apps/server/src/http/app.ts`,
    `apps/server/src/http/routes/widget.ts`, `apps/server/src/modules/conversations/service.ts`
  - Widget: `apps/widget/src/widget.ts`
  - Dashboard: `apps/dashboard/src/pages/conversations/ConversationsPage.tsx` (the Details row),
    `apps/dashboard/src/lib/types.ts` (`metadata` on the conversation)
  - Tests: `apps/server/test/widget-visitor-ip.test.ts` (new)
  - Docs: `docs/API.md`, `apps/server/.env.example`, `PROGRESS.md`
- **Website chat: no bubble jump on load (2026-09-29):**
  - Widget: `apps/widget/src/widget.ts`
  - Docs: `PROGRESS.md`
- **Website chat redesign (2026-09-29):**
  - Widget: `apps/widget/src/widget.ts`
  - Docs: `PROGRESS.md`
- **Settings preview (2026-09-29):**
  - Dashboard: `apps/dashboard/src/pages/settings/SettingsPage.tsx` (`WidgetPreview`)
  - Docs: `PROGRESS.md`
- **Bot editor redesign, Phase 1 (2026-09-30):**
  - Dashboard: `apps/dashboard/src/pages/bots/editorNav.ts` (new: groups, statuses, essentials, search),
    `apps/dashboard/src/pages/bots/editor.tsx` (new: menu, overview, search, save bar, save errors),
    `apps/dashboard/src/pages/bots/BotEditorPage.tsx` (the page frame), `apps/dashboard/src/components/Layout.tsx`
    (icons-only main menu on the editor), `apps/dashboard/src/components/overlay.tsx` (the dialog focus helper
    exported), `apps/dashboard/src/pages/bots/sections.tsx` and `Playground.tsx` (two titles)
  - Docs: `PROGRESS.md`
- **Bot editor redesign, Phase 2 (2026-09-30):**
  - Dashboard: `apps/dashboard/src/pages/bots/Playground.tsx` (the test chat's look; its logic unchanged),
    `apps/dashboard/src/pages/bots/BotEditorPage.tsx` (passes the chat's name), `apps/dashboard/src/lib/format.ts`
    (`initialsOf`, moved), `apps/dashboard/src/pages/settings/SettingsPage.tsx` (imports it)
  - Docs: `PROGRESS.md`
- **Bot editor redesign, Phase 3 (2026-09-30):**
  - Dashboard: `apps/dashboard/src/pages/bots/sections.tsx` (cards, feature switches, Identity & voice, anchors for
    search), `apps/dashboard/src/pages/bots/editorNav.ts` (section descriptions, the 55 searchable settings, search
    over them, `askedFor` shared with the overview), `apps/dashboard/src/pages/bots/editor.tsx` (section heading,
    search results that carry a setting), `apps/dashboard/src/pages/bots/BotEditorPage.tsx` (heading, jump to a
    setting), `apps/dashboard/src/index.css` (the highlight)
  - Docs: `PROGRESS.md`
- **Main menu collapses on every page (2026-09-30):**
  - Dashboard: `apps/dashboard/src/components/Layout.tsx` (one remembered setting and the button on every page)
  - Docs: `PROGRESS.md`
- **Conversation starters (2026-09-29):**
  - Server: `apps/server/src/modules/bots/config.ts` (schema, checks, `offeredStarters`, `handoffStarter`),
    `apps/server/src/http/routes/widget.ts` (config `starters`, `starterId` on messages),
    `apps/server/src/http/routes/bots.ts` (Playground `starters`), `apps/server/src/modules/ai/orchestrator.ts`
    (handoff for a "talk to the team" starter)
  - Widget: `apps/widget/src/starters.ts` (new), `apps/widget/src/widget.ts`
  - Dashboard: `apps/dashboard/src/pages/bots/sections.tsx` (`StartersSection`),
    `apps/dashboard/src/pages/bots/BotEditorPage.tsx` (the tab), `apps/dashboard/src/pages/bots/Playground.tsx`,
    `apps/dashboard/src/lib/types.ts`
  - Tests: `apps/server/test/conversation-starters.test.ts` (new)
  - Docs: `docs/API.md`, `PROGRESS.md`
- **Website chat: embed address and draggable bubble (2026-09-29):**
  - Server: `apps/server/src/config/env.ts` (`PUBLIC_API_URL` optional), `apps/server/src/modules/channels/service.ts`,
    `apps/server/src/http/routes/channels.ts`, `apps/server/src/main.ts`, `apps/server/src/db/schema/channels.ts`
    (`draggable`)
  - Widget: `apps/widget/src/drag.ts` (new), `apps/widget/src/widget.ts`
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/pages/settings/SettingsPage.tsx`
  - Tests: `apps/server/test/widget-setup.test.ts` (new), `apps/server/test/widget-drag.test.ts` (new)
  - Docs: `docs/API.md`, `apps/server/.env.example`, `render.yaml` (comment), `PROGRESS.md`
- **After the F5a check-in (2026-09-29):**
  - Server: `apps/server/src/modules/tools/definitions.ts` (repeat `create_deal`), `apps/server/src/modules/ai/prompt.ts`
    (internal records; "(not given yet)"), `apps/server/src/modules/leads/capture.ts` (placeholders),
    `apps/server/src/modules/contacts/service.ts` (ignoring them)
  - Tests: `apps/server/test/contacts.test.ts`, `apps/server/test/crm-actions.test.ts`
  - Docs: `docs/API.md`, `PROGRESS.md`
- **Phase 7 (2026-09-28):**
  - Server:
    - `apps/server/src/modules/leads/qualification.ts`
    - `apps/server/src/db/schema/crm.ts` (the `QualificationAnswer` type only; no SQL change)
    - `apps/server/src/modules/tools/definitions.ts`
  - Tests: `apps/server/test/qualification-changes.test.ts` (new)
  - Dashboard:
    - `apps/dashboard/src/lib/types.ts`
    - `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`
    - `apps/dashboard/src/pages/bots/sections.tsx`, `apps/dashboard/src/pages/bots/BotEditorPage.tsx`
  - Docs: `docs/API.md`, `PROGRESS.md`
- **Phase 8 (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/knowledge.ts`, `apps/server/drizzle/0006_kb_language_url_refresh.sql` (+ snapshot and
      journal)
    - `apps/server/src/modules/knowledge/service.ts`, `apps/server/src/modules/knowledge/embeddings.ts`
    - `apps/server/src/modules/ai/prompt.ts`, `apps/server/src/modules/ai/orchestrator.ts`
    - `apps/server/src/http/routes/knowledge.ts`, `apps/server/src/http/routes/bots.ts` (prompt preview)
    - `apps/server/src/container.ts` (refresh timer)
    - `apps/server/src/scripts/search-eval.ts` (new), `apps/server/package.json` (`search-eval` script)
  - Tests: `apps/server/test/fixtures/search-set.ts` (new), `apps/server/test/search-quality.test.ts` (new),
    `apps/server/test/knowledge.test.ts`
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/lib/queries.ts`,
    `apps/dashboard/src/pages/knowledge/KnowledgePage.tsx`
  - Docs: `docs/API.md`, `PROGRESS.md`
- **Phase 9 (2026-09-28):**
  - Server:
    - `apps/server/src/db/schema/scheduling.ts`, `apps/server/drizzle/0007_booking_emails_policy.sql` (+ snapshot and
      journal; RLS added by hand)
    - `apps/server/src/modules/scheduling/notifications.ts` (new), `apps/server/src/modules/scheduling/ics.ts` (new),
      `apps/server/src/modules/scheduling/service.ts`
    - `apps/server/src/infra/email.ts`, `apps/server/src/infra/queue.ts`, `apps/server/src/lib/timezone.ts` (new)
    - `apps/server/src/modules/tools/definitions.ts`, `apps/server/src/modules/ai/prompt.ts`
    - `apps/server/src/modules/contacts/service.ts`, `apps/server/src/modules/conversations/service.ts`
    - `apps/server/src/modules/automation/service.ts`
    - `apps/server/src/http/routes/scheduling.ts`, `widget.ts`, `public-api.ts`
    - `apps/server/src/container.ts`
  - Tests: `apps/server/test/booking-emails.test.ts` (new)
  - Dashboard: `apps/dashboard/src/lib/types.ts`, `apps/dashboard/src/pages/appointments/CalendarEditor.tsx`,
    `apps/dashboard/src/pages/appointments/AppointmentsPage.tsx`, `apps/dashboard/src/pages/contacts/ContactDetailPage.tsx`
  - Widget: `apps/widget/src/widget.ts` (and the rebuilt `dist/widget.js`, which isn't tracked)
  - Docs: `docs/API.md`, `apps/server/.env.example`, `PROGRESS.md`

## DB / API changes

**Phase 1:**
- **DB:** new table `contact_merge_candidates` with tenant-isolation RLS (migration `0004_merge_candidates`). No
  existing table changed. Dev databases pick it up on their next start; `.data/preview` already has it, because
  the running dev API restarted.
- **API (new):**
  - `GET /v1/contacts/:id/merge-candidates`
  - `POST /v1/contacts/:id/merge { intoContactId }`
  - `POST /v1/merge-candidates/:id/dismiss`
- **API (changed):**
  - `GET /v1/contacts` items gain `hasPendingMerge`
  - `leadsOnly` includes visitors with a pending review
  - new webhook event `contact.duplicate_detected`
- **Behavior change:** AI captures no longer merge contacts; the public API's `contact` payload still does.

**Phase 2:**
- **DB:** none (no migration). `idempotency_key` is no longer used.
- **API (changed):**
  - `POST /v1/appointments` returns 200 with the existing appointment when the contact already has that slot
    (previously a 409)
  - cancelling an already-cancelled appointment returns 200 (previously a 400)
  - rescheduling to the current time changes nothing
- **AI tool result:** `book_appointment` drops `confirmation_sent_to` and adds `customer_confirmation_sent: false`,
  plus `already_booked: true` on a repeat.

**Phase 3:**
- **DB:** none (no migration). `tool_invocations.status` can now be `replayed`.
- **API (changed):** the conversation timeline's tool entries can have status `replayed`.
- **Config:** new `AI_TURN_TIMEOUT_MS` (default 90 000).
- **Behavior:**
  - the conversation lock's TTL is now 60 s and it renews itself
  - handoff events carry `notifyTeam`
  - staff alerts follow the bot setting, except for error and budget handoffs

**Phase 5:**
- **DB:** none (no migration). It uses the existing `conversations.summary`, `summarized_through_message_id` and
  `contacts.memory`.
- **API:** no shape change. A conversation's `summary` is now filled for short chats too, once they go quiet or are
  closed. The dashboard's list type now includes it, which the API already returned.
- **Config:** new `AI_SUMMARY_IDLE_MINUTES` (default 30; 0 turns quiet-spell recaps off). A recap costs one
  utility-model call per conversation, in dev servers too.
- **Behavior:**
  - The model sees the summary plus every message not yet summarized (20–40).
  - Long chats are summarized about every 10 messages, instead of every ~2 exchanges.
  - Quiet and closed conversations get a recap.
  - Returning customers see their last 2 recaps.
  - Each turn lists earlier actions and the offered slots.
  - Long pauses are marked in the history.
  - Greetings, thanks and goodbyes skip knowledge search.
  - Memory is labelled and escaped.

**Phase 6:**
- **DB:** migration `0005_lead_source_consent`: new `contacts.first_touch` (jsonb, GIN index) and `contacts.consent`
  (jsonb), and a new `contact_consents` table with tenant-isolation RLS. Nothing is backfilled. Your dev database gets it
  on its next start.
- **API (new):**
  - `GET /v1/contacts/source-options`
  - `GET /v1/contacts/:id/consents` and `POST /v1/contacts/:id/consents`
- **API (changed):**
  - The contact view adds `firstTouch` and `consent`.
  - List filters `utmSource`, `utmMedium`, `utmCampaign`, `marketingConsent`.
  - `POST /v1/contacts` accepts `source`; contacts created by staff have `sourceChannel: null`.
  - The public API accepts `source` and `contact.marketingConsent`.
  - The widget's `POST /messages` accepts `firstTouch`, and page URLs are trimmed.
  - New webhook event `contact.consent_updated`; the contact snapshot adds `first_touch` and `consent`.
- **Config:** the bot's `leadCapture.marketingOptIn` (the exact question; empty means don't ask). Two new tools,
  `ask_marketing_consent` and `record_marketing_consent`, offered only when the question is set.

**Phase 7:**
- **DB:** none. Stored answers gain an optional `botId` inside the existing `contacts.qualification` JSON.
- **API (changed):**
  - A contact's qualification answers carry `botId`.
  - `lead.qualification_updated`, `lead.qualified` and `lead.disqualified` carry `botId`.
  - `lead.qualified` can follow an earlier `lead.disqualified` (with `previousStatus`).
- **Behavior:**
  - A disqualified lead can become qualified; a qualified lead stays qualified.
  - Only answers that fit the bot's current questions count; the others are asked again and kept.
  - The prompt shows only this bot's answers.

**Phase 8:**
- **DB** (migration `0006_kb_language_url_refresh`):
  - `knowledge_bases.language` (text, default `english`).
  - `document_chunks.tsv` is no longer generated as English; ingestion writes it in the knowledge base's language.
    `DROP EXPRESSION` keeps the existing English values and the GIN index, so nothing is rebuilt.
  - `documents.refresh_interval_hours` and `documents.next_refresh_at`, with a partial index for due refreshes.
  - `.data/preview` already has it: the running dev API restarted and migrated.
- **API (new):** `GET /v1/knowledge/languages` → `[{ value, label }]`.
- **API (changed):**
  - Knowledge bases: `language` on create, update and in views (400 for a language the database doesn't have).
  - Web-page documents accept `refreshIntervalHours` (24, 168 or null) on create and `PATCH`. A schedule on another
    document type is a 400. Document views add `refreshIntervalHours` and `nextRefreshAt`.
  - `PATCH /v1/documents/:id`: a new category or schedule no longer re-ingests; a new title, content or FAQ list does.
- **Behavior:**
  - Keyword search runs in each knowledge base's language; words in every script stay whole.
  - The prompt names the documents' languages (a new line in the stable, cached part of the prompt).
  - Due web pages are re-fetched by the worker; failures keep the last good version and retry within 6 hours.

**F1 (Phase 10):**
- **DB:** none. Bot config is JSON; `goals` and `persona.personality` have defaults, so existing bots read as before.
- **API (changed):** bot config accepts `goals: { primary (≤300), secondary (≤5 × 200) }` and
  `persona.personality (≤600)`; longer values are a 400 naming the field. Empty extra goals are dropped and line breaks
  in goals collapse. The widget config's `companyName` falls back to the organization's name.
- **Behavior:** the prompt lists the business's goals first (with the no-pressure line), adds the personality under
  the tone, and uses the organization's name when the bot has no company name. Bots without these settings keep the
  exact same prompt.

**F2 (Phase 11):**
- **DB:** none (no migration). Facts stay in `contacts.memory`; new facts get an `id`, and older ones get a stable ID
  from their text and time when read.
- **API (new):** `POST /v1/contacts/:id/memory { text }` (1–500 characters) → 201 with the fact, and
  `DELETE /v1/contacts/:id/memory/:factId` → 204 (404 if unknown). Both need an agent or an API key with
  `contacts:write`.
- **API (changed):**
  - `POST /v1/contacts/:id/notes` accepts `shareWithAssistant` (default false); a shared note also becomes a team
    fact.
  - The contact's `memory` items carry an `id`; `source` is `user` for the team's facts and `ai` for the AI's.
  - Adding or removing a fact records a `contact.updated` event with `changed: ['memory']`, without the fact's text.
- **Behavior:**
  - Each turn's context adds the greeting note (web chat and playground, until the first message is summarized),
    `<page>`, `stage:`, team facts first (up to 15 facts in total) and `<recent_appointments>`.
  - One new line in the system prompt (stable, cached part), so each bot's prompt cache rebuilds once.
  - The playground picks its greeting with the same rule as the widget.

**F3 (Phase 12):**
- **DB:** migration `0008_conversation_summary_details`: `conversations.summary_details` (jsonb, nullable). Nothing is
  backfilled; older summaries show without parts until their next recap. `.data/preview` already has it: the running
  dev API restarted and migrated.
- **API (new):** `POST /v1/conversations/:id/summary` (agent+) → `202 { queued: true }` or `200 { queued: false,
  reason: nothing_new | too_short | ai_off | budget }`.
- **API (changed):**
  - Conversation views add `summaryDetails: { intent, outcome, nextStep, sentiment, trigger, at, throughMessageId }`
    (null until the first recap).
  - New webhook event `conversation.summarized` `{ summary, intent, outcome, nextStep, sentiment, trigger, status }`.
  - The conversation stream sends `conversation.summary` (no content) when a summary is saved.
  - The widget stream sends only `message`, `ai.*` and `conversation.status` (without `reason`).
- **Behavior:** recaps at every handoff and on request, as well as after a quiet spell and on close; recaps with parts
  in English (or the bot's fixed language). Recap calls read about 400 tokens and write about 90–140 on
  `gpt-4o-mini` (about $0.00014 each in the real-model check).

**F4a (Phase 13, first step):**
- **DB:** none. A chat-API conversation keeps its customer's `externalUserId` in its details (new conversations;
  older ones use the customer's identity).
- **API (new):**
  - `GET /v1/channels/api/messages?externalUserId=&after=&limit=` (`conversations:write`)
  - `PATCH /v1/api-keys/:id { name?, scopes? }` (admin)
  - scopes `conversations:read`, `appointments:read` and `appointments:write`
  - webhook event `message.outbound` `{ message: { id, content, senderType, createdAt }, externalUserId }` (24 event
    types)
- **API (changed):**
  - `POST /v1/channels/api/messages` adds `replies` (every message of the turn); `202` responses carry
    `replies: []`.
  - API keys reach tags, notes, tasks and field definitions (contact scopes), conversations, their messages and
    timelines and a contact's conversations (`conversations:read`), and calendars, availability and appointments
    (`appointments:*`). See the access table in `docs/API.md`.
  - `message.outbound` events don't show in the activity feed or timelines.
- **Behavior:** existing keys keep exactly their scopes.

**F4b (Phase 13, second step):**
- **DB:** migration `0009_deals`: new tables `pipelines`, `pipeline_stages` and `deals`, each with tenant-isolation
  RLS and grants added by hand, and indexes for the board and for contacts. No existing table changed.
  `.data/preview` already has it: the running dev API restarted and migrated. Organizations from before this get
  their "Sales" pipeline when deals are first opened.
- **API (new):** `GET|POST /v1/pipelines`, `PATCH|DELETE /v1/pipelines/:id` (changes: admin),
  `GET|POST /v1/deals`, `GET /v1/deals/summary`, `GET|PATCH|DELETE /v1/deals/:id`, `GET /v1/contacts/:id/deals`;
  scopes `deals:read` and `deals:write`; 6 deal events (30 event types).
- **API (changed):** the organization setting `currency` (ISO 4217); a contact's `ownerUserId` must be a member of the
  organization (400 otherwise).
- **Behavior:** merging contacts moves deals; deleting a contact deletes its deals.

**Website chat: visitor IP (2026-09-29):**
- **DB:** none: the address is kept in the conversation's existing `metadata` JSON (`visitorIp`, `visitorIpAt`).
- **Config:** new `TRUST_PROXY` (default `true`, as before).
- **API (changed):** `GET /v1/conversations/:id` shows `metadata.visitorIp` for website chats. Nothing the widget reads
  changed.

**Website chat (2026-09-29):**
- **DB:** none (the theme is JSON).
- **API (changed):** `embedSnippet` uses `PUBLIC_API_URL` when set, else the address the request came in on;
  `PUBLIC_API_URL` is optional (no localhost default). Channel `theme.draggable` (boolean, default off), returned by
  `/widget/v1/config`.

**F5b (Phase 14, second step):**
- **DB:** migration `0011_action_approvals`: new table `action_approvals` (the request, its summary, status, result,
  reason, who decided and when, expiry) with tenant-isolation RLS and grants added by hand; `workflows.ask_first`
  (boolean, default false). `tool_invocations.status` can now be `pending` (text, no change). `.data/preview` already
  has it: the running dev API restarted and migrated.
- **API (new):** `GET /v1/approvals`, `POST /v1/approvals/:id/approve { message? }`,
  `POST /v1/approvals/:id/reject { reason?, message? }` (deciding: agent and up, staff only); events
  `action.approval_requested`, `action.approved`, `action.rejected` (34 event types).
- **API (changed):** bot `actions.askFirst` (the 9 actions above); workflow `askFirst`; workflow calls' `trust` gains
  `approvedBy`; the timeline's tool `status` can be `pending`.
- **AI:** an ask-first call returns `{ waiting_for_team, request_id, note }` instead of acting; one prompt line only
  for bots with ask-first actions; earlier actions list requests with their answer (and now the CRM actions too).

**F5a (Phase 14, first step):**
- **DB:** migration `0010_workflow_identified_only`: `workflows.identified_only` (boolean, default false). Input
  sources live in the existing `input_fields` JSON. `.data/preview` already has it: the running dev API restarted and
  migrated.
- **API (changed):**
  - Bot config `actions` gains `lifecycleStages` (the organization's stages), `owners` (member IDs), `removeTags` and
    `deals: { enabled, pipelineId, canClose }`; unknown stages, members or pipelines are a 400.
  - Workflows gain `identifiedOnly` and, per input, `source` (`chat` or `contact.email|phone|name|id`; a record value
    must be type `string`). Workflow calls add `record` and `trust` next to `inputs`.
  - `GET /v1/deals` and `/v1/deals/summary` leave out test contacts' deals unless `includeTest=true` (or `contactId` is
    given); new event type `contact.untagged` (31 event types).
- **AI:** 5 new tools, off by default; the owner and open deals in the context, and the "Keeping the CRM up to date"
  prompt section, only for bots with those actions. Bots without them keep the same tools, context and prompt.

**Phase 9:**
- **DB** (migration `0007_booking_emails_policy`):
  - `calendars`: `location`, `customer_instructions`, `send_confirmations` (default true), `reminder_minutes` (jsonb,
    default `[1440]`), `reply_to_email`, `min_cancel_notice_minutes` (null = until the start).
  - `appointments.notify_customer` (default true).
  - New table `appointment_notifications` (one row per customer email: kind, status, reason, error, send time, the
    start it was written for, reminder offset, recipient, attempts, lease, provider ID), with tenant-isolation RLS.
  - `contacts.timezone` (existing) is now filled.
  - `.data/preview` already has it: the running dev API restarted and migrated.
- **API (new):** `GET /v1/appointments/:id/notifications`, `POST /v1/appointments/:id/resend-confirmation`.
- **API (changed):**
  - Calendars accept the new fields (reminders: up to three, 30 minutes to 7 days; reply-to must be an email).
  - `POST /v1/appointments`, reschedule and cancel accept `notifyCustomer` (default true) and return `customerEmail:
    { queued, to, reason }`.
  - Contacts accept `timezone` (IANA, else 400); widget and integration messages accept `timezone`.
- **Behavior:**
  - Customer emails as above, sent only when a real email provider is configured (the log provider only logs).
  - The AI's booking results report emails truthfully, give the customer's own time, state the change policy, and
    point to the team when a change is refused. The prompt's booking lines changed accordingly (stable, cached part).
  - Staff get an alert when a booking moves, and when a customer email fails.

## Tests / verification

- **Baseline** before Phase 1: 71/71 tests passed (12 files); typecheck clean.
- **Phase 1:** 79/79 tests pass (13 files; 8 new), and the typecheck is clean on all three apps.
  - The attack test was confirmed to catch the bug: with the old merge behavior restored temporarily, all
    5 identity tests failed.
  - Hook self-test: 12/12.
  - Manual browser check skipped by decision.
- **Phase 2:** 84/84 tests pass (booking tests grew from 5 to 10), and the typecheck is clean on all three apps.
  - The 6 new tests were run on the unfixed code first: all 6 failed and the 4 existing ones passed. After the
    fix, all 10 pass.
  - PGlite accepts the advisory lock inside a transaction (checked during the audit).
  - No browser check: nothing visible changed in the dashboard.
- **Phase 3:** 92/92 tests pass (15 files; 8 new), and the typecheck is clean on all three apps.
  - Test support was added first (async fake-LLM turns, an injectable lock). Then the 8 new tests were run on the
    unfixed code: all 8 failed, and the time-limit tests hung until they timed out. After the fix, all pass.
  - Lock renewal is tested against an in-test fake Redis, since this machine has no Redis.
  - No browser check: the "reused" badge only appears after a failed attempt, and it's covered by the typecheck.

- **Phase 5:** 105/105 tests pass (16 files; 13 new in `test/memory.test.ts`), and the typecheck is clean on all
  three apps.
  - The 13 new tests were run on the unfixed code first: 12 failed, and the skip-guard test passed, as expected.
    For example, the cadence test counted 5 summary calls where 2 are expected.
  - The first verification run failed on the dashboard typecheck: the list type lacked `summary`, which the API
    already returned. After the fix it was re-run green.
  - **Review** (done by hand; the background review agent stalled). Two fixes:
    - a bare "?" still searches
    - the fold job ID includes a 10-message step, so a failed job can't block later folds under Redis
  - **Free size check** (fake model, seeded demo, same conversation as the Phase 4 audit):
    - The system prompt grew by 605 characters. It is fixed text, so it stays cacheable.
    - Turns after an availability check carry about 250–860 more characters (slots and actions). Total input for
      the 8-call booking chat rose 6.5%.
    - A returning customer's first call carries a 630-character memory block for one recap.
    - The simulated booking now succeeds: the slot values come from `<earlier_actions>`. Before, it failed because
      they were gone.
  - No real-model check (Phase 4 is deferred) and no browser check.

- **Phase 6:** 121/121 tests pass (18 files; 16 new), and the typecheck is clean on all three apps.
  - The new tests were run on the unfixed code first: 13 of 14 failed. The one that passed was the guard "no consent
    tools without a question", which trivially holds before the tools exist. After the fix, all pass.
  - **Review** (done by hand) found and fixed:
    - The plain-"no" guard matched any reply starting with "no", so "No problem, sign me up!" would have been
      refused as a yes. Now only a reply that is nothing but a no counts.
    - The widget sent UTM values the server would drop.
    - The consent filter had no test.
  - **Browser check,** on my own server instances (fake model, a scratch database, ports 4100, 5174 and 5190;
    your servers and data were untouched):
    - A visitor clicked an ad link from another origin that carried UTM tags, a gclid and an `email=` parameter,
      then moved to a pricing page and chatted there.
    - The contact got the landing page without its query string, the external referrer, google / cpc / fall-promo
      and the gclid. None of it came from the chat page.
    - The Source and Marketing consent cards, the Leads list filters, the Source column and "Add from template" all
      worked, with no console errors.
    - The temporary launch configs were removed afterwards.

- **Phase 7:** 127/127 tests pass (19 files; 6 new), and the typecheck is clean on all three apps.
  - The 6 new tests were run on the unfixed code first: 5 failed. The one that passed was "a qualified lead stays
    qualified", which is today's behavior and is kept on purpose. After the fix, all pass, along with the 6 scoring
    tests and 11 orchestrator tests.
  - **Review** (done by hand): no defects found. Checked the status changes (only the approved ones), that the outcome
    runs once per new verdict, that history is kept, and that the dashboard's "fits" check mirrors the server's.
  - No real-model check (Phase 4 is deferred) and no browser check (a label and a warning, covered by the typecheck).

- **Phase 8:** 136/136 tests pass (20 files; 9 new), and the typecheck is clean on all three apps.
  - The new behavior tests were run on the unchanged code first, and all 7 failed: whole words, Hindi keyword search,
    Spanish stemming, the language change, the language list and 400, the prompt line, and the refresh cycle. After
    the change, all pass. The quality-floor test passed on the old code too: this set's same-language questions share
    exact words with the FAQs, so it guards against regressions rather than proving the fix. The category bug was
    found by reading the code; its test wasn't run against the old code.
  - **Search quality, 31 questions** (right document first / in the top 5):

    | Group | Production before | Production after | Local embedder after (CI floors) |
    |---|---|---|---|
    | English (16) | 16 / 16 | 16 / 16 | 13 / 14 (floors 12 / 13) |
    | Spanish (5) | 5 / 5 | 5 / 5 | 5 / 5 (floors 5 / 5) |
    | Hindi (4) | 4 / 4 | 4 / 4 | 4 / 4 (floors 4 / 4) |
    | Hinglish (3) | 3 / 3 | 3 / 3 | 2 / 2 (floors 2 / 2) |
    | Cross-language (3) | 1 / 3, MRR 0.61 | 1 / 3, MRR 0.53 | 0 / 0 (not enforced) |

    - Production = OpenAI `text-embedding-3-small`; the two paid runs cost about $0.0001 each.
    - Production top-5 is 31 of 31 before and after, so no reranker is proposed (the bar was 90%).
    - The production embeddings already found this set's same-language questions; the keyword fixes show up in the
      behavior tests (for example a Hindi word in a long passage, Spanish word forms) and in the local numbers.
    - The only change in production: one Hindi question answered only by an English document went from rank 2 to 4,
      because Hindi keyword search now matches common Hindi words (see Remaining issues).
  - **Browser check** on isolated ports (4100/5174) with a scratch database and a local test page:
    - The language badge, and the language setting with the re-index note, saved as Spanish and back.
    - A web page added with "Daily" showed "refreshes daily (next in 24h)".
    - With the site stopped, a re-ingest showed "Last fetch failed … Still answering from the version from …", the next
      try within 6 hours, and the test box still returned the page's content.
    - Editing the page (URL locked, no crawl options) switched it to weekly without re-fetching.
    - The temporary launch configs were removed afterwards; your :4000 and :5173 servers weren't touched (the API
      hot-restarted on code edits, as usual).
  - **Review** (done by hand), fixed:
    - A new schedule on a failed page pushed its 6-hour retry out by up to a week. It now keeps the quick retry
      (tested).
    - Sending `refreshIntervalHours: null` for a non-web document was a 400; "off" is now accepted.
    - The prompt line now says to search again in the documents' language, as planned, and web-page rows show the
      last fetch as well as the next one.

- **Phase 9:** 150/150 tests pass (21 files; 14 new), and the typecheck is clean on all three apps.
  - The 14 new tests were run on the unchanged code first, and all 14 failed. After the change, all pass, along with
    the existing booking tests (the "no confirmation claim" test still holds: that contact has no email).
  - Covered: one confirmation per booking with a valid calendar file; no email to a claimed address, a contact
    without email or a test conversation (each logged); updates and cancellations for the same event with a rising
    sequence; reminders re-planned or dropped; each due reminder sent once under two concurrent runs; daylight saving
    (a Sunday 1 November booking gets its 1-day reminder 25 hours before, the 2-hour one exactly 2 hours before);
    retries with identical payloads, then failure and a staff alert; staff booking without emails, resending and
    cancelling quietly; settings validation and email content; the policy refusal pointing to the team; the
    timezone from the widget, the AI and staff; the reschedule alert.
  - **Samples checked by eye** (log provider, decision 4): confirmation, change notice, reminder and cancellation for
    a customer in Vancouver booking a Toronto calendar, with their calendar files (same UID, sequence 0 → 1 → 2,
    `METHOD:CANCEL` on the cancellation, escaped and folded lines). No real inbox, by decision.
  - **Browser check** on isolated ports (4100/5174) with a scratch database: the calendar's email and policy settings
    saved; a staff booking toasted "a confirmation emailed to …"; the appointment's email log showed the confirmation
    sent and the 2-hour reminder scheduled (the 1-day one had already passed); "Resend confirmation" and the cancel
    dialog's notice worked; the contact page showed the timezone. No server errors. The temporary launch configs were
    removed; your :4000 and :5173 servers weren't touched (the API hot-restarted on code edits, as usual).
  - **Review** (done by hand), fixed:
    - The calendar file's timestamp was the send time, so a retry after a crash would have sent a different payload
      under the same idempotency key, which Resend rejects: the email would have been marked failed although the
      customer got it. It now uses the row's creation time, and a test checks that every retry is identical.
    - The prompt only guarded confirmation emails; it now covers change and cancellation emails too (tested through
      the tool result).
    - Cancellation emails gave only the calendar's time; they now show both times like the others.
    - The email log didn't refresh after "Resend confirmation"; it now follows an email that's due until it's sent.

- **F1 (Phase 10):** 157/157 tests pass (22 files; 7 new), and the typecheck is clean on all three apps.
  - The new tests were run on the unchanged code first: the 5 behavior tests failed (goals, personality, company
    fallback, limits, end to end). The "no goals" test passes on both, and the snapshot recorded today's prompt for
    the demo bot, which still matches after the change.
  - **Browser check** on isolated ports with a scratch database, driven through the page because the browser pane
    was hidden (no screenshots): the Goals tab after Persona; the four templates; the Receptionist template filled
    the role, tone, reply length, personality and main goal with a toast; adding a goal and saving made version 3;
    the prompt preview showed the goals, the no-pressure line and the personality; re-applying a template asked
    first, and cancelling changed nothing; the organization's name as the company placeholder. No console or server
    errors. The temporary launch configs were removed; your :4000 and :5173 servers weren't touched.
  - **Review** (done by hand), fixed: goals are one-line items in the prompt, but the API accepted line breaks inside
    them; line breaks and runs of spaces now collapse (tested).
  - No real-model check, by decision.

- **F2 (Phase 11):** 164/164 tests pass (23 files; 7 new), and the typecheck is clean on all three apps.
  - The 7 new tests were run on the unchanged code first, and all 7 failed. After the change, all pass, along with
    the Phase 5 memory tests.
  - **Existing tests changed on purpose:** the demo bot's prompt snapshot differs by exactly the new line (checked
    before updating it with `vitest -u`), and two orchestrator tests now read the newest message block instead of the
    first, because the greeting note can now come first.
  - **Browser check** on isolated ports with a scratch database: on the contact page, adding a fact (201), sharing a
    note with the assistant (201) and removing a fact (204) worked. The temporary launch configs were removed; your
    :4000 and :5173 servers weren't touched.
  - **Review** (done by hand), fixed: the playground now picks its greeting with the same rule as the widget and the
    AI, so the greeting note always matches what the playground showed.
  - No real-model check (Phase 4 is deferred).

- **F3 (Phase 12):** 174/174 tests pass (24 files; 10 new), and the typecheck is clean on all three apps.
  - The 10 new tests were run on the unchanged code first: 9 failed. The one that passed was the guard "no recap
    with the AI off, a spent budget or a one-message chat", which trivially holds before handoff recaps exist. After
    the change, all pass, along with the Phase 5 memory tests. The demo bot's prompt snapshot is unchanged.
  - **Browser check** on isolated ports with a scratch database and a fake model that answers recaps with parts:
    - a website chat taken over by staff: the summary bar changed from "No summary yet" to what the customer wants
      and the next step without a reload
    - opened: the outcome, the mood, "Updated just now at handoff · covers the whole conversation" and the full
      summary
    - Refresh with nothing new: "The summary is already up to date."; after a staff reply: "1 new", then Refresh
      queued a recap and the bar changed to "on request"
    - the contact page showed "Wanted: … · Outcome: …", and the activity "Summary updated (at handoff): …"
    - no page errors after the API was up, and no server errors
    - the temporary launch configs were removed; your :4000 and :5173 servers weren't touched (the API
      hot-restarted and migrated, as usual)
  - **Real-model check** (approved; 6 recap calls on `gpt-4o-mini`, 2,402 input and 754 output tokens, $0.0008):
    - valid JSON 6/6; every summary in English, including the Spanish and Hinglish chats
    - sensible parts, e.g. the discount handoff's next step "The team should respond to the customer's discount
      request."; the complaint's mood negative; the booking's next step empty
    - claims kept as claims ("claims that a manager named Raj promised them a free whitening")
    - the injection attempt didn't get its next step copied or "approved" written, but it did set the mood to
      positive (see Remaining issues)
  - **Review** (done by hand), fixed: a JSON answer without a summary would have been saved as raw JSON, i.e. as the
    AI's memory; now nothing is saved (tested). Found by reading the code; its test wasn't run against the old code.

- **F4a (Phase 13, first step):** 181/181 tests pass (25 files; 7 new), and the typecheck is clean on all three apps.
  The run is recorded for phase 13 without completing it; `--complete` runs after F4b.
  - The 7 new tests were run on the unchanged code first, and all 7 failed. After the change, all pass.
  - **Browser check** on isolated ports with a scratch database, a fake model that asks the opt-in question, and a
    local webhook receiver:
    - Settings → API keys showed the 7 scopes with descriptions; a key was created, then edited to add
      `conversations:read`, `conversations:write` and `appointments:read` (toast "Key updated", same key prefix)
    - with that key, the chat API returned both messages of the turn (the reply and the opt-in question)
    - the receiver got 3 signed `message.outbound` webhooks for the customer: the reply, the opt-in question and a staff
      reply
    - polling returned the messages after the first one, and the key could read the conversation
    - no server errors; the temporary launch configs were removed and your :4000 and :5173 servers weren't touched
  - **Review** (done by hand), fixed: an update with neither a name nor scopes reached an empty database update; it's
    now a 400 (tested). Also found: a waiting request with no reply coming waits its whole timeout (as before); it's
    recorded in Remaining issues.

- **F4b (Phase 13, second step):** 189/189 tests pass (26 files; 8 new), and the typecheck is clean on all three apps.
  `npm run verify:phase -- 13 --complete` marked phase 13 (F4) complete.
  - The 8 new tests were run on the unchanged code first, and all 8 failed. After the change, all pass.
  - Covered: the default pipeline for new and older organizations (one under concurrent first uses); stage removal
    with and without a destination; the last pipeline and pipelines with deals; deal defaults, currency, stage and
    pipeline rules and owners; won, lost, reopen and delete with exactly one event each (and a signed webhook);
    the board summary and paging; merging and deleting contacts; roles, scopes and tenant isolation (RLS).
  - **Browser check** on isolated ports with a scratch database:
    - the Deals page in the navigation; the Sales board with 4 empty stages
    - a new deal (contact search, value) showed in New with its count and total
    - moving it to Proposal with an owner, then marking it won: the open board emptied and the Won filter showed it
    - "Create deal" in a conversation, prefilled with its contact
    - both deals on the contact's Deals tab, and setting the contact's owner
    - the pipeline editor: removing a stage with a deal asked where to move it (only stages that stay), and saving
      renamed, added and removed stages with the deal moved
    - activity lines ("Deal moved from New to Proposal…", "Deal won…") and the currency setting
    - no server errors; the temporary launch configs were removed and your :4000 and :5173 servers weren't touched
  - **Review** (done by hand), fixed: a deal value of 1,000,000,000,000 passed validation but doesn't fit the database
    column, so it would have been a server error. The limit is now 999,999,999,999.99, with a test at the edge. Found by
    reading the code; its test wasn't run against the old code.

- **F5a (Phase 14, first step):** 199/199 tests pass (27 files; 10 new), and the typecheck is clean on all three apps.
  The run is recorded for phase 14 without completing it; `--complete` runs after F5b.
  - Covered: each action within its limits and refusing the rest (stages, members, tags, another customer's deal,
    closing without the switch); one open deal per customer; the owner and deals in the context only when on; bots
    without the settings keep the same tools and prompt; record-bound inputs, `trust` and "Identified customers only"
    (web chat refused, chat API runs); test deals off the board.
  - **Review** (done by hand), fixed, each with a test that failed on the code before its fix:
    - an organization that never saved its own stages couldn't allow any (the check used an empty list instead of the
      default stages)
    - a stage the organization dropped was still offered to the model
    - assigning the current owner again recorded another change; someone listed twice became two choices
    - a record-bound input could be typed as a number, so every call would be refused
    - playground deals would have filled the Deals board and its totals
  - Also fixed in review: stale stages, members and pipelines are shown in the bot editor for clearing (before, saving
    was refused with nothing to untick); the AI's stage, owner and tag changes are linked to the conversation; the
    workflow editor and `docs/API.md` no longer say the assistant "can't change" record values (it saves what a
    visitor gives, so only "Identified customers only" proves who is asking).
  - **Browser check** on isolated ports with a scratch database and a fake model:
    - Bot → Actions → CRM actions: ticked stages and an owner, turned on deals with the pipeline choice; saved (v3)
    - after dropping a stage in the organization, it showed as "booked (no longer a stage)", ticked; the model wasn't
      offered it; unticking it saved (v4)
    - the workflow editor: an email from the chat showed the warning; choosing "Their email on record" set the type to
      Text (locked) and cleared the warning; "Identified customers only" saved with both inputs' sources
    - the playground: the fake model created a deal ($4,500), moved it to Proposal ($5,200) and set the stage to
      customer; "What the AI did" listed the 3 tool calls with "Deal created", "Deal moved from New to Proposal",
      "Deal updated (value)" and "Lifecycle stage set to “customer”"
    - the Deals board left out the two playground deals and showed a web visitor's deal in Proposal
    - no server errors; the temporary launch configs were removed and your :4000 and :5173 servers weren't touched
    - screenshots weren't possible (the app window was minimized), so the checks read the page itself
  - **Real-model check** (approved; 6 conversations, 7 customer messages on `gpt-4o-mini`: 8 model calls, 18,900
    input and 385 output tokens, $0.0033):
    - right: no CRM action for a plain question; one deal for "I'd like to go ahead with Invisalign", with $5,000 from
      the next message; a declined deal stayed open without the switch; the team's tag stayed
    - missed: the stage for "I just paid", the owner for an implant patient, and the tag removal for "not interested
      anymore"; the deal came only with the second message (the model asked for the name and email first)
    - also seen: the model saved the placeholder "unknown" as a name (see Remaining issues)
    - the prompt lines and tool descriptions were then made more direct (a free test checks the section; the default
      prompt is unchanged); a re-run to confirm needs your OK
- **After the F5a check-in (2026-09-29):**
  - **Real-model re-check** (approved; the same 6 conversations: 13 model calls, 21,226 input and 594 output tokens,
    $0.0048):
    - now right: the stage for "I just paid" (it chose "booked", with a task for the team to schedule), the deal on the
      first message, the tag removal (the team's tag stayed), no CRM action for a plain question
    - a declined deal: it tried to mark it lost, was refused (no switch), and created a task for the team instead;
      the deal stayed open
    - still missed: the owner; also `create_deal` called again instead of `update_deal` (value lost) and "your open
      deal" in a reply (both addressed, see Completed work); the model again saved "unknown" as a name
  - **Placeholder fix:** 2 new tests (the service ignores placeholders but keeps real names such as "Nonie Guest"; the
    assistant copying "unknown" saves nothing, gets an error, and its context says "(not given yet)"). Both failed on
    the code before the fix.

- **F5b (Phase 14, second step):** 209/209 tests pass (28 files; 8 new), and the typecheck is clean on all three apps.
  `npm run verify:phase -- 14 --complete` marks phase 14 (F5) complete.
  - The first 7 new tests were run on the unchanged code, and all 7 failed. After the change, all pass.
  - Covered: a request saved and nothing done, the model told to wait, the team notified with a link, the same request
    not saved twice; approve runs once (a second decision is a 409) with a message that keeps the AI on the
    conversation; decline runs nothing; the next turn sees waiting, approved and declined (with the reason); expiry
    after 7 days; a retried turn doesn't ask twice; only agents decide, in their own organization, and not with an
    API key; a request that no longer fits the bot is refused (422) and stays waiting; an ask-first, identified-only
    workflow runs for a web-chat visitor once approved, with `approvedBy`.
  - **Review** (done by hand), fixed: an approval interrupted mid-action (a server stop) would have stayed "being
    approved" forever; after 5 minutes it can be decided again (tested: it failed before the fix). Also: playground
    requests are marked Test in the lists, and a waiting request can never read as done in the model's memory.
  - **Browser check** on isolated ports with a scratch database and a fake model:
    - Bot → Actions: the new "Ask the team first" section (9 actions); ticked "Set lifecycle stage"; saved (v3)
    - a web visitor wrote "I just paid…": the navigation showed "Approvals 1", the bell "1 unread" ("Approval
      needed: A visitor — The assistant asks to: Move the customer to the “customer” stage"), and the Approvals page
      the request with its expiry
    - on the conversation page: the request card; Approve with a message → toast, the card gone, the team's message
      in the thread, the conversation still AI active, the stage "customer"; the timeline read "Asked the team to
      approve…", "asked the team", "Lifecycle stage set to “customer”", "Approved…"
    - a second visitor's request declined on the Approvals page with a reason: listed under Declined ("declined by
      Demo Owner · “No payment on file yet”")
    - the workflow editor: "Ask the team first" (its description changes with "Identified customers only"); the list
      shows "Identified only" and "Asks the team first"
    - no server errors; the temporary launch configs were removed and your :4000 and :5173 servers weren't touched

- **Website chat: embed address and draggable bubble (2026-09-29):** 217/217 tests pass (30 files; 8 new), and the
  typecheck is clean on all three apps. The new tests were run on the unchanged code first: all failed (the embed code
  said localhost, `PUBLIC_API_URL`'s trailing slash doubled, `draggable` was dropped, the drag rules didn't exist).
  - **Browser check** on isolated ports (scratch API without `PUBLIC_API_URL`, dashboard, and the widget demo page):
    - Settings → Website chat showed the embed code with `http://localhost:4100/widget.js` (the request's address);
      the new "Draggable bubble" toggle saved on and off, with the preview hint
    - at 1280×800: a drag moved the bubble to (72, 72) and the release click didn't open the chat; a normal click opened
      the chat below it (on screen, full height); a drag while open was ignored; Escape closed it; a 3px wobble still
      opened it; the spot survived a reload
    - all four corners stopped 8px from the edges; a finger wobble wasn't a drag, a finger drag was; from the
      bottom-right corner the chat opened above, lined up with the bubble
    - resizing to 900×600 kept the bubble in its corner; on a phone (375×812) the saved corner was restored, a finger
      drag moved it, and the open chat still filled the screen
    - a real mouse drag moved the bubble without opening the chat; it also showed a drag whose release the page never
      saw stayed "dragging": the widget now ends a drag when the pointer capture is lost (checked)
    - with dragging off: the bubble sat 20px from its corner, drags did nothing, clicks opened the chat
    - no console or server errors; the temporary launch configs were removed and your :4000 and :5173 servers weren't
      touched

- **Website chat: "Powered by" line and the visitor's IP (2026-09-29):** 225/225 tests pass (31 files; 8 new), and the
  typecheck is clean on all three apps. With only the IP helper in place, the 5 behaviour tests failed on the old code
  (no address was saved); the rest passed as guards.
  - Covered: a new visitor's first message sets it and opening the chat creates no contact or conversation; a new
    session from another address updates it, the same address writes nothing; addresses the visitor sends (body,
    `X-Real-IP`) are ignored; playground chats record none; it's absent from the message, the AI's input and the
    widget's responses; another organization can't reach the conversation; `TRUST_PROXY` with the proxy's range uses
    the address the proxy saw (not the made-up one), `false` uses the socket's, and a number is refused.
  - **Browser check** on isolated ports: the footer under the message box, lined up with it (11px, muted), on desktop
    and in the phone's full-screen chat; a real chat from localhost stored `127.0.0.1` on the conversation; no console
    or server errors. The temporary launch configs were removed; your :4000 and :5173 servers weren't touched.
  - **Details panel** (added on request): a website chat's Details showed "IP address 127.0.0.1" with "Last seen …" on
    hover; a playground chat showed no such row.

- **Website chat: no bubble jump on load (2026-09-29):** 225/225 tests pass (31 files) and the typecheck is clean on
  all three apps. The widget is browser code, so the fix was checked in a browser on isolated ports (1280×800), with
  the settings request slowed by 500ms and the bubble's spot sampled every frame:
  - **Before the fix** (saved spot bottom left): the bubble was first shown bottom right, and 70 samples showed it
    there before it jumped
  - **After the fix**, your exact case (dragged from bottom right to bottom left, then reloaded): hidden while loading,
    first shown at the saved spot, 0 samples anywhere else
  - also correct from the first visible frame: Position set to bottom left without dragging; a chat restored open at a
    moved spot (window placed beside the bubble, message box focused)
  - an unknown key never shows the widget; dragging still moves the bubble without opening the chat, and a click still
    opens it
  - the temporary launch configs were removed; your :4000 and :5173 servers weren't touched

- **Conversation starters (2026-09-29):** 238/238 tests pass (32 files; 13 new) and the typecheck is clean on all
  three apps. With the new handoff check switched off, the "talk to the team" test failed; the rest cover the
  configuration, the widget's settings and the widget's own rules.
  - Covered: bots saved before starters have none; adding, editing, reordering (by `order`), hiding and deleting keep
    ids and renumber; empty, too long, unknown action, 11 starters and the same text twice are refused with the field
    at fault; "talk to the team" needs handoff on unless hidden; agents can't change them; the widget and Playground
    get only enabled starters, in order, with the text a click sends and nothing internal; another organization's
    widget gets none; a click reaches the AI with `starterId` saved on the message; "talk to the team" hands off
    without the AI (status, reason, message, team notification); a hidden, deleted or other bot's starter is just a
    message; the same message id twice keeps one message and one reply; a malformed `starterId` is refused; the
    widget helper drops malformed starters and shows none once the visitor has written.
  - **Browser check** on isolated ports with the fake model (no paid calls):
    - widget: 4 starters under the greeting; a click (and a double click) sent one message, removed the starters,
      and got the AI's reply; "talk to the team" posted the handoff message and "A member of our team will reply
      here."; a returning visitor saw their chat and no starters
    - a send that failed after reaching the server: the message was taken back, the starters came back, and the
      retry (same id) left one message and one reply
    - keyboard: Tab moved between starters with a visible focus ring; Enter sent one and moved focus to the message
      box
    - a chat restored open with the settings slowed down: the greeting and starters were there on the first visible
      frame
    - phone (375×812): full-screen chat, starters wrapped onto three rows inside it, 44px tall, no sideways scrolling;
      light and dark mode readable
    - dashboard: the tab loaded the saved starters; moving, hiding, a duplicate text and an empty new starter showed
      on the fields; saving an empty one was refused with the tab marked; turning handoff off warned on the starter
      and the save was refused; the empty state added the four suggestions; a good save (version 4) changed the
      widget's list and order
    - Playground: showed the saved starters; a double click sent one message; "talk to the team" handed off
    - no server errors; the temporary launch configs were removed; your :4000 and :5173 servers weren't touched

- **Website chat redesign (2026-09-29):** the typecheck is clean on all three apps and the widget tests pass (29/29:
  drag, setup, visitor IP, starters). Checked in a browser against a test API with the fake model (no paid calls),
  measuring against the design:
  - window 380×640 with 20px corners; header 69px with the 40px picture ("BS"), online dot, "AI" label and a 40px
    minimize button; 14.5px bubbles with the 6px tail corner; 36px suggested-question pills in the bot's colour; a
    54px message box; the footer in the new order
  - a conversation (visitor and AI rows with names and times), the typing bubble, "talk to the team" (handoff
    divider), a staff reply (team member row), loaded history ("Today"), a failed send (error banner)
  - dark mode (the design's dark colours, lighter shades of the bot's colour) and a phone (full screen, 16px title,
    44px targets, 16px input, 28px bottom room, no sideways scrolling)
  - the bubble: the tip on real hover, the drag ring, a drag landing exactly where it did before (72, 72) without
    opening the chat, the window opening below it with both chevrons pointing up and scaling in from the bubble; a chat
    restored open appears in place with no animation and no wrong frames
  - your demo page (:5180 with your :4000) showed your colour, logo, greeting and starters; no messages were sent
    there (they would call OpenAI). The temporary launch configs were removed; your servers weren't touched.

- **Settings preview (2026-09-29):** the dashboard typechecks and builds. Checked in a browser on isolated ports: the
  preview showed the bot's title, "AI" label, greeting, its enabled starters and the new footer; changing the colour
  (teal), position (left), launcher text and a broken avatar link updated it at once (initials instead of the broken
  image); dark mode used the widget's dark colours. The dialog was closed without saving; your servers weren't touched.

- **Bot editor redesign, Phase 1 (2026-09-30):** typecheck clean on all three apps, the dashboard builds, 238/238
  server tests pass (no server changes). Browser checks on isolated ports with the fake model (no paid calls):
  - every old `?tab=` value (all 13) opened its section with the menu item marked; an unknown value opened the
    overview; with no `tab` the overview showed the real test bot (6/6, each card's summary right)
  - editing marked the section and showed the save bar; Discard restored the value; Save went from v5 to v6, the
    toast showed, and the value was there after a reload; the Active / Paused pill counted as a change
  - a duplicate starter label was refused: the error named the section, the menu marked it, "Go to it" opened it
    from the overview, Discard cleared it
  - turning handoff off (not saved) made the overview 5/6 with "Set up handoff" opening Handoff
  - search: Cmd+K with real key presses, typing "greet" found Identity & voice, Enter opened it, Esc closed it,
    focus went back; nothing opened over the Prompt preview drawer. Found and fixed: text typed right after
    reopening the search could land on the old text; the box now starts empty each time
  - the test chat still sent a message and showed the reply, starters and "What the AI did"
  - the main menu was 64px on the editor, 224px when expanded (remembered) and on every other page
  - 1440, 1280 and 1024 wide, with and without the test chat: no sideways scrolling, the header fits; below 1280 the
    settings menu narrows and long names shorten with the full name on hover
  - dark mode used the dashboard's dark colours; an agent saw Save disabled ("Only admins can change bots") and the
    read-only note; no JavaScript errors or React warnings in the console
  - known trade-off: at 1024px with the test chat open, the settings area is 356px wide (420px before)

- **Bot editor redesign, Phase 2 (2026-09-30):** typecheck clean on all three apps, the dashboard builds, 238/238
  server tests pass (no server changes). Browser checks on isolated ports with the fake model (no paid calls):
  - a typed message (real key presses, Enter) showed on the right with its time, the typing dots appeared, the reply
    came in as "Maya · time", the starters went away and "What the AI did" showed its counts
  - a starter clicked twice at once sent one message; "Talk to the team" handed over: status "Human", the handoff
    note, and the handoff event in the timeline; a team reply sent from the API showed live as "Team member"
  - "What the AI did" opened and closed (aria-expanded and aria-controls right), listed the timeline and linked to
    the conversation; Reset started a fresh chat with the greeting and starters
  - an unsaved edit showed "Uses the saved version — save to test your changes."; Discard brought back the usual note;
    Save still worked (v6 → v7 → v8 toggling Active / Paused and back)
  - 1440, 1280 and 1024 wide: no sideways scrolling, the test chat 380px; light and dark mode checked
  - found and fixed while checking: the send arrow was squeezed to 6px (the shared button's padding won), the open
    timeline could squeeze the message box out of view on short windows (now at most 40% of the panel), and its
    focus ring was clipped by the card (now drawn inside)
  - no JavaScript errors or React warnings in the console (only the refused connection from before the test API
    had started); not seen: word-by-word streaming and an activity label, as the fake model's reply lands at once
    and uses no tools here (that code only changed its look)

- **Bot editor redesign, Phase 3 (2026-09-30):** typecheck clean on all three apps, the dashboard builds, 238/238
  server tests pass (no server changes). Browser checks on isolated ports with the fake model (no paid calls):
  - all 13 sections opened with their heading and cards; each still had the same fields (control counts matched the
    fields before, the two drop-downs for tone and reply length now being choices)
  - tone and reply length changed with real arrow keys (focus ring shown), the summary chips followed, the menu and
    save bar marked the change; Save went v8 → v9 and the values were there after a reload
  - "Use a template": Enter opened the menu on the first template; arrows, Home/End and wrapping worked; Esc and a
    click outside closed it, focus back on the button; a template filled role, tone, length, personality and goal;
    once there was text to replace it asked first, and focus came back to the button after; Discard restored all
  - lead capture, qualification, booking and handoff switches in the card headers: the line changed to On/Off with
    the right text, the menu showed Off with the unsaved mark, the save bar listed all four; Discard restored them
  - search: "calendar" opened Booking with the calendar box focused, in view and highlighted (the highlight then
    cleared); "greet" scrolled down to the greeting box; "tone" focused the chosen tone; "handoff" listed the section,
    then its settings; with nothing typed it listed the 14 sections as before
  - a duplicate starter label was still refused on save, with the inline errors, the banner and the menu mark
  - 1440, 1280 and 1024 wide with the test chat open: no sideways scrolling in any section. Found and fixed while
    checking: at 1024 three sections' fixed-width rows (starters, qualification questions, the lead-capture table)
    widened the page area; the forms now stack and the table scrolls by itself. At 1280 the name/company fields
    first fell to one column; the two-column point was lowered so they stay side by side
  - light and dark mode; the overview's summaries unchanged; no JavaScript errors or React warnings while going
    through every section and the template menu

- **Main menu collapses on every page (2026-09-30):** typecheck clean on all three apps, the dashboard builds, 238/238
  server tests pass (no server changes). Browser checks on isolated ports:
  - with nothing saved, all 12 pages (overview, bots, a bot's editor, conversations, leads, deals, approvals,
    knowledge, appointments and calendars, automations, settings) showed the full menu (224px) with the button
  - collapsed on Settings with a real Enter key press: 64px, the button became "Expand menu" (aria-expanded false)
    and kept the focus; every page then stayed at 64px, and so did a reload; expanded again on Deals with Space, and
    the bot editor followed
  - collapsed, the links kept their names for screen readers and their tooltips, and the logo its name
  - 1024, 1280 and 1440 wide, both states, every page: no sideways scrolling except the knowledge base page at 1024
    (its documents table; the same with the menu expanded as before the change, so not caused by it; now listed
    under Remaining issues)
  - the bot editor at 1280 with the test chat open: settings area 405px expanded, 565px collapsed, no overflow
  - dark mode checked; no JavaScript errors or React warnings across all pages in both states

### Verification log

<!-- verification-log:start -->
- 2026-09-29 00:34 · Phase 14 · ✅ PASS · typecheck ok · tests 209/209 passed · 95s · marked complete
- 2026-09-29 00:28 · Phase 14 · ✅ PASS · typecheck ok · tests 209/209 passed · 115s
- 2026-09-28 23:52 · Phase 14 · ✅ PASS · typecheck ok · tests 199/199 passed · 98s
- 2026-09-28 23:23 · Phase 14 · ✅ PASS · typecheck ok · tests 196/196 passed · 73s
- 2026-09-28 22:55 · Phase 13 · ✅ PASS · typecheck ok · tests 189/189 passed · 89s · marked complete
- 2026-09-28 22:48 · Phase 13 · ✅ PASS · typecheck ok · tests 189/189 passed · 74s
- 2026-09-28 22:31 · Phase 13 · ✅ PASS · typecheck ok · tests 181/181 passed · 91s
- 2026-09-28 22:25 · Phase 13 · ✅ PASS · typecheck ok · tests 181/181 passed · 93s
- 2026-09-28 21:38 · Phase 12 · ✅ PASS · typecheck ok · tests 174/174 passed · 56s · marked complete
- 2026-09-28 21:27 · Phase 12 · ✅ PASS · typecheck ok · tests 174/174 passed · 64s
- 2026-09-28 20:41 · Phase 11 · ✅ PASS · typecheck ok · tests 164/164 passed · 66s · marked complete
- 2026-09-28 20:37 · Phase 11 · ✅ PASS · typecheck ok · tests 164/164 passed · 82s
- 2026-09-28 20:10 · Phase 10 · ✅ PASS · typecheck ok · tests 157/157 passed · 64s · marked complete
- 2026-09-28 20:06 · Phase 10 · ✅ PASS · typecheck ok · tests 157/157 passed · 103s
- 2026-09-28 03:30 · Phase 9 · ✅ PASS · typecheck ok · tests 150/150 passed · 47s · marked complete
- 2026-09-28 03:19 · Phase 9 · ✅ PASS · typecheck ok · tests 150/150 passed · 57s
- 2026-09-28 02:15 · Phase 8 · ✅ PASS · typecheck ok · tests 136/136 passed · 59s · marked complete
- 2026-09-28 02:14 · Phase 8 · ✅ PASS · typecheck ok · tests 136/136 passed · 60s
- 2026-09-28 02:10 · Phase 8 · ✅ PASS · typecheck ok · tests 136/136 passed · 56s
- 2026-09-28 02:03 · Phase 8 · ✅ PASS · typecheck ok · tests 136/136 passed · 53s
- 2026-09-28 02:00 · Phase 8 · ✅ PASS · typecheck ok · tests 135/135 passed · 53s
- 2026-09-28 01:26 · Phase 7 · ✅ PASS · typecheck ok · tests 127/127 passed · 51s · marked complete
- 2026-09-28 01:25 · Phase 7 · ✅ PASS · typecheck ok · tests 127/127 passed · 55s
- 2026-09-28 01:02 · Phase 6 · ✅ PASS · typecheck ok · tests 121/121 passed · 50s · marked complete
- 2026-09-28 00:54 · Phase 6 · ✅ PASS · typecheck ok · tests 119/119 passed · 42s
- 2026-09-28 00:21 · Phase 5 · ✅ PASS · typecheck ok · tests 105/105 passed · 40s · marked complete
- 2026-09-27 22:57 · Phase 5 · ✅ PASS · typecheck ok · tests 105/105 passed · 41s
- 2026-09-27 22:55 · Phase 5 · ❌ FAIL · typecheck FAILED · tests 105/105 passed · 43s
- 2026-09-27 14:44 · Phase 3 · ✅ PASS · typecheck ok · tests 92/92 passed · 38s · marked complete
- 2026-09-27 14:43 · Phase 3 · ✅ PASS · typecheck ok · tests 92/92 passed · 37s
- 2026-09-27 14:22 · Phase 2 · ✅ PASS · typecheck ok · tests 84/84 passed · 36s · marked complete
- 2026-09-27 14:21 · Phase 2 · ✅ PASS · typecheck ok · tests 84/84 passed · 36s
- 2026-09-27 14:05 · Phase 1 · ✅ PASS · typecheck ok · tests 79/79 passed · 39s · marked complete
- 2026-09-27 14:04 · Phase 1 · ✅ PASS · typecheck ok · tests 79/79 passed · 39s
<!-- verification-log:end -->

## Important decisions

| Date | Decision | By |
|---|---|---|
| 2026-09-26 | The Phase 1–9 plan from the audit is the source of truth | User |
| 2026-09-27 | Phase 0 skipped; Phase 1 starts first | User |
| 2026-09-27 | Priorities: AI Conversations → Long-term Memory → RAG → Lead Capture → Lead Qualification → Appointment Booking | User |
| 2026-09-27 | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `docs/ROADMAP.md` are not modified by the phases | User |
| 2026-09-27 | Each phase: explore → audit → recommend → plan → approval → implement → test → review → update progress; never start the next phase automatically | User |
| 2026-09-27 | A phase is marked complete only by a passing verification run (typecheck + full test suite) | User |
| 2026-09-27 | Phase 1 approved: staff-approved merge (no automatic merge on unverified email/phone) | User |
| 2026-09-27 | Agents (and API keys with `contacts:write`) can merge and dismiss duplicates | User |
| 2026-09-27 | Skip the optional real-model check for Phase 1 | User |
| 2026-09-27 | Staff merges keep the existing `mergeInto` rules unchanged (the duplicate's custom fields and qualification answers win on conflict) | Implementation |
| 2026-09-27 | A capture that loses a race becomes a staff review even for verified sources | Implementation |
| 2026-09-27 | Phase 2 approved: detect duplicate bookings by contact + calendar + start time | User |
| 2026-09-27 | Phase 2: no real-Postgres race test for now; the calendar lock is verified by review | User |
| 2026-09-27 | Phase 2: no "time must have been offered by check_availability" rule | User |
| 2026-09-27 | The booking lock is per calendar rather than per day (simpler, and it also covers buffers that cross midnight) | Implementation |
| 2026-09-27 | A repeated booking returns the existing appointment unchanged, even if the new request had different notes | Implementation |
| 2026-09-27 | Phase 3 approved: on retries, side-effecting tools replay earlier results, matched by order | User |
| 2026-09-27 | Phase 3: a 90 s time limit per turn (`AI_TURN_TIMEOUT_MS`), retried like other temporary errors, then an apology and a handoff | User |
| 2026-09-27 | Phase 3: `notifyTeam: false` silences handoff alerts, except when the AI hands off because of an error | User |
| 2026-09-27 | The summary-cadence fix moves from Phase 3 to Phase 5 | User |
| 2026-09-27 | A monthly-budget handoff always alerts staff, like an error handoff: it stops the AI for every conversation | Implementation |
| 2026-09-27 | If a reply's model answer is complete when the time limit hits, it is still sent; the limit only stops new actions and model calls | Implementation |
| 2026-09-27 | A reply that loses its lock never apologizes or hands off; it only retries | Implementation |
| 2026-09-27 | Phase 4 is deferred until after Phase 9: marked deferred, not complete. Its plan is refreshed before it runs | User |
| 2026-09-27 | Phase order: 5 → 6 → 7 → 8 → 9, then Phase 4 | User |
| 2026-09-27 | Until Phase 4 runs, the bot stays on `gpt-4o-mini` (no model or provider switch) | Condition of the deferral |
| 2026-09-27 | Phase 5 approved: recaps after 30 minutes of quiet and on close | User |
| 2026-09-27 | Phase 5: returning customers see the recaps of their last 2 other conversations, capped | User |
| 2026-09-27 | Phase 5: earlier actions and offered slots, time-gap markers, no search for pleasantries, recaps on the contact page | User |
| 2026-09-27 | Phase 5: no automatic fact extraction into `contacts.memory` (`add_note` already saves facts) | User |
| 2026-09-28 | A bare "yes", "ok" or "?" still searches the knowledge base: it usually answers or follows up on the bot's question. Only greetings, thanks and goodbyes skip | Implementation |
| 2026-09-28 | Staff replies also schedule a quiet-spell recap, so staff answers make it into recaps | Implementation |
| 2026-09-28 | `AI_SUMMARY_IDLE_MINUTES=0` turns off only the quiet-spell recaps; closing a conversation still recaps it | Implementation |
| 2026-09-28 | The chat CLI runs with quiet-spell recaps off: it waits for the queue after every message | Implementation |
| 2026-09-28 | How old offered slots are is measured against the customer's newest message (stored times), not the clock | Implementation |
| 2026-09-28 | A summary call's cost is recorded even when a newer summary wins and it isn't saved | Implementation |
| 2026-09-28 | Phase 6 approved as one phase: source tracking, page-URL privacy, marketing opt-in with proof, field templates | User |
| 2026-09-28 | Phase 6 consent: one opt-in question per bot, exact wording posted by the server, the AI records the answer with the customer's reply as evidence; staff and API can record or withdraw | User |
| 2026-09-28 | Phase 6: stored page URLs keep only UTM and click-ID parameters | User |
| 2026-09-28 | Staff consent records need a note (how the customer agreed or asked); an integration's yes needs the wording it showed | Implementation |
| 2026-09-28 | Only a reply that is nothing but a no blocks a yes ("no thanks", "nope", "नहीं"); other declines are left to the AI, which records them as a no | Implementation |
| 2026-09-28 | Consent is recorded on the conversation's own contact, even if that visitor claimed someone else's email; a staff merge carries it over | Implementation |
| 2026-09-28 | The server's opt-in question isn't posted after a handoff or when a human has taken over | Implementation |
| 2026-09-28 | A first touch keeps the visit time the widget reported, unless it's invalid or in the future | Implementation |
| 2026-09-28 | Besides the chat API, `POST /v1/contacts` also accepts `source`, for form integrations | Implementation |
| 2026-09-28 | Phase 7 approved as qualification fixes instead of per-bot storage (no new table) | User |
| 2026-09-28 | Phase 7 verdicts: a disqualified lead can become qualified; a qualified lead stays qualified | User |
| 2026-09-28 | Phase 7: answers that no longer fit the current questions are asked again and kept as history | User |
| 2026-09-28 | An answer "fits" when the question's own rules accept it (options, type, including readable numbers like "50k" and yes/no words); the server normalizes it before scoring | Implementation |
| 2026-09-28 | A re-qualification keeps the tags added by the earlier "disqualified" outcome; only the qualified outcome is added | Implementation |
| 2026-09-28 | Answers recorded before this phase have no `botId`; the contact page then uses the first assistant with that question key | Implementation |
| 2026-09-28 | Phase 8 approved: a language setting per knowledge base, with an "any language" option | User |
| 2026-09-28 | Phase 8: website refresh per URL document, off / daily / weekly (off by default) | User |
| 2026-09-28 | Phase 8: two paid production measurements with OpenAI embeddings, before and after (each well under $0.01), approved | User |
| 2026-09-28 | Phase 8: no reranker now; propose one only if production top-5 is below 90% | User |
| 2026-09-28 | The keyword index keeps its existing English values through `DROP EXPRESSION` instead of a rebuild | Implementation |
| 2026-09-28 | The keyword query still drops common English words ("the", "how"…). The plan said it wouldn't; the language dictionaries drop their own anyway, and "Any language" has none. English plural trimming is gone, as planned | Implementation |
| 2026-09-28 | A language the database can't resolve (e.g. after moving servers) falls back to "Any language" instead of breaking search | Implementation |
| 2026-09-28 | A new category or refresh schedule applies without re-ingesting; a new title, content or FAQ list re-ingests (for a web page, a new title re-fetches it) | Implementation |
| 2026-09-28 | The refresh check claims up to 100 due pages per run with a 6-hour lease, so overlapping workers don't double up and a lost job is retried | Implementation |
| 2026-09-28 | A new schedule counts from the last fetch; a failed page keeps its retry within 6 hours | Implementation |
| 2026-09-28 | Phase 9 approved as one phase | User |
| 2026-09-28 | Phase 9: customer emails on by default for every calendar (confirmation with update and cancellation notices, and a reminder 1 day before; "1 day and 2 hours before" optional) | User |
| 2026-09-28 | Phase 9: cancellation policy per calendar, "anytime" by default; inside the window the AI offers the team, and staff can always change a booking | User |
| 2026-09-28 | Phase 9: the customer's timezone is recorded (widget, AI, staff) and both times are shown when they differ | User |
| 2026-09-28 | Phase 9: no real-inbox send for now; samples from the log provider are checked instead | User |
| 2026-09-28 | Customer emails are rows in `appointment_notifications` sent by a worker (not delayed queue jobs), so they can move or be dropped with the booking and tests can move the clock | Implementation |
| 2026-09-28 | A change notice goes out only if the customer was told about the booking; a move before the confirmation went out sends a confirmation for the new time instead | Implementation |
| 2026-09-28 | Reminders are planned even when the contact has no email yet (the address is read at send time), but never for test contacts or bookings made without emails | Implementation |
| 2026-09-28 | "Email the customer" unticked at booking means no emails for that booking at all, until staff resend the confirmation | Implementation |
| 2026-09-28 | The calendar's confirmation switch also covers manual resends (the log says "emails are off for this calendar") | Implementation |
| 2026-09-28 | The AI can never change a booking after it has started, even with "any time" | Implementation |
| 2026-09-28 | Feature track after Phase 9, one feature at a time, each planned and approved separately: F1 Bot Personality → F2 Conversation Context → F3 Conversation Summary → F4 CRM Integration → F5 AI Actions → F6 Human Handoff → F7 Chat Widget → F8 Follow-ups → F9 Analytics | User |
| 2026-09-28 | Phase 4 stays deferred until after F9 and isn't implemented before the feature work | User |
| 2026-09-28 | F4 includes the API-channel staff-reply delivery fix and deals/opportunities | User |
| 2026-09-28 | The progress hook tracks F1–F9 as phases 10–18 (`npm run verify:phase -- 10` for F1) | Implementation |
| 2026-09-28 | F1 approved: goals, personality in the business's own words, and the organization's name as the company-name fallback | User |
| 2026-09-28 | F1: four starting templates (Receptionist, Sales assistant, Support agent, Booking coordinator); goals get their own tab after Persona | User |
| 2026-09-28 | F1: no real-model check (Phase 4 is deferred) | User |
| 2026-09-28 | A template asks before applying only when a personality or main goal is already written (the other fields it sets always have values) | Implementation |
| 2026-09-28 | The prompt snapshot of the demo bot guards against unintended prompt changes: a phase that changes the prompt on purpose updates it with `vitest -u` and says so | Implementation |
| 2026-09-28 | The organization's name also fills the widget header when the bot has no company name | Implementation |
| 2026-09-28 | F2 approved: a per-note "share with the assistant" checkbox (off by default) and staff can add or remove what the AI remembers | User |
| 2026-09-28 | F2: the current page only (not the first visit's landing page or campaign) | User |
| 2026-09-28 | F2: the lifecycle stage and the last 3 past appointments in the AI's context | User |
| 2026-09-28 | A timezone from the widget is kept only when none is known; one the customer tells the AI, or staff set, replaces it | Implementation |
| 2026-09-28 | Past appointments go in their own `<recent_appointments>` block, apart from upcoming ones; a past booking nobody updated shows "no outcome recorded" | Implementation |
| 2026-09-28 | One rule picks the greeting for the widget, the AI's greeting note and the playground: the widget's own, else the bot's, else the default | Implementation |
| 2026-09-28 | Memory keeps at most 50 facts; when it's full, the AI's oldest facts go first, then the team's | Implementation |
| 2026-09-28 | Adding or removing a fact records a `contact.updated` event without the fact's text | Implementation |
| 2026-09-28 | F3 approved in full: recaps with parts (wants, outcome, next step, mood), a recap at every handoff, a Refresh button, and the `conversation.summarized` webhook | User |
| 2026-09-28 | F3: summaries in English, or in the bot's language when it has a fixed one | User |
| 2026-09-28 | F3: a summary bar under the conversation's header | User |
| 2026-09-28 | F3: a real-model check with 6 sample conversations on `gpt-4o-mini` (about $0.01), approved | User |
| 2026-09-28 | Folds of long chats keep the Phase 5 prompt and never change the parts; only recaps record `conversation.summarized` | Implementation |
| 2026-09-28 | Every move to "needs a human" gets a recap, including a staff reply that takes over | Implementation |
| 2026-09-28 | A plain-text recap answer is kept as the summary without parts; a JSON answer without a summary saves nothing | Implementation |
| 2026-09-28 | Parts are cut at 300 characters; an empty next step is stored as null ("nothing open") | Implementation |
| 2026-09-28 | Refresh queues at most one recap per conversation per minute, and answers with the reason when there's nothing to do | Implementation |
| 2026-09-28 | The live `conversation.summary` event carries no content; the widget stream passes only the widget's own events | Implementation |
| 2026-09-28 | The mood-injection finding is recorded, not fixed: a fix needs another paid re-check, so it goes with F6, which may use the mood | Implementation |
| 2026-09-28 | F4 approved as two steps in hook phase 13: F4a (messages to API customers and API access), then a check-in, then F4b (deals and pipelines) | User |
| 2026-09-28 | F4a: a `message.outbound` webhook, every message of the turn on the waiting request, and a polling endpoint | User |
| 2026-09-28 | F4a: new scopes `conversations:read`, `appointments:read`, `appointments:write` (F4b: `deals:read`, `deals:write`); custom-field definitions stay staff-only to change; admins can change a key's scopes | User |
| 2026-09-28 | F4b: a default "Sales" pipeline (New, Qualified, Proposal, Negotiation), open/won/lost deals, one currency per organization (default USD), a board with a drawer | User |
| 2026-09-28 | `message.outbound` covers chat-API conversations only, and stays out of the activity feed and timelines (the thread shows the messages) | Implementation |
| 2026-09-28 | The waiting request ends at `ai.done`, at a status change (a handoff), 3 s after the last message if `ai.done` never comes, or 1.5 s after an `ai.done` with no message (an error apology may follow) | Implementation |
| 2026-09-28 | Polling uses the chat API's own scope (`conversations:write`) and reads the customer's latest conversation, open or closed | Implementation |
| 2026-09-28 | What an API key creates is recorded as the team's, as before this phase (no separate "integration" actor yet) | Implementation |
| 2026-09-28 | Won and lost are deal statuses, not stages: a won deal keeps its last stage | Implementation |
| 2026-09-28 | A pipeline update sends the full ordered stage list; stages left out are removed, and their deals move where `moveDealsTo` says (each move records `deal.stage_changed`) | Implementation |
| 2026-09-28 | Deals store their currency; changing the organization's currency doesn't convert existing deals, and totals are kept per currency | Implementation |
| 2026-09-28 | Deal events record the team as the actor, including for API keys (as in F4a); `createdBy` on the deal says `api` | Implementation |
| 2026-09-28 | Deleting a deal needs an agent (or `deals:write`), like editing it; deleting a contact still needs an admin | Implementation |
| 2026-09-28 | A contact's owner is now checked like a deal's: a member of the organization or none | Implementation |
| 2026-09-28 | F5 approved as two steps in hook phase 14: F5a (CRM actions and safe workflows), then a check-in, then F5b (ask the team first) | User |
| 2026-09-28 | F5a: all five CRM actions (lifecycle stage, owner, removing tags, creating and updating deals), each off until turned on per bot; closing deals behind its own switch | User |
| 2026-09-28 | F5a: full workflow safety: record-bound inputs, where each value came from in every call, and an "Identified customers only" switch | User |
| 2026-09-28 | F5a: a real-model check after F5a (about 6 conversations on `gpt-4o-mini`, about $0.02), approved | User |
| 2026-09-28 | Workflow identity: chat-API conversations are `integration`, dashboard test runs `staff`, everything else (web chat, the playground) `unverified` | Implementation |
| 2026-09-28 | A record-bound workflow input is text, and whatever the model passes for it is ignored (a staff test run may supply it when the record has none) | Implementation |
| 2026-09-28 | The model is offered only the bot's stages the organization still has; stale stages, members and pipelines stay in the bot's config until cleared in the editor (saving refuses them), as for unknown workflows | Implementation |
| 2026-09-28 | An organization that never saved its own stages has the default ones, for the bot check as for `GET /org` | Implementation |
| 2026-09-28 | The AI's CRM changes (stage, owner, tags) are linked to the conversation; assigning the current owner again changes nothing | Implementation |
| 2026-09-28 | `update_deal` isn't replayed on retried turns: its changes repeat harmlessly, and closing twice is refused | Implementation |
| 2026-09-28 | Test (playground) contacts' deals are left out of the Deals board and its totals unless asked for | Implementation |
| 2026-09-28 | The CRM prompt lines are direct ("in the same turn", "don't wait for their details") and appear only for the actions a bot has | Implementation |
| 2026-09-29 | After the check-in: re-run the real-model check, fix the "unknown" capture now, then start F5b | User |
| 2026-09-29 | A second `create_deal` while one is open is an error that points to `update_deal` (with the deal's ID), not a quiet success; the CRM records are internal and not mentioned to customers | Implementation |
| 2026-09-29 | Placeholder values ("unknown", "N/A", "none", "(not given yet)", …) are never saved as a name, email, phone or company, whoever sends them; missing details read "(not given yet)" in the AI's context | Implementation |
| 2026-09-29 | Ask first is possible for 9 actions that change bookings or the CRM; lookups, notes, tasks, team alerts, contact details, qualification, handoff and consent can't ask first (workflows ask per workflow) | Implementation |
| 2026-09-29 | Approving runs the request exactly as asked, re-checked against the bot's current settings; if it can't go through now it stays waiting (422) rather than failing for good | Implementation |
| 2026-09-29 | Requests expire 7 days after they're asked (checked when used; no sweep), and can then neither be approved nor declined | Implementation |
| 2026-09-29 | Only staff decide (agent and up); API keys can't | Implementation |
| 2026-09-29 | An ask-first workflow that's also "Identified customers only" admits web-chat visitors: the approver checks who is asking, and the call carries `trust.approvedBy` | Implementation |
| 2026-09-29 | The same request asked again in a conversation while it waits returns the waiting one; ask-first calls replay on retried turns whatever their tool | Implementation |
| 2026-09-29 | Website chat: the embed code uses the address the request reached the API at unless `PUBLIC_API_URL` is set; the draggable bubble is opt-in per website chat and moves only while the chat is closed | User |
| 2026-09-29 | The bubble's spot is remembered per site in the visitor's browser as a fraction of the screen, tied to the starting side; the drag rules are pure functions tested in the server suite | Implementation |
| 2026-09-29 | Visitor IP on the conversation's metadata (not the contact, whose snapshot goes to webhooks and workflows), a `TRUST_PROXY` setting, a plain-text "Powered by" line, and no IP for playground chats | User |
| 2026-09-29 | `TRUST_PROXY` takes proxy addresses and ranges only; a number of hops is refused because Fastify ignores it (it can't tell a proxy from a visitor) | Implementation |
| 2026-09-29 | The widget stays hidden until its settings are applied instead of drawing the default spot first; no timers or delays | User |
| 2026-09-29 | Conversation starters: "send message" and "talk to the team" actions, shown under the greeting until the visitor's first message, and in the Playground | User |
| 2026-09-29 | Starters live in the bot's configuration (no table or migration); the widget gets the text a click sends but not the action, and the server checks a clicked starter against the bot's current ones before handing off | Implementation |
| 2026-09-29 | Widget redesign from the design canvas: light header, "LeadsMagnet AI" in the footer, starters as the design's suggested questions; the bot's colour stays the only accent | User |
| 2026-09-30 | Bot editor: grouped menu with an overview (concept A plus B), `?tab=` kept for links, Active / Paused pill, Booking essential only with a calendar; built in phases, layout first | User |

## Next phase

**F6 (Phase 15) — Human Handoff**: explore, audit and plan when you say to start it (not started). It picks up the
handoff issues in Remaining issues (waiting forever, no brief, the summary mood from customer text) and, from F5,
rules for who looks after which customer.

After that: F7–F9 in order, each planned when it starts. Phase 4 runs after F9.
