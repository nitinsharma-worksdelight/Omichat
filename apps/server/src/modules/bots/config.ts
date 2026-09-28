import { z } from 'zod';

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
  consentNotice: z.string().max(500).default(''),
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
});

export const GuardrailsSchema = z.object({
  stayOnTopic: z.boolean().default(true),
  forbiddenTopics: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  /** What to do when the knowledge base doesn't cover a question. */
  unknownAnswer: z.enum(['offer_handoff', 'collect_contact', 'say_dont_know']).default('collect_contact'),
  maxAiRepliesPerConversation: z.number().int().min(1).max(500).default(60),
});

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
});

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type BotConfigInput = z.input<typeof BotConfigSchema>;
export type QualificationConfig = z.infer<typeof QualificationSchema>;
export type QualificationQuestion = z.infer<typeof QualificationQuestionSchema>;
export type QualificationRule = z.infer<typeof QualificationRuleSchema>;

/** Provider-neutral reasoning depth; each LLM provider maps it (or omits it). */
export const EffortSchema = z.enum(['low', 'medium', 'high']);
export type Effort = z.infer<typeof EffortSchema>;

/** Cross-field checks zod can't express per field. Returns human-readable problems. */
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
  return problems;
}
