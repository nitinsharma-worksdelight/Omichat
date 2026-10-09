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

export const BookingSchema = z.object({
  enabled: z.boolean().default(false),
  calendarId: z.string().uuid().nullable().default(null),
  appointmentTitle: z.string().trim().max(120).default('Consultation'),
  /** Contact details that must be on file before a booking is made. */
  requiredFields: z.array(z.enum(['name', 'email', 'phone'])).default(['name', 'email']),
  requireQualification: z.boolean().default(false),
  allowReschedule: z.boolean().default(true),
  allowCancel: z.boolean().default(true),
});

export const HandoffSchema = z.object({
  enabled: z.boolean().default(true),
  keywords: z
    .array(z.string().trim().min(2).max(60))
    .max(30)
    .default(['talk to a human', 'real person', 'speak to someone', 'human agent', 'customer service', 'representative']),
  message: z
    .string()
    .max(500)
    .default("I'm connecting you with a member of our team. They'll reply here as soon as possible."),
  notifyTeam: z.boolean().default(true),
  /** After a handoff, alert the team (and run `fallback`) if nobody has answered in this many minutes. 0 = never. */
  waitMinutes: z.number().int().min(0).max(1440).default(0),
  /** What happens when that time is up. Both resume options hand the chat back to the assistant. */
  fallback: z.enum(['keep_waiting', 'resume_ai', 'ask_contact_details']).default('keep_waiting'),
  /** Outside the organization's team hours, the customer gets `awayMessage` instead of `message` (only when this is on). */
  respectTeamHours: z.boolean().default(false),
  awayMessage: z.string().max(500).default("Our team is away right now. We'll reply here as soon as we're back."),
});

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
});

export const BotConfigSchema = z.object({
  persona: PersonaSchema.default(PersonaSchema.parse({})),
  goals: GoalsSchema.default(GoalsSchema.parse({})),
  instructions: z.string().max(12_000).default(''),
  business: BusinessProfileSchema.default(BusinessProfileSchema.parse({})),
  leadCapture: LeadCaptureSchema.default(LeadCaptureSchema.parse({})),
  qualification: QualificationSchema.default(QualificationSchema.parse({})),
  booking: BookingSchema.default(BookingSchema.parse({})),
  handoff: HandoffSchema.default(HandoffSchema.parse({})),
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
      problems.push(`conversationStarters: "${s.label}" hands the chat to your team, but Human handoff is off`);
    }
  }
  problems.push(...customApiProblems(config.actions.customApis));
  return problems;
}
