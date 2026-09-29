/** Response and request shapes of the HTTP API (see docs/API.md). Dates arrive as ISO strings. */

export type Role = 'owner' | 'admin' | 'agent' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  organizationId: string;
  role: Role;
  organizationName: string;
}

export interface Me {
  user: User;
  memberships: Membership[];
  currentOrganizationId: string;
  role: Role;
  authMode: 'local' | 'supabase';
}

export interface LoginResponse {
  token: string;
  user: User;
  memberships: Membership[];
}

export interface SignupResponse {
  token: string;
  user: User;
  organization: Organization;
}

export interface OrgSettings {
  notificationEmails: string[];
  lifecycleStages: string[];
  defaultCountry: string;
  /** ISO 4217 currency for deal values; absent means USD. */
  currency?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  aiEnabled: boolean;
  monthlyAiBudgetUsd: number | null;
  settings: OrgSettings;
  createdAt: string;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export const API_KEY_SCOPES = [
  'conversations:read',
  'conversations:write',
  'contacts:read',
  'contacts:write',
  'appointments:read',
  'appointments:write',
  'deals:read',
  'deals:write',
  'knowledge:write',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends Omit<ApiKey, 'lastUsedAt' | 'revokedAt'> {
  key: string;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export type Actor = 'ai' | 'user' | 'contact' | 'system';

export interface EventItem {
  id: string;
  type: string;
  actor: Actor;
  actorUserId: string | null;
  contactId: string | null;
  conversationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Usage {
  since: string;
  ai: { runs: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number };
  conversations: { total: number; handedOff: number };
  leads: { captured: number; qualified: number };
  appointmentsBookedByAi: number;
}

// ---------- bots ----------

/** Provider-neutral reasoning depth (only meaningful for reasoning models). */
export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

/** GET /v1/ai/config — what bots use unless they override it. */
export interface AiConfig {
  provider: string;
  model: string;
  reasoningEffort: Effort | null;
  utilityModel: string;
  utilityReasoningEffort: Effort | null;
  pricing: { model: boolean; utilityModel: boolean };
  reasoningEfforts: Effort[];
}

export const TOOL_KEYS = [
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
] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];
/** Turned on through their own settings (stages, owners, removing tags, deals), not the tool switches. */
export const CRM_TOOL_KEYS: readonly ToolKey[] = ['set_lifecycle_stage', 'assign_owner', 'remove_tags', 'create_deal', 'update_deal'];
/** Actions a bot can be set to ask the team about first (workflows ask per workflow). */
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
export type AskFirstTool = (typeof ASK_FIRST_TOOLS)[number];

export const STANDARD_LEAD_FIELDS = ['name', 'email', 'phone', 'company'] as const;

export type Tone = 'friendly' | 'professional' | 'casual' | 'enthusiastic' | 'empathetic';
export type ResponseLength = 'short' | 'medium' | 'detailed';

export interface Persona {
  assistantName: string;
  companyName: string;
  role: string;
  tone: Tone;
  responseLength: ResponseLength;
  language: string;
  useEmojis: boolean;
  greeting: string;
  /** The voice in the business's own words; adds to the tone. */
  personality: string;
}

/** What the business wants the assistant to achieve, ahead of the built-in goals. */
export interface Goals {
  primary: string;
  secondary: string[];
}

export interface BusinessProfile {
  description: string;
  services: string;
  hours: string;
  location: string;
  website: string;
  phone: string;
  email: string;
  extraFacts: string;
}

export type LeadTiming = 'early' | 'before_booking' | 'natural';

export interface LeadCaptureField {
  field: string;
  required: boolean;
  timing: LeadTiming;
}

export interface LeadCapture {
  enabled: boolean;
  fields: LeadCaptureField[];
  consentNotice: string;
  /** The exact opt-in question the server posts; empty = don't ask. */
  marketingOptIn: string;
}

export type QuestionType = 'text' | 'number' | 'boolean' | 'select' | 'multi_select' | 'date';

export interface QualificationQuestion {
  key: string;
  question: string;
  type: QuestionType;
  options: string[];
  required: boolean;
  saveToCustomField: string | null;
}

export type RuleOperator = 'equals' | 'not_equals' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'answered';
export type RuleValue = string | number | boolean | string[] | null;

export interface QualificationRule {
  questionKey: string;
  operator: RuleOperator;
  value: RuleValue;
  points: number;
  disqualify: boolean;
}

export interface QualificationOutcome {
  tags: string[];
  lifecycleStage: string | null;
  notifyTeam: boolean;
}

export type QualifiedNextStep = 'offer_booking' | 'collect_contact' | 'handoff' | 'none';

export interface Qualification {
  enabled: boolean;
  questions: QualificationQuestion[];
  rules: QualificationRule[];
  thresholds: { hot: number; warm: number };
  qualifyAt: number;
  onQualified: QualificationOutcome;
  onDisqualified: QualificationOutcome;
  qualifiedNextStep: QualifiedNextStep;
  disqualifiedMessage: string;
}

export type BookingRequiredField = 'name' | 'email' | 'phone';

export interface Booking {
  enabled: boolean;
  calendarId: string | null;
  appointmentTitle: string;
  requiredFields: BookingRequiredField[];
  requireQualification: boolean;
  allowReschedule: boolean;
  allowCancel: boolean;
}

export interface Handoff {
  enabled: boolean;
  keywords: string[];
  message: string;
  notifyTeam: boolean;
}

export type UnknownAnswer = 'offer_handoff' | 'collect_contact' | 'say_dont_know';

export interface Guardrails {
  stayOnTopic: boolean;
  forbiddenTopics: string[];
  unknownAnswer: UnknownAnswer;
  maxAiRepliesPerConversation: number;
}

export interface Actions {
  disabledTools: ToolKey[];
  allowedTags: string[];
  allowCreateTags: boolean;
  workflowKeys: string[];
  /** Stages the assistant may set; empty = off. */
  lifecycleStages: string[];
  /** Team members (user IDs) the assistant may make a contact's owner; empty = off. */
  owners: string[];
  /** Remove tags from the allowed list, or (with no list) only the assistant's own. */
  removeTags: boolean;
  /** Create and move deals in one pipeline (null = the first); marking won or lost needs canClose. */
  deals: { enabled: boolean; pipelineId: string | null; canClose: boolean };
  /** Actions that wait for the team's approval instead of happening at once. */
  askFirst: AskFirstTool[];
}

/** What a conversation starter does when clicked: send its message, or send it and hand the chat to the team. */
export type StarterAction = 'message' | 'handoff';

/** A quick option the website chat offers under its greeting until the visitor writes. */
export interface ConversationStarter {
  id: string;
  /** The button's text. */
  label: string;
  /** Sent as the visitor's message; empty = the label. */
  message: string;
  action: StarterAction;
  enabled: boolean;
  /** Display position, from 0; the list order. */
  order: number;
}

export interface BotConfig {
  persona: Persona;
  goals: Goals;
  instructions: string;
  business: BusinessProfile;
  leadCapture: LeadCapture;
  qualification: Qualification;
  booking: Booking;
  handoff: Handoff;
  guardrails: Guardrails;
  actions: Actions;
  conversationStarters: ConversationStarter[];
}

export type BotConfigSection = keyof BotConfig;

export interface Bot {
  id: string;
  name: string;
  isActive: boolean;
  version: number;
  /** Per-bot override; null = the server's configured model. */
  model: string | null;
  /** Per-bot override; null = the server's configured effort. */
  effort: Effort | null;
  maxOutputTokens: number;
  knowledgeBaseIds: string[];
  config: BotConfig;
  createdAt: string;
  updatedAt: string;
}

export interface BotPreview {
  provider: string;
  model: string;
  reasoningEffort: Effort | null;
  system: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

/** A conversation starter as the chat shows it: `message` is exactly what a click sends. */
export interface OfferedStarter {
  id: string;
  label: string;
  message: string;
}

export interface PlaygroundSession {
  token: string;
  visitorId: string;
  greeting: string;
  botName: string;
  /** The bot's enabled conversation starters, in order (absent from older servers). */
  starters?: OfferedStarter[];
}

// ---------- widget ----------

export interface PublicMessage {
  id: string;
  role: 'user' | 'assistant' | 'agent';
  content: string;
  createdAt: string;
  sources: Array<{ title: string; url: string }>;
}

export interface WidgetMessagesResponse {
  conversationId: string | null;
  status?: ConversationStatus;
  messages: PublicMessage[];
}

// ---------- channels ----------

export type ChannelType = 'webchat' | 'playground' | 'api';

export interface ChannelTheme {
  primaryColor?: string;
  position?: 'right' | 'left';
  title?: string;
  subtitle?: string;
  avatarUrl?: string;
  launcherText?: string;
  /** Visitors may drag the bubble anywhere while the chat is closed; `position` is where it starts. */
  draggable?: boolean;
}

export interface Channel {
  id: string;
  channel: ChannelType;
  name: string;
  publicKey: string | null;
  botId: string | null;
  status: 'active' | 'disabled';
  config: { allowedOrigins?: string[]; greeting?: string; theme?: ChannelTheme };
  embedSnippet: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- CRM ----------

export type LeadTier = 'hot' | 'warm' | 'cold';
export type QualificationStatus = 'not_started' | 'in_progress' | 'qualified' | 'disqualified';

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt?: string;
}

export interface ContactFact {
  id: string;
  text: string;
  /** `ai`: the assistant noted it; `user`: the team did (staff, a shared note, or an integration). */
  source: 'ai' | 'user';
  createdAt: string;
}

export interface Contact {
  id: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  sourceChannel: ChannelType | null;
  lifecycleStage: string;
  leadScore: number;
  leadTier: LeadTier | null;
  qualificationStatus: QualificationStatus;
  /** Answers by question key; `botId` is the assistant that asked (absent on older answers). */
  qualification: Record<string, { value: unknown; answeredAt: string; botId?: string | null }>;
  customFields: Record<string, unknown>;
  memory: ContactFact[];
  firstTouch: FirstTouch | null;
  consent: Partial<Record<ConsentPurpose, ConsentState>>;
  timezone: string | null;
  ownerUserId: string | null;
  isTest: boolean;
  tags: Tag[];
  leadCapturedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** List view only: a duplicate review involving this contact is waiting. */
  hasPendingMerge?: boolean;
}

/** Where a lead first came from. */
export interface FirstTouch {
  landingPage?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
  at?: string;
}

export type ConsentPurpose = 'marketing';
export type ConsentSource = 'chat' | 'staff' | 'api';

export interface ConsentState {
  granted: boolean;
  at: string;
  source: ConsentSource;
  textVersion: string | null;
}

export interface ConsentRecord {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  text: string | null;
  textVersion: string | null;
  source: ConsentSource;
  conversationId: string | null;
  requestMessageId: string | null;
  evidenceMessageId: string | null;
  note: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface SourceOptions {
  utmSource: string[];
  utmMedium: string[];
  utmCampaign: string[];
}

export interface ContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isTest: boolean;
  createdAt: string;
}

/** An email/phone given in a chat that belongs to another contact, waiting for staff to merge or dismiss. */
export interface MergeCandidate {
  id: string;
  field: 'email' | 'phone';
  value: string;
  status: 'pending' | 'merged' | 'dismissed';
  conversationId: string | null;
  createdAt: string;
  /** The contact who gave the email/phone. */
  claimant: ContactSummary;
  /** The contact that already had it. */
  existing: ContactSummary;
}

export interface ContactList {
  items: Contact[];
  total: number;
}

export type CustomFieldType = 'text' | 'number' | 'boolean' | 'date' | 'select' | 'email' | 'phone' | 'url';
export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['text', 'number', 'boolean', 'date', 'select', 'email', 'phone', 'url'];

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  description: string;
  aiWritable: boolean;
  createdAt: string;
}

export interface Note {
  id: string;
  contactId: string;
  body: string;
  source: 'ai' | 'user';
  authorUserId: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  contactId: string | null;
  conversationId: string | null;
  title: string;
  description: string;
  dueAt: string | null;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'done';
  assigneeUserId: string | null;
  createdBy: 'ai' | 'user';
  completedAt: string | null;
  createdAt: string;
}

// ---------- conversations ----------

export type ConversationStatus = 'ai_active' | 'human_active' | 'closed';
export type SenderType = 'contact' | 'ai' | 'human' | 'system';

export interface ConversationListItem {
  id: string;
  contactId: string;
  channelAccountId: string;
  channel: ChannelType;
  botId: string | null;
  status: ConversationStatus;
  assignedUserId: string | null;
  handoffReason: string | null;
  messageCount: number;
  aiReplyCount: number;
  lastMessageAt: string | null;
  isTest: boolean;
  createdAt: string;
  /** Recap of the conversation so far (written as it goes quiet, on close, at handoff, on request, and as long chats grow). */
  summary: string | null;
  /** The last message the summary covers. */
  summarizedThroughMessageId: string | null;
  /** Parts of the latest recap; null until the first one. */
  summaryDetails: SummaryDetails | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null; leadTier: LeadTier | null };
  lastMessage: { content: string; senderType: SenderType; createdAt: string } | null;
}

export type SummaryTrigger = 'quiet' | 'closed' | 'handoff' | 'manual';

/** The parts of a recap, which covered the whole conversation when it was written. */
export interface SummaryDetails {
  intent: string | null;
  outcome: string | null;
  nextStep: string | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  trigger: SummaryTrigger;
  at: string;
  throughMessageId: string;
}

/** `POST /v1/conversations/:id/summary`: queued, or why not. */
export type SummaryRequest = { queued: true } | { queued: false; reason: 'ai_off' | 'budget' | 'nothing_new' | 'too_short' };

export interface ConversationDetail extends Omit<ConversationListItem, 'contact' | 'lastMessage'> {
  contact: Contact;
  /** Includes `visitorIp` / `visitorIpAt` for website chats: the visitor's address at their latest session. */
  metadata: Record<string, unknown>;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  title: string;
  url?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  senderType: SenderType;
  senderUserId: string | null;
  content: string;
  citations: Citation[];
  aiRunId: string | null;
  status: string;
  createdAt: string;
}

export interface ToolInvocation {
  id: string;
  aiRunId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  /** `replayed`: a retried turn reused an earlier attempt's result instead of doing it again. `pending`: waiting for the team. */
  status: 'success' | 'error' | 'rejected' | 'replayed' | 'pending';
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export interface Timeline {
  events: EventItem[];
  tools: ToolInvocation[];
}

// ---------- knowledge ----------

export type DocumentCategory = 'general' | 'faq' | 'services' | 'pricing' | 'policies' | 'other';
export const DOCUMENT_CATEGORIES: DocumentCategory[] = ['general', 'faq', 'services', 'pricing', 'policies', 'other'];
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  /** Keyword-search language ('english', 'spanish', …; 'simple' = any language, exact words). */
  language: string;
  documentCount: number;
  createdAt: string;
}

export interface KnowledgeLanguage {
  value: string;
  label: string;
}

/** Website documents re-fetch daily (24) or weekly (168); null = never. */
export type RefreshInterval = 24 | 168 | null;

export interface FaqItem {
  question: string;
  answer: string;
}

export interface KbDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  sourceType: 'text' | 'faq' | 'url' | 'file';
  category: DocumentCategory;
  sourceUri: string | null;
  options: { crawl?: boolean; maxPages?: number };
  mimeType: string | null;
  fileSize: number | null;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
  tokenCount: number;
  lastIngestedAt: string | null;
  refreshIntervalHours: RefreshInterval;
  nextRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
  content?: string | null;
  faq?: FaqItem[] | null;
}

export interface Chunk {
  id: string;
  chunkIndex: number;
  title: string;
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  chunks: Array<{ id: string; documentId: string; title: string; content: string; url: string | null; category: string | null; similarity: number | null; score: number }>;
  grounding: 'grounded' | 'weak' | 'none';
  bestSimilarity?: number | null;
}

// ---------- scheduling ----------

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface TimeRange {
  start: string;
  end: string;
}

export type WeeklyHours = Partial<Record<Weekday, TimeRange[]>>;

export interface DateOverride {
  date: string;
  hours: TimeRange[];
}

export interface Calendar {
  id: string;
  name: string;
  description: string;
  timezone: string;
  slotMinutes: number;
  slotIntervalMinutes: number | null;
  bufferMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  maxPerDay: number | null;
  weeklyHours: WeeklyHours;
  dateOverrides: DateOverride[];
  isActive: boolean;
  /** Shown to the customer in emails and the calendar file. */
  location: string;
  customerInstructions: string;
  sendConfirmations: boolean;
  /** Minutes before the start; [] = no reminders. */
  reminderMinutes: number[];
  replyToEmail: string | null;
  /** How late the assistant may still change or cancel a booking; null = until it starts. */
  minCancelNoticeMinutes: number | null;
  provider?: string;
  createdAt: string;
}

export type CalendarInput = Omit<Calendar, 'id' | 'createdAt' | 'provider'>;

export interface Slot {
  start: string;
  end: string;
  local: string;
  label: string;
}

export interface Availability {
  calendar: { id: string; name: string; timezone: string; slotMinutes: number };
  slots: Slot[];
}

export type AppointmentStatus = 'booked' | 'cancelled' | 'completed' | 'no_show';

export interface Appointment {
  id: string;
  calendarId: string;
  contactId: string;
  conversationId: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  localStart: string;
  label: string;
  status: AppointmentStatus;
  notes: string;
  createdBy: 'ai' | 'user' | 'contact';
  cancelReason: string | null;
  createdAt: string;
  contact?: { name: string | null; email: string | null; phone: string | null };
  /** Returned by booking, moving and cancelling: what the customer is emailed about it. */
  customerEmail?: CustomerEmailOutcome;
}

export interface CustomerEmailOutcome {
  queued: boolean;
  to: string | null;
  reason: string | null;
}

export interface AppointmentEmail {
  id: string;
  kind: 'confirmation' | 'update' | 'cancellation' | 'reminder';
  status: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'cancelled';
  reason: string | null;
  error: string | null;
  sendAt: string;
  sentAt: string | null;
  recipient: string | null;
  reminderMinutes: number | null;
  attempts: number;
  createdAt: string;
}

// ---------- automation ----------

export const EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.merged',
  'contact.duplicate_detected',
  'contact.consent_updated',
  'contact.tagged',
  'contact.untagged',
  'contact.note_added',
  'lead.captured',
  'lead.qualification_updated',
  'lead.qualified',
  'lead.disqualified',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'task.created',
  'conversation.started',
  'conversation.handoff_requested',
  'conversation.resumed_by_ai',
  'conversation.closed',
  'conversation.summarized',
  'message.outbound',
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'deal.deleted',
  'workflow.triggered',
  'team.notified',
  'action.approval_requested',
  'action.approved',
  'action.rejected',
] as const;

export interface Webhook {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: string;
  secret?: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'success' | 'failed';
  attemptCount: number;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export type WorkflowInputSource = 'chat' | 'contact.email' | 'contact.phone' | 'contact.name' | 'contact.id';

export interface WorkflowInputField {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  /** Default chat. A record source is filled by the server from the contact; the assistant can't set it. */
  source?: WorkflowInputSource;
}

export interface Workflow {
  id: string;
  key: string;
  name: string;
  description: string;
  url: string;
  mode: 'fire_and_forget' | 'request_response';
  inputFields: WorkflowInputField[];
  timeoutMs: number;
  /** Runs only for chat-API customers (identified by the business's own systems), never a web-chat visitor. */
  identifiedOnly: boolean;
  /** Each call waits for the team's approval; with identifiedOnly, that also admits web-chat visitors. */
  askFirst: boolean;
  isActive: boolean;
  createdAt: string;
  secret?: string;
}

// ---------- approvals ----------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** An action the assistant asked the team to approve. */
export interface Approval {
  id: string;
  conversationId: string;
  contact: { id: string; name: string | null; email: string | null; phone: string | null; isTest: boolean };
  botId: string | null;
  tool: string;
  summary: string;
  input: Record<string, unknown>;
  status: ApprovalStatus;
  reason: string | null;
  result: Record<string, unknown> | null;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: { id: string; name: string } | null;
}

export interface WorkflowTestResult {
  ok: boolean;
  queued?: boolean;
  status?: number;
  response?: unknown;
  error?: string;
}

// ---------- deals ----------

export interface PipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface Pipeline {
  id: string;
  name: string;
  position: number;
  stages: PipelineStage[];
}

export type DealStatus = 'open' | 'won' | 'lost';

export interface Deal {
  id: string;
  title: string;
  contactId: string;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  pipelineId: string;
  stageId: string;
  value: number | null;
  currency: string;
  status: DealStatus;
  lostReason: string | null;
  ownerUserId: string | null;
  expectedCloseOn: string | null;
  conversationId: string | null;
  createdBy: 'user' | 'api' | 'ai';
  closedAt: string | null;
  stageChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** `GET /v1/deals/summary`: per stage, the count and total value (per currency) of the deals shown. */
export interface DealStageSummary {
  stageId: string;
  count: number;
  totals: Array<{ currency: string; value: number }>;
}
