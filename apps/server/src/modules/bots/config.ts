import { z } from 'zod';
import { normalizeEmail } from '../leads/capture';

/**
 * Bot (AI agent) configuration. Stored as JSONB on `bots.config`, validated here on every write,
 * and parsed with defaults on every read so older rows keep working as fields are added.
 */

const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'use lowercase letters, digits and underscores');

export const STANDARD_LEAD_FIELDS = ['name', 'email', 'phone', 'company'] as const;
export type StandardLeadField = (typeof STANDARD_LEAD_FIELDS)[number];

export const ToolKey = z.enum([
  'save_contact_details',
  'record_qualification_answers',
  'search_knowledge_base',
  'check_availability',
  'book_appointment',
  'list_my_appointments',
  'reschedule_appointment',
  'cancel_appointment',
  'add_tags',
  'add_note',
  'create_task',
  'notify_team',
  'trigger_workflow',
  'transfer_to_human',
  'ask_marketing_consent',
  'record_marketing_consent',
  'set_lifecycle_stage',
  'assign_owner',
  'remove_tags',
  'create_deal',
  'update_deal',
  'call_api',
  'stop_bot',
]);
export type ToolKey = z.infer<typeof ToolKey>;

/** Actions a bot can be set to ask the team about first (workflows ask per workflow). Lookups and team alerts can't. */
export const ASK_FIRST_TOOLS = [
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'add_tags',
  'remove_tags',
  'set_lifecycle_stage',
  'assign_owner',
  'create_deal',
  'update_deal',
] as const satisfies readonly ToolKey[];

export const PersonaSchema = z.object({
  assistantName: z.string().trim().max(60).default('Ava'),
  companyName: z.string().trim().max(120).default(''),
  role: z.string().trim().max(120).default('virtual assistant'),
  tone: z.enum(['friendly', 'professional', 'casual', 'enthusiastic', 'empathetic']).default('friendly'),
  responseLength: z.enum(['short', 'medium', 'detailed']).default('short'),
  /** 'auto' mirrors the customer's language. Otherwise a language name or code, e.g. "English", "hi". */
  language: z.string().trim().max(40).default('auto'),
  useEmojis: z.boolean().default(false),
  greeting: z.string().trim().max(500).default('Hi! How can I help you today?'),
  /** The voice in the business's own words ("warm and reassuring, like our front desk"); adds to the tone. */
  personality: z.string().trim().max(600).default(''),
});

/** One line in the prompt's list of goals: line breaks and runs of spaces collapse. */
const goalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((goal) => goal.replace(/\s+/g, ' '));

/** What the business wants the assistant to achieve, ahead of the built-in goals of the enabled features. */
export const GoalsSchema = z.object({
  /** One sentence, e.g. "Get visitors to book a free consultation." */
  primary: goalLine(300).default(''),
  secondary: z
    .array(goalLine(200))
    .max(5)
    .default([])
    .transform((goals) => goals.filter(Boolean)),
});

export const BusinessProfileSchema = z.object({
  description: z.string().max(4000).default(''),
  services: z.string().max(4000).default(''),
  hours: z.string().max(1000).default(''),
  location: z.string().max(500).default(''),
  website: z.string().max(300).default(''),
  phone: z.string().max(60).default(''),
  email: z.string().max(200).default(''),
  extraFacts: z.string().max(8000).default(''),
});

export const LeadCaptureFieldSchema = z.object({
  /** A standard field (name/email/phone/company) or a custom field key. */
  field: z.string().trim().min(1).max(64),
  required: z.boolean().default(false),
  /** When the bot should ask: early in the chat, only before booking, or whenever it fits naturally. */
  timing: z.enum(['early', 'before_booking', 'natural']).default('natural'),
});

export const LeadCaptureSchema = z.object({
  enabled: z.boolean().default(true),
  fields: z.array(LeadCaptureFieldSchema).max(20).default([
    { field: 'name', required: true, timing: 'natural' },
    { field: 'email', required: true, timing: 'natural' },
    { field: 'phone', required: false, timing: 'natural' },
  ]),
  /** Shown/said when collecting details, e.g. a privacy notice. */
  consentNotice: z.string().trim().max(500).default(''),
  /**
   * The exact marketing opt-in question, posted verbatim by the server once the bot has an email or phone
   * (empty = don't ask). The customer's answer is recorded as consent, with their reply as evidence.
   */
  marketingOptIn: z.string().trim().max(500).default(''),
});

export const QualificationQuestionSchema = z.object({
  key: slug,
  question: z.string().trim().min(1).max(300),
  type: z.enum(['text', 'number', 'boolean', 'select', 'multi_select', 'date']).default('text'),
  options: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  required: z.boolean().default(true),
  /** Optionally mirror the answer into a contact custom field. */
  saveToCustomField: z.string().max(64).nullable().default(null),
});

export const QualificationRuleSchema = z.object({
  questionKey: slug,
  operator: z.enum(['equals', 'not_equals', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'answered']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).nullable().default(null),
  points: z.number().int().min(-1000).max(1000).default(0),
  /** A matching disqualifier ends qualification as "disqualified" regardless of score. */
  disqualify: z.boolean().default(false),
});

export const QualificationOutcomeSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  lifecycleStage: z.string().trim().max(40).nullable().default(null),
  notifyTeam: z.boolean().default(false),
});

export const QualificationSchema = z.object({
  enabled: z.boolean().default(false),
  questions: z.array(QualificationQuestionSchema).max(25).default([]),
  rules: z.array(QualificationRuleSchema).max(100).default([]),
  thresholds: z
    .object({ hot: z.number().int().default(70), warm: z.number().int().default(40) })
    .default({ hot: 70, warm: 40 }),
  /** Minimum score to be marked qualified once every required question is answered. */
  qualifyAt: z.number().int().default(50),
  onQualified: QualificationOutcomeSchema.default({ tags: ['qualified'], lifecycleStage: 'qualified', notifyTeam: true }),
  onDisqualified: QualificationOutcomeSchema.default({ tags: ['unqualified'], lifecycleStage: 'unqualified', notifyTeam: false }),
  /** What the bot should do with a qualified lead. */
  qualifiedNextStep: z.enum(['offer_booking', 'collect_contact', 'handoff', 'none']).default('offer_booking'),
  disqualifiedMessage: z.string().max(500).default(''),
});

/** A web link (http or https) only: the assistant shares it in chat, so `javascript:` and the like must never get through. */
function isHttpUrl(value: string): boolean {
  // No spaces or line breaks: the link goes into the assistant's instructions as one line.
  if (/[\s\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** What a booking passes to the workflows it triggers. A workflow that needs any other input from the chat can't run after a booking. */
export const BOOKING_WORKFLOW_INPUTS = ['appointment_id', 'appointment_time', 'appointment_timezone'] as const;

export const BookingSchema = z.object({
  enabled: z.boolean().default(false),
  calendarId: z.string().uuid().nullable().default(null),
  /** An empty title falls back to the default, so a booking is never saved without one. */
  appointmentTitle: z
    .string()
    .trim()
    .max(120)
    .default('Consultation')
    .transform((title) => title || 'Consultation'),
  /** Contact details that must be on file before a booking is made. */
  requiredFields: z.array(z.enum(['name', 'email', 'phone'])).default(['name', 'email']),
  requireQualification: z.boolean().default(false),
  allowReschedule: z.boolean().default(true),
  allowCancel: z.boolean().default(true),
  /** "Don't book appointment (only send the booking link)": the assistant shares `bookingLink` instead of booking. */
  linkOnly: z.boolean().default(false),
  bookingLink: z.union([z.literal(''), z.string().trim().max(500).refine(isHttpUrl, 'Must be a web link starting with http:// or https://')]).default(''),
  /** "Pause bot responses after booking": once the assistant books, it confirms and stops replying (until staff resume it). */
  pauseAfterBooking: z.boolean().default(false),
  /** "Trigger workflow after booking": these workflows run whenever the assistant books an appointment. */
  triggerWorkflows: z.boolean().default(false),
  workflowKeys: z.array(z.string().min(1).max(80)).max(10).default([]),
  /** "Transfer Employee post appointment booking": the conversation is assigned to this team member after booking. */
  transferEmployee: z.boolean().default(false),
  transferUserId: z.string().uuid().nullable().default(null),
});

/** The longest a handed-off chat can stay with the team before the assistant takes it back: 30 days. */
export const MAX_HANDOFF_REACTIVATE_MINUTES = 30 * 24 * 60;
/** At most this many handover scenarios per bot (GHL allows six handover actions per bot). */
export const MAX_HANDOFF_SCENARIOS = 6;
/** The ready-made scenarios (GHL's three). A trigger phrase or a "talk to the team" starter uses `human_requested`. */
export const HANDOFF_PRESETS = ['human_requested', 'lack_of_information', 'failed_to_resolve'] as const;

/**
 * Told to the customer when a handoff doesn't come from a scenario: the AI reply limit, the monthly budget, or the
 * assistant handing over without naming one. The only handover wording that isn't the business's own.
 */
export const SYSTEM_HANDOFF_MESSAGE = "I'm connecting you with a member of our team. They'll reply here as soon as possible.";

/**
 * A situation in which the assistant hands the chat to a person ("Human Handover" scenarios). The assistant decides from
 * the trigger condition and the example phrases; the scenario then says who gets the chat, what the customer is told,
 * whether a task is created, which tags are added, and when the assistant takes the chat back. Human Requested's
 * example phrases also hand over at once, without the AI, when a customer's message contains one.
 */
export const HandoffScenarioSchema = z.object({
  /** Kept across edits; assigned when missing. */
  id: z.string().uuid().optional(),
  /** Which ready-made scenario this started as; null for one the business added. */
  preset: z.enum(HANDOFF_PRESETS).nullable().default(null),
  enabled: z.boolean().default(false),
  name: z.string().trim().min(1).max(80),
  condition: z.string().trim().min(1).max(300),
  /** Up to 30: Human Requested took over the old trigger phrases (at most 30). */
  examples: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /** The team member who gets the chat; null = keep the contact's current assignee (else the customer's owner). */
  assignTo: z.string().uuid().nullable().default(null),
  /** Sent word for word when the chat is handed over (the away message instead, outside team hours, if that's on). */
  finalMessage: z.string().trim().min(1).max(500),
  /** The assistant takes the chat back after this long, unless the team replied within it. */
  reactivate: z
    .object({ enabled: z.boolean().default(true), afterMinutes: z.number().int().min(1).max(MAX_HANDOFF_REACTIVATE_MINUTES).default(480) })
    .default({ enabled: true, afterMinutes: 480 }),
  /** A follow-up task on the contact (due in 24 hours), for whoever gets the chat. */
  createTask: z.boolean().default(true),
  tags: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
});
export type HandoffScenario = z.infer<typeof HandoffScenarioSchema>;

/** Fixed ids for the scenarios made here, so a bot that hasn't been saved since reads the same ids every time. */
const PRESET_IDS = {
  human_requested: '0a5d0f0e-0000-4000-8000-000000000001',
  lack_of_information: '0a5d0f0e-0000-4000-8000-000000000002',
  failed_to_resolve: '0a5d0f0e-0000-4000-8000-000000000003',
  complaint: '0a5d0f0e-0000-4000-8000-000000000004',
} as const;

/** GHL's three ready-made scenarios, as a new bot gets them: all off. */
export function defaultHandoffScenarios(): HandoffScenario[] {
  const ready = { enabled: false, assignTo: null, reactivate: { enabled: true, afterMinutes: 480 }, createTask: true, tags: ['human handover'] };
  return [
    {
      ...ready,
      id: PRESET_IDS.human_requested,
      preset: 'human_requested',
      name: 'Human Requested',
      condition: 'Direct request to speak with human',
      examples: ['I want to talk to the manager', 'I want to talk to a human'],
      finalMessage: "Sure! I'm transferring your request to a human agent. Someone from the team will get back to you shortly.",
    },
    {
      ...ready,
      id: PRESET_IDS.lack_of_information,
      preset: 'lack_of_information',
      name: 'Lack of information',
      condition: 'The AI cannot find the relevant information or lacks knowledge on the question asked',
      examples: [],
      finalMessage: "I'm sorry, but I don't have the answer to your question at the moment. I've passed it on to our team, and someone will get back to you shortly.",
    },
    {
      ...ready,
      id: PRESET_IDS.failed_to_resolve,
      preset: 'failed_to_resolve',
      name: 'Failed to resolve issue',
      condition: 'Multiple attempts to resolve the issue has failed',
      examples: [],
      finalMessage: "Apologies, but I'm unable to process your request currently. I've escalated it to our team, and someone will get back to you shortly.",
    },
  ];
}

const LEGACY_KEYWORDS = ['talk to a human', 'real person', 'speak to someone', 'human agent', 'customer service', 'representative'];

/**
 * Handoff settings from before scenarios (an `enabled` switch, trigger phrases, one message, "notify the team") become
 * scenarios that behave the same: Human Requested with the old phrases and message, Failed to resolve issue and a
 * "Complaint or sensitive issue" scenario for the other reasons the assistant used to hand over, all with the old
 * message and nothing extra (no task, tags or take-back, which didn't exist). A bot with handoff off gets them all off.
 * No handoff settings at all (a new bot) = GHL's three, off.
 */
function migrateHandoff(raw: unknown): unknown {
  if (raw === undefined || raw === null) return { scenarios: defaultHandoffScenarios() };
  if (typeof raw !== 'object' || 'scenarios' in raw) return raw;
  const old = raw as { enabled?: unknown; keywords?: unknown; message?: unknown };
  const on = old.enabled !== false;
  const message = typeof old.message === 'string' && old.message.trim() ? old.message.trim().slice(0, 500) : SYSTEM_HANDOFF_MESSAGE;
  const phrases = (Array.isArray(old.keywords) ? old.keywords : LEGACY_KEYWORDS)
    .filter((k): k is string => typeof k === 'string' && k.trim().length >= 2)
    .map((k) => k.trim().slice(0, 120))
    .slice(0, 30);
  const asBefore = { assignTo: null, finalMessage: message, reactivate: { enabled: false, afterMinutes: 480 }, createTask: false, tags: [] };
  const [human, lack, failed] = defaultHandoffScenarios();
  return {
    ...raw,
    scenarios: [
      { ...human!, ...asBefore, enabled: on, examples: phrases },
      // Off, and new with scenarios: it looks like the others (nothing extra) rather than like a new scenario.
      { ...lack!, reactivate: asBefore.reactivate, createTask: false, tags: [] },
      { ...failed!, ...asBefore, enabled: on },
      {
        ...asBefore,
        id: PRESET_IDS.complaint,
        preset: null,
        enabled: on,
        name: 'Complaint or sensitive issue',
        condition: 'The customer is upset or complaining, or raises a refund, billing, legal or safety issue',
        examples: [],
      },
    ],
  };
}

/** What is stored: the scenarios, plus the timing settings shown under Timing & Pacing. */
const HandoffFieldsSchema = z.object({
  /** After a handoff, alert the team (and run `fallback`) if nobody has answered in this many minutes. 0 = never. */
  waitMinutes: z.number().int().min(0).max(1440).default(0),
  /** What happens when that time is up. Both resume options hand the chat back to the assistant. */
  fallback: z.enum(['keep_waiting', 'resume_ai', 'ask_contact_details']).default('keep_waiting'),
  /** Outside the organization's team hours, the customer gets `awayMessage` instead of the handover message. */
  respectTeamHours: z.boolean().default(false),
  awayMessage: z.string().max(500).default("Our team is away right now. We'll reply here as soon as we're back."),
  scenarios: z
    .array(HandoffScenarioSchema)
    .max(MAX_HANDOFF_SCENARIOS)
    .default([])
    .transform((list) => list.map((scenario) => ({ ...scenario, id: scenario.id ?? crypto.randomUUID() }))),
});
export const HandoffFallbackSchema = HandoffFieldsSchema.shape.fallback;

/**
 * Human Handover. Everything is a scenario: handover is on while one is (`enabled`, derived), and Human Requested's
 * example phrases are the instant trigger phrases (`keywords`, derived). Read with older settings, it migrates them.
 */
export const HandoffSchema = z.preprocess(migrateHandoff, HandoffFieldsSchema).transform((h) => {
  const human = h.scenarios.find((s) => s.enabled && s.preset === 'human_requested');
  return { ...h, enabled: h.scenarios.some((s) => s.enabled), keywords: human ? human.examples.filter((e) => e.trim().length >= 2) : [] };
});

/** The handover scenarios in force (switched on). */
export function activeHandoffScenarios(config: Pick<BotConfig, 'handoff'>): HandoffScenario[] {
  return config.handoff.scenarios.filter((s) => s.enabled);
}

/** At most this many starters per bot (enabled or not). */
export const MAX_CONVERSATION_STARTERS = 10;

/**
 * A quick option the website chat offers under its greeting until the visitor writes. Clicking it sends `message`
 * (or the label when empty) as the visitor's message; `handoff` also hands the chat to the team, like a handoff keyword.
 */
export const ConversationStarterSchema = z.object({
  /** Kept across edits; assigned when missing. */
  id: z.string().uuid().optional(),
  /** One line: line breaks and runs of spaces collapse. */
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((label) => label.replace(/\s+/g, ' ')),
  message: z.string().trim().max(500).default(''),
  action: z.enum(['message', 'handoff']).default('message'),
  enabled: z.boolean().default(true),
  /** Display position; the list is sorted by it (then by list position) and renumbered from 0 on every save. */
  order: z.number().int().min(0).max(1000).optional(),
});

export const ConversationStartersSchema = z
  .array(ConversationStarterSchema)
  .max(MAX_CONVERSATION_STARTERS)
  .default([])
  .transform((starters) =>
    starters
      .map((starter, index) => ({ starter, index }))
      .sort((a, b) => (a.starter.order ?? a.index) - (b.starter.order ?? b.index) || a.index - b.index)
      .map(({ starter }, order) => ({ ...starter, id: starter.id ?? crypto.randomUUID(), order })),
  );

export const GuardrailsSchema = z.object({
  stayOnTopic: z.boolean().default(true),
  forbiddenTopics: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /** What to do when the knowledge base doesn't cover a question. */
  unknownAnswer: z.enum(['offer_handoff', 'collect_contact', 'say_dont_know']).default('collect_contact'),
  maxAiRepliesPerConversation: z.number().int().min(1).max(500).default(60),
});

/** At most this many Stop Bot scenarios per bot. */
export const MAX_STOP_SCENARIOS = 10;
/** The longest a stopped bot can sleep before it restarts on its own: 30 days. */
export const MAX_STOP_MINUTES = 30 * 24 * 60;

/**
 * A situation in which the assistant stops replying in a conversation ("Stop Bot"): the customer says goodbye, asks
 * not to be contacted, and so on. The assistant decides from the trigger condition and the example phrases, sends the
 * final message, tags the contact, and stays silent until it restarts (after a set time, or when staff resume it).
 */
export const StopScenarioSchema = z.object({
  /** Kept across edits; assigned when missing. */
  id: z.string().uuid().optional(),
  enabled: z.boolean().default(false),
  /** What the assistant calls it; unique within the bot. */
  name: z.string().trim().min(1).max(80),
  /** When to stop, in words: "When the contact says goodbye or similar phrases". */
  condition: z.string().trim().min(1).max(300),
  /** Things a customer might say in this situation. */
  examples: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  /** Sent word for word as the last message before the assistant goes quiet; empty = say nothing. */
  finalMessage: z.string().trim().max(500).default(''),
  /** Start again after this long; off = stay stopped until staff resume the conversation. */
  reactivate: z
    .object({ enabled: z.boolean().default(true), afterMinutes: z.number().int().min(1).max(MAX_STOP_MINUTES).default(1440) })
    .default({ enabled: true, afterMinutes: 1440 }),
  /** Tags added to the contact when the assistant stops. Created when they don't exist yet. */
  tags: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
});
export type StopScenario = z.infer<typeof StopScenarioSchema>;

/** At most this many custom API actions per bot. */
export const MAX_CUSTOM_APIS = 10;

const KeyValueSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\r\n:]+$/, 'no line breaks or colons'),
  value: z
    .string()
    .max(2000)
    .regex(/^[^\r\n]*$/, 'no line breaks')
    .default(''),
});

/** A value the assistant collects in the chat and passes to the API as `{{name}}`. */
export const CustomApiParamSchema = z.object({
  name: slug,
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  description: z.string().trim().max(300).default(''),
  required: z.boolean().default(true),
});

/**
 * An HTTP API the assistant may call during a chat (the "API Call" action). `{{param}}`, `{{contact.email}}`,
 * `{{contact.name}}`, `{{contact.phone}}`, `{{contact.id}}` and `{{conversation.id}}` are filled in the URL, query
 * values, header values and raw body. The credential is write-only: stored sealed as `secretEnc`, never sent back.
 */
export const CustomApiSchema = z.object({
  /** Kept across edits; assigned when missing. */
  id: z.string().uuid().optional(),
  /** What the model calls it by. */
  key: slug,
  name: z.string().trim().min(1).max(80),
  /** Tells the assistant when to call it. */
  description: z.string().trim().min(1).max(600),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((u) => /^https?:\/\/[^\s/]+/i.test(u), 'Enter a full URL starting with https://'),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded']).default('application/json'),
  headers: z.array(KeyValueSchema).max(20).default([]),
  query: z.array(KeyValueSchema).max(20).default([]),
  /** Off: the body is the collected values as JSON (or a form). On: `body`, with placeholders filled. */
  rawBody: z.boolean().default(false),
  body: z.string().max(8000).default(''),
  params: z.array(CustomApiParamSchema).max(15).default([]),
  auth: z
    .object({
      type: z.enum(['none', 'bearer', 'api_key', 'basic']).default('none'),
      /** The header an API key goes in. */
      headerName: z
        .string()
        .trim()
        .max(100)
        .regex(/^[A-Za-z0-9-_]*$/, 'letters, digits, - and _ only')
        .default('x-api-key'),
      /** Basic auth user name (the secret is the password). */
      username: z.string().trim().max(200).default(''),
      /** Sealed credential. Server-side only. */
      secretEnc: z.string().max(4000).optional(),
      /** Read-only, in what the API returns: whether a credential is stored. */
      hasSecret: z.boolean().optional(),
    })
    .default({ type: 'none', headerName: 'x-api-key', username: '' }),
  /** On: the assistant waits for the reply and uses it. Off: it calls and carries on. */
  waitForResponse: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(20_000).default(10_000),
  /** The team approves each call first. */
  askFirst: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type CustomApi = z.infer<typeof CustomApiSchema>;

/** Placeholders every custom API may use, filled by the server (never by the model). */
export const CUSTOM_API_BUILTINS = ['contact.id', 'contact.name', 'contact.email', 'contact.phone', 'conversation.id'] as const;

/** The `{{name}}`s used anywhere in a custom API's request. */
export function apiPlaceholders(api: Pick<CustomApi, 'url' | 'headers' | 'query' | 'rawBody' | 'body'>): string[] {
  const texts = [api.url, ...api.headers.map((h) => h.value), ...api.query.map((q) => q.value), api.rawBody ? api.body : ''];
  const found = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)) found.add(m[1]!);
  return [...found];
}

function handoffScenarioProblems(scenarios: HandoffScenario[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const s of scenarios) {
    const name = s.name.toLowerCase();
    if (names.has(name)) problems.push(`handoff.scenarios: two scenarios are called "${s.name}"`);
    names.add(name);
  }
  return problems;
}

function stopScenarioProblems(scenarios: StopScenario[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const s of scenarios) {
    const name = s.name.toLowerCase();
    if (names.has(name)) problems.push(`stopScenarios: two scenarios are called "${s.name}"`);
    names.add(name);
  }
  return problems;
}

function customApiProblems(apis: CustomApi[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const api of apis) {
    if (keys.has(api.key)) problems.push(`customApis: two APIs are called "${api.key}"`);
    keys.add(api.key);
    const params = new Set<string>();
    for (const p of api.params) {
      if (params.has(p.name)) problems.push(`customApis: "${api.name}" has two inputs called "${p.name}"`);
      params.add(p.name);
    }
    const unknown = apiPlaceholders(api).filter((name) => !params.has(name) && !(CUSTOM_API_BUILTINS as readonly string[]).includes(name));
    if (unknown.length) problems.push(`customApis: "${api.name}" uses ${unknown.map((n) => `{{${n}}}`).join(', ')}, which isn't one of its inputs`);
    if (api.rawBody && api.method === 'GET') problems.push(`customApis: "${api.name}" is a GET request, so it can't send a body`);
  }
  return problems;
}

export const ActionsSchema = z.object({
  disabledTools: z.array(ToolKey).default([]),
  /** Tags the bot may apply. Empty = any existing tag. */
  allowedTags: z.array(z.string().trim().min(1).max(60)).max(100).default([]),
  allowCreateTags: z.boolean().default(false),
  /** Workflow keys (n8n) this bot may trigger. */
  workflowKeys: z.array(slug).max(30).default([]),
  /** Lifecycle stages the assistant may set (`set_lifecycle_stage`); empty = the action is off. */
  lifecycleStages: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  /** Team members (user IDs) the assistant may make a contact's owner (`assign_owner`); empty = the action is off. */
  owners: z.array(z.string().uuid()).max(50).default([]),
  /** `remove_tags`: tags from `allowedTags`, or (with no list) only tags the assistant added itself. */
  removeTags: z.boolean().default(false),
  /** `create_deal` / `update_deal` in one pipeline (null = the organization's first); marking won or lost needs `canClose`. */
  deals: z
    .object({ enabled: z.boolean().default(false), pipelineId: z.string().uuid().nullable().default(null), canClose: z.boolean().default(false) })
    .default({ enabled: false, pipelineId: null, canClose: false }),
  /** Actions that wait for the team's approval instead of happening at once. */
  askFirst: z.array(z.enum(ASK_FIRST_TOOLS)).max(ASK_FIRST_TOOLS.length).default([]),
  /** HTTP APIs the assistant may call (`call_api`). */
  customApis: z
    .array(CustomApiSchema)
    .max(MAX_CUSTOM_APIS)
    .default([])
    .transform((apis) => apis.map((api) => ({ ...api, id: api.id ?? crypto.randomUUID() }))),
  /** Situations in which the assistant stops replying in a conversation (`stop_bot`). */
  stopScenarios: z
    .array(StopScenarioSchema)
    .max(MAX_STOP_SCENARIOS)
    .default([])
    .transform((list) => list.map((scenario) => ({ ...scenario, id: scenario.id ?? crypto.randomUUID() }))),
});

export const BotConfigSchema = z.object({
  persona: PersonaSchema.default(PersonaSchema.parse({})),
  goals: GoalsSchema.default(GoalsSchema.parse({})),
  instructions: z.string().max(12_000).default(''),
  business: BusinessProfileSchema.default(BusinessProfileSchema.parse({})),
  leadCapture: LeadCaptureSchema.default(LeadCaptureSchema.parse({})),
  qualification: QualificationSchema.default(QualificationSchema.parse({})),
  booking: BookingSchema.default(BookingSchema.parse({})),
  handoff: HandoffSchema,
  guardrails: GuardrailsSchema.default(GuardrailsSchema.parse({})),
  actions: ActionsSchema.default(ActionsSchema.parse({})),
  conversationStarters: ConversationStartersSchema,
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type BotConfigInput = z.input<typeof BotConfigSchema>;
export type QualificationConfig = z.infer<typeof QualificationSchema>;
export type QualificationQuestion = z.infer<typeof QualificationQuestionSchema>;
export type QualificationRule = z.infer<typeof QualificationRuleSchema>;
export type ConversationStarter = BotConfig['conversationStarters'][number];
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

/** What the website chat shows: the enabled starters, in order, each with the exact text a click sends. */
export function offeredStarters(config: BotConfig): Array<{ id: string; label: string; message: string }> {
  return config.conversationStarters
    .filter((s) => s.enabled && (s.action !== 'handoff' || config.handoff.enabled))
    .map((s) => ({ id: s.id, label: s.label, message: s.message || s.label }));
}

/** The enabled "talk to the team" starter one of these (starter ids of the waiting messages) came from, if any. */
export function handoffStarter(config: BotConfig, starterIds: Array<string | undefined>): ConversationStarter | null {
  if (!config.handoff.enabled) return null;
  return config.conversationStarters.find((s) => s.enabled && s.action === 'handoff' && starterIds.includes(s.id)) ?? null;
}

/** `{business_name}` and friends: values the prompt editor's "Custom Values" menu inserts into the instructions. */
export const CUSTOM_VALUES = ['business_name', 'agent_name', 'business_hours', 'business_website', 'business_phone', 'business_email', 'business_location'] as const;

/** The instructions with each custom value filled from the bot's settings (an unset one reads "not set"). */
export function fillCustomValues(text: string, config: Pick<BotConfig, 'persona' | 'business'>, organizationName: string): string {
  const values: Record<(typeof CUSTOM_VALUES)[number], string> = {
    business_name: config.persona.companyName || organizationName,
    agent_name: config.persona.assistantName,
    business_hours: config.business.hours,
    business_website: config.business.website,
    business_phone: config.business.phone,
    business_email: config.business.email,
    business_location: config.business.location,
  };
  return text.replace(/\{(business_name|agent_name|business_hours|business_website|business_phone|business_email|business_location)\}/g, (_, key: keyof typeof values) => values[key].trim() || 'not set');
}

/** Provider-neutral reasoning depth; each LLM provider maps it (or omits it). */
export const EffortSchema = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof EffortSchema>;

/** Cross-field checks zod can't express per field. Returns human-readable problems. */
/** A business website as an owner types it: with or without https://, a dotted host name and no spaces. */
export function isWebsite(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return (url.protocol === 'https:' || url.protocol === 'http:') && /^[^.]+(\.[^.]+)+$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** A phone number as a business writes it: phone characters only (an extension is fine) and at least 6 digits. */
export function isPhoneLike(value: string): boolean {
  const v = value.trim();
  return /^[+\d()\-.\s/]*(?:(?:ext\.?|x)\s*\d+)?$/i.test(v) && (v.match(/\d/g) ?? []).length >= 6;
}

const BUSINESS_CONTACT = {
  website: { check: isWebsite, message: 'Enter a valid website, e.g. https://example.com' },
  email: { check: (v: string) => normalizeEmail(v) !== null, message: 'Enter a valid email address' },
  phone: { check: isPhoneLike, message: 'Enter a valid phone number' },
} as const;

/**
 * Business info the bot hands out (website, email, phone) must be usable. Only values that changed are checked, so
 * a bot already storing an older, unchecked value still loads and can save its other sections.
 */
export function businessContactProblems(next: BusinessProfile, previous?: BusinessProfile): Array<{ path: string; message: string }> {
  return (Object.keys(BUSINESS_CONTACT) as Array<keyof typeof BUSINESS_CONTACT>).flatMap((key) => {
    const value = next[key].trim();
    if (!value || (previous && previous[key].trim() === value)) return [];
    return BUSINESS_CONTACT[key].check(value) ? [] : [{ path: `business.${key}`, message: BUSINESS_CONTACT[key].message }];
  });
}

export function validateBotConfig(config: BotConfig): string[] {
  const problems: string[] = [];
  const questionKeys = new Set<string>();
  for (const q of config.qualification.questions) {
    if (questionKeys.has(q.key)) problems.push(`qualification: duplicate question key "${q.key}"`);
    questionKeys.add(q.key);
    if ((q.type === 'select' || q.type === 'multi_select') && q.options.length === 0) {
      problems.push(`qualification: question "${q.key}" needs options`);
    }
  }
  for (const r of config.qualification.rules) {
    if (!questionKeys.has(r.questionKey)) problems.push(`qualification: rule references unknown question "${r.questionKey}"`);
    if (r.operator !== 'answered' && r.value === null) problems.push(`qualification: rule on "${r.questionKey}" needs a value`);
  }
  if (config.qualification.enabled && config.qualification.questions.length === 0) {
    problems.push('qualification: enabled but no questions defined');
  }
  if (config.qualification.thresholds.warm > config.qualification.thresholds.hot) {
    problems.push('qualification: warm threshold must be <= hot threshold');
  }
  if (config.booking.enabled && !config.booking.calendarId) problems.push('booking: enabled but no calendar selected');
  if (config.booking.linkOnly && !config.booking.bookingLink) problems.push('booking: "only send the booking link" needs a booking link');
  if (config.booking.triggerWorkflows && config.booking.workflowKeys.length === 0) problems.push('booking: choose a workflow to trigger after booking');
  if (config.booking.transferEmployee && !config.booking.transferUserId) problems.push('booking: choose who gets the conversation after booking');
  const seen = new Set<string>();
  for (const f of config.leadCapture.fields) {
    if (seen.has(f.field)) problems.push(`leadCapture: duplicate field "${f.field}"`);
    seen.add(f.field);
  }
  const starterIds = new Set<string>();
  const starterLabels = new Set<string>();
  for (const s of config.conversationStarters) {
    if (starterIds.has(s.id)) problems.push('conversationStarters: two starters have the same id');
    starterIds.add(s.id);
    const label = s.label.toLowerCase();
    if (starterLabels.has(label)) problems.push(`conversationStarters: duplicate label "${s.label}"`);
    starterLabels.add(label);
    if (s.enabled && s.action === 'handoff' && !config.handoff.enabled) {
      problems.push(`conversationStarters: "${s.label}" hands the chat to your team, but no Human Handover scenario is on`);
    }
  }
  problems.push(...customApiProblems(config.actions.customApis));
  problems.push(...stopScenarioProblems(config.actions.stopScenarios));
  problems.push(...handoffScenarioProblems(config.handoff.scenarios));
  return problems;
}
