# HTTP API reference (Phase 1)

Base URL: your API's address (`http://localhost:4000` locally). JSON everywhere. Errors: `{ "error": { "code", "message", "details"? } }`
(`details` for validation errors is `[{ path, message }]`).

## Authentication

| Caller | Header | Notes |
|---|---|---|
| Dashboard user | `Authorization: Bearer <jwt>` (+ optional `x-org-id: <uuid>`) | JWT from `/v1/auth/login` or `/v1/auth/signup` (local mode) or a Supabase access token (supabase mode). Without `x-org-id` the user's first org is used. |
| Integration (n8n, other apps) | `Authorization: Bearer sk_…` | Org API key. Scopes: `conversations:read`, `conversations:write`, `contacts:read`, `contacts:write`, `appointments:read`, `appointments:write`, `deals:read`, `deals:write`, `knowledge:write` (see API key access below). |
| Website widget / playground | `Authorization: Bearer <widget token>` | From `POST /widget/v1/sessions` or `POST /v1/bots/:id/playground`. |

Query-string booleans accept `true|false|1|0`. `PATCH` endpoints change only the fields you send.

Roles: `owner` > `admin` > `agent` > `viewer`. Writes to configuration need `admin`; replying/booking needs `agent`.

API key access (a key reaches only what its scopes allow; everything else is staff-only):

| Scope | Endpoints |
|---|---|
| `contacts:read` | Contacts, their consents, appointments, events and duplicate reviews; tags (`GET /v1/tags`); notes (`GET`); tasks (`GET /v1/tasks`); custom-field definitions (`GET /v1/custom-fields`) |
| `contacts:write` | Create, update and merge contacts; tags on a contact; consents; memory; notes (`POST`); tasks (`POST`, `PATCH`) |
| `conversations:read` | `GET /v1/conversations`, `/:id` (with the summary and its parts), `/:id/messages`, `/:id/timeline`; `GET /v1/contacts/:id/conversations` |
| `conversations:write` | The chat API: `POST` and `GET /v1/channels/api/messages` |
| `appointments:read` | `GET /v1/calendars`, `/:id`, `/:id/availability`; `GET /v1/appointments`, `/:id/notifications` |
| `appointments:write` | Book, reschedule, cancel, set the outcome and resend the confirmation (the same customer-email rules as staff bookings) |
| `deals:read` | `GET /v1/pipelines`; `GET /v1/deals`, `/summary`, `/:id`; `GET /v1/contacts/:id/deals` |
| `deals:write` | Create, update (move, win, lose, reopen) and delete deals |
| `knowledge:write` | Add documents to knowledge bases |

Staff-only: deleting contacts and tags, changing custom-field definitions, calendars and pipelines, qualification resets, replying as the team or changing a conversation's status, AI runs, bots, knowledge-base settings, webhooks, workflows, members, API keys and organization settings.

## Auth
- `POST /v1/auth/signup` `{ email, password, name?, organizationName, timezone? }` → `201 { token, user, organization }`
- `POST /v1/auth/login` `{ email, password }` → `{ token, user, memberships: [{ organizationId, role, organizationName }] }`
- `GET /v1/me` → `{ user, memberships, currentOrganizationId, role, authMode }`

## Organization
- `GET /v1/org` → `{ id, name, slug, timezone, aiEnabled, monthlyAiBudgetUsd, settings: { notificationEmails[], lifecycleStages[], defaultCountry, currency?, teamHours } }` — `currency` (ISO 4217) is absent until set, which means USD; `teamHours` is `{ enabled, weekly: { mon..sun: [{ start: "HH:mm", end: "HH:mm" }] } }` in the organization's timezone (off = the team is always around)
- `PATCH /v1/org` `{ name?, timezone?, aiEnabled?, monthlyAiBudgetUsd?, settings?: { notificationEmails?, lifecycleStages?, defaultCountry?, currency?, teamHours? } }` — `currency` must be an ISO 4217 code (e.g. `USD`, `EUR`, `INR`; any case), else 400; new deals use it
- `GET /v1/members` · `POST /v1/members { email, role: admin|agent|viewer, name?, password? }` · `PATCH /v1/members/:userId { role }` · `DELETE /v1/members/:userId`
- `GET /v1/api-keys` · `POST /v1/api-keys { name, scopes[] }` → includes plaintext `key` once · `PATCH /v1/api-keys/:id { name?, scopes? }` (a revoked key can't change; the new scopes apply on the key's next request) · `DELETE /v1/api-keys/:id`
- `GET /v1/notifications?unreadOnly=` → `[{ id, type, title, body, link, readAt, createdAt }]` · `POST /v1/notifications/read { ids: [...] | "all" }` — the organization's notifications plus the member's own; `readAt` is when this member read it (each member reads their own copy)
- `GET /v1/events?contactId=&limit=` → activity feed `[{ id, type, actor, contactId, contactName, conversationId, payload, createdAt }]`
- `GET /v1/usage` → `{ since, ai: { runs, costUsd, inputTokens, outputTokens, cacheReadTokens }, conversations: { total, handedOff }, leads: { captured, qualified }, appointmentsBookedByAi }`

## Bots (AI agents)
- `GET /v1/bots` · `GET /v1/bots/:id` → `BotView`
- `POST /v1/bots { name, model?, effort?, maxOutputTokens?, config?, knowledgeBaseIds? }`
- `PATCH /v1/bots/:id { name?, isActive?, model?, effort?, maxOutputTokens?, config?, knowledgeBaseIds? }` — each top-level `config` section given replaces that section; omitted sections are kept. Bumps `version`.
- `DELETE /v1/bots/:id`
- `GET /v1/bots/:id/preview` → `{ provider, model, reasoningEffort, system, tools: [{ name, description, inputSchema }] }` (exact prompt the model sees and the model that will answer)
- Personality: `goals` come first in the prompt's goals, ahead of the built-in ones for enabled features, with an instruction to pursue them without pressure; `persona.personality` is added under the tone; an empty `persona.companyName` means the organization's name (in the prompt and the widget's `companyName`). Empty extra goals are dropped.
- CRM actions (each off until set): `actions.lifecycleStages` — stages the assistant may set (`set_lifecycle_stage`; must be the organization's own); `actions.owners` — team members it may make a contact's owner (`assign_owner`; it sees names only; must be members); `actions.removeTags` — `remove_tags` for tags in `allowedTags`, or with no list only tags the assistant added; `actions.deals` — `create_deal` / `update_deal` in `pipelineId` (null = the first pipeline; one open deal per contact), with `canClose` needed to mark deals won or lost. Bots without these settings keep the same tools and prompt. Changes the assistant makes are recorded with actor `ai`.
- Ask the team first: `actions.askFirst` lists actions that wait for the team's approval instead of happening at once — any of `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `add_tags`, `remove_tags`, `set_lifecycle_stage`, `assign_owner`, `create_deal`, `update_deal` (workflows ask per workflow: `askFirst` on the workflow). Such a call is saved as a request (see Approvals); the assistant is told it's waiting and tells the customer a team member will confirm.
- `GET /v1/ai/config` → `{ provider, model, reasoningEffort, utilityModel, utilityReasoningEffort, pricing: { model, utilityModel }, reasoningEfforts }` — the server's LLM configuration
- `POST /v1/bots/:id/playground` → `{ token, visitorId, greeting, botName, starters }` — use with the `/widget/v1` endpoints; `starters` as in the widget's config
- Conversation starters: `conversationStarters` lists up to 10 quick options the website chat shows under its greeting until the visitor writes. Each has an `id` (assigned when missing, kept on edits), a `label` (1–60 characters, one line), a `message` (up to 500 characters; empty sends the label), an `action` (`message`: the click sends the message and the AI answers it as usual; `handoff`: it also hands the chat to the team without asking the AI, like a handoff keyword), `enabled`, and `order` (the list is sorted by it and renumbered from 0 on every save). Labels must differ (ignoring case), and an enabled `handoff` starter needs `handoff.enabled`. Saving the list replaces it: leave one out to delete it.

`BotView = { id, name, isActive, version, model: string|null, effort: low|medium|high|null, maxOutputTokens, knowledgeBaseIds[], config }` — `model`/`effort` are per-bot overrides; `null` (the default) follows the server's `LLM_MODEL` / `LLM_REASONING_EFFORT`. Send `null` to clear an override.

`config` sections (all fields have defaults):
```jsonc
{
  "persona": { "assistantName", "companyName", "role", "tone": "friendly|professional|casual|enthusiastic|empathetic",
               "responseLength": "short|medium|detailed", "language": "auto|<name>", "useEmojis": false, "greeting",
               "personality": "the voice in your own words, up to 600 characters (adds to the tone)" },
  "goals": { "primary": "one sentence, up to 300 characters", "secondary": ["up to 5, 200 characters each"] },
  "instructions": "free-text custom instructions",
  "business": { "description", "services", "hours", "location", "website", "phone", "email", "extraFacts" },
  "leadCapture": { "enabled": true, "fields": [{ "field": "name|email|phone|company|<customFieldKey>", "required": true,
                   "timing": "early|before_booking|natural" }], "consentNotice": "", "marketingOptIn": "" },
  "qualification": { "enabled": false,
     "questions": [{ "key": "budget", "question": "...", "type": "text|number|boolean|select|multi_select|date",
                     "options": [], "required": true, "saveToCustomField": null }],
     "rules": [{ "questionKey": "budget", "operator": "equals|not_equals|in|not_in|gt|gte|lt|lte|contains|answered",
                 "value": 10000, "points": 40, "disqualify": false }],
     "thresholds": { "hot": 70, "warm": 40 }, "qualifyAt": 50,
     "onQualified": { "tags": [], "lifecycleStage": "qualified", "notifyTeam": true },
     "onDisqualified": { "tags": [], "lifecycleStage": "unqualified", "notifyTeam": false },
     "qualifiedNextStep": "offer_booking|collect_contact|handoff|none", "disqualifiedMessage": "" },
  "booking": { "enabled": false, "calendarId": null, "appointmentTitle": "Consultation",
               "requiredFields": ["name", "email"], "requireQualification": false, "allowReschedule": true, "allowCancel": true },
  "handoff": { "enabled": true, "keywords": ["talk to a human", ...], "message": "...", "notifyTeam": true,
                "waitMinutes": 0, "fallback": "keep_waiting|resume_ai|ask_contact_details", "respectTeamHours": false, "awayMessage": "..." },
  "guardrails": { "stayOnTopic": true, "forbiddenTopics": [], "unknownAnswer": "offer_handoff|collect_contact|say_dont_know",
                  "maxAiRepliesPerConversation": 60 },
  "actions": { "disabledTools": [], "allowedTags": [], "allowCreateTags": false, "workflowKeys": [],
               "lifecycleStages": [], "owners": [], "removeTags": false,
               "deals": { "enabled": false, "pipelineId": null, "canClose": false }, "askFirst": [] },
  "conversationStarters": [{ "id": "uuid", "label": "Book an appointment", "message": "I'd like to book an appointment.",
                             "action": "message|handoff", "enabled": true, "order": 0 }]
}
```

## Channels
- `GET /v1/channels` → `[{ id, channel: webchat|playground|api, name, publicKey, botId, status, config: { allowedOrigins[], greeting, theme: { primaryColor, position, title, subtitle, avatarUrl, launcherText, draggable } }, embedSnippet }]`
  - `embedSnippet` loads `<api>/widget.js`, where `<api>` is `PUBLIC_API_URL` when set, else the address the request reached the API at (so it's right locally, on staging and in production). Every channel response carries it.
  - `theme.draggable` (default off): visitors can drag the chat bubble anywhere on the page while the chat is closed, and their browser remembers the spot; `position` is where it starts. The chat window opens where there's room; on phones the open chat stays full screen.
- `POST /v1/channels/webchat { name, botId?, status?, config? }` · `PATCH /v1/channels/:id` (send `""` or `null` for a theme field to clear it) · `POST /v1/channels/:id/rotate-key` · `DELETE /v1/channels/:id`

## Contacts / leads (CRM)
- `GET /v1/contacts?search=&lifecycleStage=&leadTier=hot|warm|cold&qualificationStatus=&tagId=&utmSource=&utmMedium=&utmCampaign=&marketingConsent=granted|declined|none&leadsOnly=true&includeTest=&limit=&offset=` → `{ items: (Contact & { hasPendingMerge })[], total }` — `leadsOnly` also includes visitors whose email/phone is waiting for a duplicate review; `marketingConsent=declined` covers declines and withdrawals, `none` never answered
- `GET /v1/contacts/source-options` → `{ utmSource: [], utmMedium: [], utmCampaign: [] }` — the values in use, for filters
- `POST /v1/contacts { ...ContactInput, source?: FirstTouch }` · `GET /v1/contacts/:id` · `PATCH /v1/contacts/:id` · `DELETE /v1/contacts/:id` — a contact created by staff has `sourceChannel: null`; one created with an API key has `api`
  - body: `{ firstName?, lastName?, email?, phone?, company?, lifecycleStage?, customFields?, ownerUserId?, timezone? }` — `timezone` is an IANA name (e.g. `America/Vancouver`) or `null`; anything else is a 400. `ownerUserId` must be a member of the organization (else 400), or `null`
- `Contact = { id, name, firstName, lastName, email, phone, company, timezone, sourceChannel, lifecycleStage, leadScore, leadTier, qualificationStatus: not_started|in_progress|qualified|disqualified, qualification: { [key]: { value, answeredAt, botId? } }, customFields, memory: [{ id, text, source: ai|user, createdAt }], firstTouch: FirstTouch | null, consent: { marketing?: { granted, at, source: chat|staff|api, textVersion } }, tags: [{ id, name, color }], leadCapturedAt, lastActivityAt, createdAt }`
- `FirstTouch = { landingPage?, referrer?, utmSource?, utmMedium?, utmCampaign?, utmTerm?, utmContent?, gclid?, fbclid?, msclkid?, at? }` — where the lead first came from, stored once and never overwritten (a merge keeps the earlier one). URLs are kept without their query strings.
- Consent (history is append-only; a change of mind is a new record):
  - `GET /v1/contacts/:id/consents` → `[{ id, purpose: marketing, granted, text, textVersion, source, conversationId, requestMessageId, evidenceMessageId, note, actorUserId, createdAt }]`, newest first. `text` is the exact wording shown; `evidenceMessageId` is the customer's message that answered (in a chat).
  - `POST /v1/contacts/:id/consents { purpose: "marketing", granted, text?, note? }` → 201 with the record. Staff must give a `note` (how the customer agreed or asked); an API key must give `text` for a grant (the wording agreed to). A `contact.consent_updated` event follows.
- `POST /v1/contacts/:id/qualification/reset`
- Qualification verdicts: a disqualified lead becomes qualified as soon as their answers qualify (the qualified outcome and `lead.qualified` follow once); a qualified lead stays qualified until reset. Only answers that fit the bot's current questions count; one that no longer fits (edited options or type, another bot's differently-asked question) is asked again but stays stored. `botId` on an answer is the assistant that asked it.
- `GET /v1/contacts/:id/appointments` · `GET /v1/contacts/:id/events` · `GET /v1/contacts/:id/conversations`
- Duplicate reviews. An email or phone captured by the AI in a chat that already belongs to another contact is never merged
  automatically (anyone can type someone else's email): it is kept as a pending review, and a `contact.duplicate_detected`
  event is emitted. While pending, the AI treats the value as the visitor's own in their conversation and never sees the
  other contact. Details sent by an integration (`contact` in the public chat API) are trusted and merge as before.
  - `GET /v1/contacts/:id/merge-candidates` → `[{ id, field: email|phone, value, status, conversationId, createdAt, claimant: ContactSummary, existing: ContactSummary }]` — pending reviews involving the contact, either side; `ContactSummary = { id, name, email, phone, isTest, createdAt }`
  - `POST /v1/contacts/:id/merge { intoContactId }` → the surviving `Contact`. Moves identities, conversations, appointments, notes, tasks, tags and consent history; keeps the earlier first touch; settles reviews between the two. Test and real contacts can't be merged (400); an already-merged contact returns 409
  - `POST /v1/merge-candidates/:id/dismiss` — "not the same person"; the claimed value stops counting as the visitor's
  - Access: reading needs `viewer` or `contacts:read`; merge and dismiss need `agent` or `contacts:write`
- Tags: `GET /v1/tags` · `POST /v1/tags { name, color? }` · `DELETE /v1/tags/:id` · `POST /v1/contacts/:id/tags { tags: [names] }` · `DELETE /v1/contacts/:id/tags/:tagId` (records `contact.untagged { tags }`)
- Notes: `GET /v1/contacts/:id/notes` · `POST /v1/contacts/:id/notes { body, shareWithAssistant?: false }` — notes are internal; `shareWithAssistant: true` also adds the note to what the AI remembers (as a team fact)
- What the AI remembers (agent+, or an API key with `contacts:write`): `POST /v1/contacts/:id/memory { text }` (1–500 characters) → `201 { id, text, source: "user", createdAt }` · `DELETE /v1/contacts/:id/memory/:factId` → `204` (404 if unknown). Each turn the AI sees up to 15 facts: the team's (`source: user`) first and marked as such, then its own latest. At most 50 are kept; the AI's oldest go first.
- Tasks: `GET /v1/tasks?status=&contactId=` · `POST /v1/tasks { title, description?, contactId?, dueAt?, priority? }` · `PATCH /v1/tasks/:id { status?, title?, dueAt?, assigneeUserId? }`
- Custom fields: `GET /v1/custom-fields` · `POST /v1/custom-fields { key, label, type: text|number|boolean|date|select|email|phone|url, options[], description, aiWritable }` · `PATCH /v1/custom-fields/:id` · `DELETE /v1/custom-fields/:id`

## Deals and pipelines
- `GET /v1/pipelines` (viewer, `deals:read`) → `[{ id, name, position, stages: [{ id, name, position }] }]` — every organization has at least one; the first ("Sales": New, Qualified, Proposal, Negotiation) comes with sign-up, or on first use for organizations from before deals existed
- `POST /v1/pipelines { name, stages: [{ name }] }` (admin) → 201
- `PATCH /v1/pipelines/:id { name?, stages?: [{ id?, name }], moveDealsTo?: { [stageId]: stageId } }` (admin) — `stages` is the full ordered list: existing stages by `id` (renamed or moved), new ones without; a stage left out is removed. A removed stage that has deals needs a destination in `moveDealsTo` (a stage that stays), else 409; each moved deal records `deal.stage_changed`
- `DELETE /v1/pipelines/:id` (admin) → 204; 409 for the last pipeline or one that has deals
- `Deal = { id, title, contactId, contact: { id, name, email, phone }, pipelineId, stageId, value: number|null, currency, status: open|won|lost, lostReason, ownerUserId, expectedCloseOn: "YYYY-MM-DD"|null, conversationId, createdBy: user|api, closedAt, stageChangedAt, createdAt, updatedAt }`
- `GET /v1/deals?pipelineId=&stageId=&status=&contactId=&ownerUserId=&search=&includeTest=&limit=50&offset=` (viewer, `deals:read`) → `Deal[]`, newest change first; the total in the `x-total-count` header. `search` matches the title and the contact's name or email. Deals of test contacts (the playground) are left out unless `includeTest=true` or `contactId` is given
- `GET /v1/deals/summary?pipelineId=&status=&ownerUserId=&includeTest=` → `[{ stageId, count, totals: [{ currency, value }] }]` for every stage of the pipeline, in order (deals without a value are counted but not added; test contacts' deals only with `includeTest=true`)
- `POST /v1/deals { title, contactId, pipelineId?, stageId?, value?, ownerUserId?, expectedCloseOn?, conversationId? }` (agent, `deals:write`) → 201 — defaults to the first pipeline and its first stage; `stageId` alone picks its pipeline; the currency is the organization's; a merged contact resolves to the contact it was merged into; the owner must be a member (else 400); a contact from another organization is 404
- `GET /v1/deals/:id` · `PATCH /v1/deals/:id { title?, value?, ownerUserId?, expectedCloseOn?, pipelineId?, stageId?, status?, lostReason? }` · `DELETE /v1/deals/:id` (agent, `deals:write`; `DELETE` → 204)
  - Moving to another pipeline needs one of its stages (`stageId`), else 400; a stage of another pipeline is 400.
  - `status: won|lost` records `closedAt` (and, for lost, the optional `lostReason`); `status: open` reopens and clears both.
- `GET /v1/contacts/:id/deals` (viewer, `deals:read`) → `Deal[]`
- Events (webhooks and activity; `deal` is `{ id, title, value, currency, status, pipelineId, pipeline, stageId, stage, ownerUserId, expectedCloseOn, lostReason, closedAt }`): `deal.created { deal }`, `deal.updated { changed: [title|value|owner|expectedCloseOn|status|lostReason], deal }` (`status` = reopened), `deal.stage_changed { from: { stageId, stage }, to: { stageId, stage }, deal }`, `deal.won { deal }`, `deal.lost { reason, deal }`, `deal.deleted { deal }`. One request can record several (e.g. a new stage and a new value).
- Merging contacts moves their deals to the surviving contact; deleting a contact deletes its deals.

## Approvals (ask the team first)

- `GET /v1/approvals?status=pending|approved|rejected|expired&conversationId=&limit=50&offset=` (viewer) → `Approval[]`, newest first; the total in the `x-total-count` header. `Approval = { id, conversationId, contact: { id, name, email, phone, isTest }, botId, tool, summary, input, status, reason, result, requestedAt, expiresAt, decidedAt, decidedBy: { id, name } | null }` — `summary` says what it does in words ("Move the customer to the “customer” stage"); `input` is the request exactly as the assistant asked; `result` is what the action returned once approved.
- `POST /v1/approvals/:id/approve { message? }` (agent; staff only, not API keys) → the `Approval`. Runs the action once, exactly as asked, with the bot's settings and the conversation as they are now. `409` if it was already decided (or is being approved right now) or expired; `422` if the action doesn't go through now (e.g. the slot was taken, or the action was switched off or no longer fits the bot's lists) — it stays pending, to fix and approve again or to decline.
- `POST /v1/approvals/:id/reject { reason?, message? }` (agent) → the `Approval`; `409` as above. The `reason` is shown to the assistant.
- `message` (either one) goes to the customer from the team member; the AI keeps the conversation.
- A request nobody answers expires after 7 days (`status: expired`) and can't be decided. The same request asked again in a conversation while it waits isn't saved twice, and a retried reply doesn't ask twice.
- The assistant's next turn sees each request with its answer (waiting, approved, declined with the reason, or expired).
- Events: `action.approval_requested { approvalId, tool, summary, botId }` (actor `ai`; staff get a notification linking to the conversation), `action.approved { approvalId, tool, summary }`, `action.rejected { approvalId, tool, summary, reason }` (actor `user`). The approved action records its own events as usual (e.g. `contact.updated`, actor `ai`).

## Conversations
- `GET /v1/conversations?status=ai_active|human_active|closed&channel=&contactId=&search=&assignee=me|unassigned|<userId>&sort=recent|waiting&includeTest=&limit=&offset=` → `[{ ...conversation, contact: { id, name, email, phone, leadTier }, lastMessage: { content, senderType, createdAt } | null, assignee: { id, name } | null, overdue }]`; total count in the `x-total-count` header. `assignee=me` needs a signed-in member. `sort=waiting` lists unanswered handoffs first, longest wait first. Each conversation has `handedOffAt`, `firstStaffReplyAt` and `handoffEscalatedAt`; `overdue` means handed off, unanswered and past the bot's `handoff.waitMinutes`
- `GET /v1/conversations/:id` → conversation + full `contact`, `assignee`, `overdue`
- Summary fields on conversations (list and detail):
  - `summary`: a plain-text summary (up to 200 words; the AI's memory of the conversation) and `summarizedThroughMessageId`, the last message it covers.
  - `summaryDetails`: the parts of the latest recap, or `null` before the first one: `{ intent, outcome, nextStep, sentiment: positive|neutral|negative, trigger: quiet|closed|handoff|manual, at, throughMessageId }`. `intent`, `outcome` and `nextStep` are one sentence each, or `null` (a `null` next step means nothing is open). A recap covers the whole conversation when it's written: 30 minutes after the last customer or staff message (`AI_SUMMARY_IDLE_MINUTES`), on close, when the conversation is handed to a person (by the AI or a staff takeover), and on request. Long chats also fold older messages into `summary` without changing `summaryDetails`. Recaps are written in English, or in the bot's language when it has a fixed one. None are written while the organization's AI is off or its monthly budget is spent, or for one-message chats.
- `POST /v1/conversations/:id/summary` (agent+) → `202 { queued: true }`, or `200 { queued: false, reason: nothing_new|too_short|ai_off|budget }` — asks for a recap now; the new summary arrives as a `conversation.summary` event on the conversation's stream and as a `conversation.summarized` webhook
- `GET /v1/conversations/:id/messages?limit=&after=&before=` → `[{ id, direction: inbound|outbound, senderType: contact|ai|human|system, content, citations: [{ chunkId, documentId, title, url }], aiRunId, createdAt }]`
- `GET /v1/conversations/:id/timeline` → `{ events: Event[], tools: [{ toolName, input, output, status: success|error|rejected|replayed|pending, error, durationMs, createdAt }] }`
  — `replayed`: a retried reply reused an earlier attempt's result (notes, tasks, staff alerts and workflow calls are never done twice); `pending`: saved as a request for the team (ask first) instead of acting
- `GET /v1/conversations/:id/ai-runs` → model, tokens, cost, latency per run
- `POST /v1/conversations/:id/messages { content }` — staff reply (takes the conversation over)
- `POST /v1/conversations/:id/status { action: takeover|resume|close, reason? }` — a handoff is assigned to whoever took it over, else the customer's owner when they're a member; resuming or closing clears the assignee. Reopening a closed conversation while the customer has a newer open one on that channel is `409`
- `POST /v1/conversations/:id/assign { userId: <member id> | null }` (agent) → the conversation; records `conversation.assigned`, and the new assignee gets a personal notification (and email) unless they assigned themselves
- `GET /v1/stream?conversationId=` — SSE: one conversation (all events incl. `ai.delta` and `conversation.summary` when a new summary is saved), or the org inbox without the param (`message`, `conversation.status`, `ai.done` only)

## Knowledge base
- `GET /v1/knowledge-bases` → `[{ id, name, description, language, documentCount }]` · `POST { name, description?, language? }` · `PATCH /v1/knowledge-bases/:id { name?, description?, language? }` · `DELETE`
  - `language` (default `english`): the language the documents are written in, used by keyword search for word forms and stop words. One of `GET /v1/knowledge/languages` → `[{ value, label }]` (the database's text search dictionaries, e.g. `english`, `spanish`, `hindi`, `tamil`; `simple` = any language, exact words). Anything else → 400. Changing it re-indexes that knowledge base's keyword search (no re-embedding).
- `GET /v1/knowledge-bases/:id/documents` → `[{ id, title, sourceType: text|faq|url|file, category, sourceUri, status: pending|processing|ready|failed, error, chunkCount, tokenCount, lastIngestedAt, refreshIntervalHours, nextRefreshAt, content?, faq?, createdAt }]`
- `POST /v1/knowledge-bases/:id/documents` with one of:
  - `{ type: "text", title, content, category? }`
  - `{ type: "faq", title?, faq: [{ question, answer }], category? }`
  - `{ type: "url", url, title?, crawl?: false, maxPages?: 10, category?, refreshIntervalHours?: 24|168|null }`
- `POST /v1/knowledge-bases/:id/upload?title=&category=` — `multipart/form-data`, field `file` (PDF, DOCX, TXT, MD, CSV, HTML)
- `GET /v1/documents/:id` · `GET /v1/documents/:id/chunks` · `PATCH /v1/documents/:id { title?, content?, faq?, category?, refreshIntervalHours? }` · `POST /v1/documents/:id/reingest` · `DELETE /v1/documents/:id`
  - A new title, content or FAQ list re-ingests the document; a new category or refresh schedule applies without re-ingesting.
  - `refreshIntervalHours` (web pages only, else 400): re-fetch daily (`24`) or weekly (`168`); `null` = never (the default). An unchanged page costs one fetch; a changed one is re-embedded. If a refresh fails, the document shows `status: failed` with the `error`, keeps answering from the last good version, and is tried again within 6 hours. `nextRefreshAt` is when the next fetch is due.
- `POST /v1/knowledge/search { knowledgeBaseIds[], query, limit? }` → `{ chunks: [{ id, title, content, url, similarity, score }], grounding: grounded|weak|none }`
- categories: `general | faq | services | pricing | policies | other`

## Scheduling
- `GET /v1/calendars` · `GET /v1/calendars/:id` · `POST /v1/calendars` · `PATCH /v1/calendars/:id` · `DELETE /v1/calendars/:id`
  - `{ name, description, timezone, slotMinutes, slotIntervalMinutes, bufferMinutes, minNoticeMinutes, maxDaysAhead, maxPerDay, weeklyHours: { mon: [{ start: "09:00", end: "17:00" }], ... }, dateOverrides: [{ date: "2026-12-25", hours: [] }], isActive, location, customerInstructions, sendConfirmations, reminderMinutes, replyToEmail, minCancelNoticeMinutes }`
  - **Emails to the customer:** `sendConfirmations` (default `true`): a confirmation with a calendar file (.ics) when a booking is made, plus a change or cancellation notice later, only if they had a confirmation. `reminderMinutes` (default `[1440]`): up to three reminders, 30 minutes to 7 days before; whole days keep the local time of day across daylight-saving changes, other values are exact. `location` and `customerInstructions` appear in the emails and the calendar file; `replyToEmail` receives replies.
  - Emails go only to the email stored on the contact: never to one waiting for a duplicate review, and never to test (playground) contacts. They are sent from `EMAIL_FROM` with the organization's name as the sender name; with `EMAIL_PROVIDER=log` they are only logged.
  - **Change policy:** `minCancelNoticeMinutes` (default `null` = until the appointment starts): how late the AI, acting for the customer, may still move or cancel a booking. Inside that window it offers the team instead. Staff and API keys can always change a booking.
- `GET /v1/calendars/:id/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ calendar, slots: [{ start, end, local, label }] }`
- `GET /v1/appointments?from=<ISO|now>&to=<ISO>&calendarId=&status=` → `[{ id, calendarId, contactId, title, startsAt, endsAt, timezone, localStart, label, status, notes, createdBy, contact: { name, email, phone } }]`
- `POST /v1/appointments { calendarId, contactId, start: "YYYY-MM-DDTHH:mm", title?, notes?, notifyCustomer?: true }` → `201` with the new appointment,
  or `200` with the existing one when this contact already has a booking on this calendar at this start (e.g. a double click)
  - `notifyCustomer: false` books without emailing the customer (no confirmation, no reminders) until a confirmation is resent.
- `POST /v1/appointments/:id/reschedule { start, notifyCustomer?: true }` · `POST /v1/appointments/:id/cancel { reason?, notifyCustomer?: true }` · `POST /v1/appointments/:id/status { status: completed|no_show }`
  - Booking, rescheduling and cancelling return `customerEmail: { queued, to, reason }`: whether the customer is emailed about it, and if not, why (`not_requested`, `emails_off`, `test_contact`, `no_email`, `email_under_review`, `never_confirmed`, `send_failed`, `unchanged`).
  - Moving or cancelling drops the booking's scheduled reminders (a move schedules new ones); completed and no-show drop them too.
  - Changing a calendar's reminders applies to bookings made or moved afterwards; a reminder time that was removed stops the reminders already scheduled for it.
- `GET /v1/appointments/:id/notifications` → `[{ id, kind: confirmation|update|cancellation|reminder, status: pending|sending|sent|skipped|failed|cancelled, reason, error, sendAt, sentAt, recipient, reminderMinutes, attempts, createdAt }]` — every email about the appointment, oldest first
- `POST /v1/appointments/:id/resend-confirmation` (agent+) → `{ queued, to, reason }` — sends a confirmation now (a booking made without emails starts getting them, reminders included)
  - Repeats are harmless: rescheduling to the current time changes nothing, and cancelling an already-cancelled appointment returns it.
    Neither records a second event.
  - Bookings and reschedules on one calendar are processed one at a time, so buffers and the daily cap hold under concurrency.

## Automation (n8n)
- `GET /v1/webhooks` · `POST /v1/webhooks { name, url, eventTypes: ["*"] | [types] }` → includes signing `secret` once · `PATCH` · `DELETE` · `GET /v1/webhooks/:id/deliveries`
- `GET /v1/workflows` · `POST /v1/workflows { key, name, description, url, mode: fire_and_forget|request_response, inputFields: [{ name, type, description, required, source? }], timeoutMs?, identifiedOnly?, askFirst? }` → includes `secret` once · `PATCH /v1/workflows/:id` · `DELETE` · `POST /v1/workflows/:key/test { inputs }`
  - `source` (default `chat`): `chat` = the assistant fills it from the conversation (what the customer typed); `contact.email|contact.phone|contact.name|contact.id` = the server fills it from the contact record (type `string`), and whatever the assistant passes for it is ignored. A required record value that's missing refuses the call ("ask for it and save it first"). A web-chat visitor's record holds only what they told the assistant (an email or phone that belongs to another contact is never added to theirs; see Duplicate reviews), so it doesn't prove who is asking: for lookups that return personal data, use `identifiedOnly`.
  - `identifiedOnly` (default false): the workflow runs only for customers identified by your own systems (chat-API conversations), never for a web-chat visitor, whose details are only their word; the assistant offers your team instead. Staff test runs always run.
  - `askFirst` (default false): each call the assistant makes waits for the team's approval (see Approvals). With `identifiedOnly`, a web-chat visitor's call then waits for approval instead of being refused: the person approving checks who is asking.
  - The workflow's request body: `{ workflow, organization_id, conversation_id, contact, inputs, record, trust: { identity: integration|unverified|staff, channel, fromChat: [names], fromRecord: [names], approvedBy: <user id> | null }, triggered_at }` — `inputs` has every value; `record` and `trust` say which came from the contact record and which were typed in the chat.
- Event types: `contact.created, contact.updated, contact.merged, contact.duplicate_detected, contact.consent_updated, contact.tagged, contact.untagged, contact.note_added, lead.captured, lead.qualification_updated, lead.qualified, lead.disqualified, appointment.booked, appointment.rescheduled, appointment.cancelled, task.created, conversation.started, conversation.handoff_requested, conversation.resumed_by_ai, conversation.handoff_overdue, conversation.assigned, conversation.unanswered, conversation.closed, conversation.summarized, message.outbound, deal.created, deal.updated, deal.stage_changed, deal.won, deal.lost, deal.deleted, workflow.triggered, team.notified, ai.provider_problem, action.approval_requested, action.approved, action.rejected`
- Delivery: `POST <url>` with headers `x-omni-event`, `x-omni-delivery`, `x-omni-signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`; body `{ id, type, organization_id, created_at, data: { ...payload, actor, conversation_id, contact } }`. The `contact` snapshot includes `source_channel`, `first_touch` (snake_case keys, e.g. `utm_source`) and `consent` (`{ marketing: { granted, at, source, text_version } }`). `contact.consent_updated` carries `{ purpose, granted, source, textVersion }`. `lead.qualification_updated`, `lead.qualified` and `lead.disqualified` carry the asking bot's `botId`; a `lead.qualified` that follows an earlier `lead.disqualified` also carries `previousStatus: "disqualified"`. `conversation.summarized` carries `{ summary, intent, outcome, nextStep, sentiment, trigger, status }` (see Conversations); `conversation.closed` fires first, and the closing recap follows as `conversation.summarized` with `trigger: "closed"`. `message.outbound` carries `{ message: { id, content, senderType: ai|human|system, createdAt }, externalUserId }` for every message sent to a customer of the chat API (web-chat messages aren't included, and these events don't appear in the dashboard's activity or timelines). Non-2xx responses are retried with exponential backoff (6 attempts).

## Public chat API (server-to-server)
- `POST /v1/channels/api/messages` (API key with `conversations:write`)
  `{ externalUserId, content, messageId?, contact?: { name?, email?, phone?, marketingConsent?: { granted, text? } }, source?: FirstTouch, timezone?, wait?: true, timeoutMs?: 60000 }`
  → `{ conversationId, contactId, message, reply: Message | null, replies: Message[] }`
  — with `wait` (the default), the response comes when the turn is over: `replies` holds every message of the turn in order (the reply, then any follow-up such as the marketing opt-in question, or a handoff message); `reply` is the first of them. A handoff returns right away. Without `wait`, or when no AI reply is due (a person is handling the chat), it's `202` with `reply: null, replies: []`.
  — every message to the customer (AI replies, follow-ups, handoff messages and staff replies) also goes out as a `message.outbound` webhook; use its message `id` to skip the one you already got from `replies`.
- `GET /v1/channels/api/messages?externalUserId=&after=<messageId>&limit=100` (API key with `conversations:write`) → `{ conversationId, status, messages: Message[] }` — the customer's latest conversation (the open one, else the last closed one) and its messages after `after`, oldest first; without `after`, the latest `limit`. `{ conversationId: null, status: null, messages: [] }` for an unknown customer. For integrations that poll instead of taking webhooks.
  — `contact` is trusted (it comes from your authenticated integration): an email/phone that already belongs to a contact merges into it. Placeholder values such as `unknown`, `N/A` or `none` are ignored (the AI's captures ignore them too).
  — `marketingConsent` records an opt-in or opt-out (e.g. a form checkbox); `text`, the wording agreed to, is required for a yes. `source` is stored as the contact's first touch if it has none. `timezone` (IANA, e.g. `America/Vancouver`) is stored on the contact if none is known.

## Widget (public)
- `GET /widget/v1/config?key=pk_…` → `{ theme, greeting, assistantName, companyName, starters: [{ id, label, message }] }` — `starters`: the bot's enabled conversation starters, in order, each with the exact text a click sends (the action stays on the server)
- `POST /widget/v1/sessions { key, visitorId? }` → `{ token, visitorId, conversationId, status, messages: PublicMessage[] }`
- `GET /widget/v1/messages?after=<messageId>` → `{ conversationId, status, messages }`
- `POST /widget/v1/messages { content, clientMessageId?, pageUrl?, firstTouch?, timezone?, starterId? }` → `{ conversationId, message }` — `starterId`: the conversation starter clicked, kept on the message; a `handoff` starter hands the chat to the team only while it's still one of the bot's enabled starters (otherwise it's an ordinary message). A repeated `clientMessageId` returns the stored message (`200`) instead of adding another. `pageUrl` is stored without query parameters other than UTM tags and ad click ids; `firstTouch` (recorded by the widget on the visitor's first page load) is stored on the contact once; `timezone` (the browser's) is stored on the contact if none is known, and invalid values are ignored
- `GET /widget/v1/stream?conversationId=` — SSE events: `message` `{ message: PublicMessage }`, `ai.typing`, `ai.delta` `{ text }`, `ai.activity` `{ label }`, `ai.done` `{ messageId }`, `conversation.status` `{ status }` — nothing else: no handoff reasons and no staff-only events
- `PublicMessage = { id, role: user|assistant|agent, content, createdAt, sources: [{ title, url }] }`
- The visitor's IP address, as the server sees it (`TRUST_PROXY` decides which forwarded address counts; an address the visitor sends is never used), is kept on their conversation as `metadata.visitorIp` and `metadata.visitorIpAt`: set when their first message starts the conversation (opening the chat creates nothing), and updated when a new session starts from another address. Staff see it in `GET /v1/conversations/:id`; it's never returned to the widget, given to the AI, or included in webhooks. Playground chats don't record it.
- `GET /widget.js` — the embeddable script: `<script src="https://api.example.com/widget.js" data-key="pk_…" async></script>`
