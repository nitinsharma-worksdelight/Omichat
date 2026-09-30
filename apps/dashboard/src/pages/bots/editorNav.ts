import {
  BookOpen,
  CalendarCheck,
  Cpu,
  FileText,
  Gauge,
  Headset,
  IdCard,
  LayoutGrid,
  MessageCircleMore,
  Shield,
  Store,
  Target,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ErrorDetail } from '../../lib/api';
import { STANDARD_LEAD_FIELDS, type BotConfig, type BotConfigSection, type CustomFieldDef, type Effort, type LeadCapture } from '../../lib/types';
import type { EditorContext } from './sections';

/**
 * The bot editor's menu: its sections in plain-language groups, what each one's status is, which six parts are
 * essential for a new bot, and what the settings search finds. Pure data and functions of the draft, no UI.
 */

/** The bot as it's being edited (saved with the Save button). */
export interface BotDraft {
  name: string;
  isActive: boolean;
  /** '' = follow the server configuration. */
  model: string;
  effort: Effort | '';
  maxOutputTokens: number;
  knowledgeBaseIds: string[];
  config: BotConfig;
}

/** A section of settings; its id is also the `?tab=` value that opens it (so older links keep working). */
export type SectionId = BotConfigSection | 'model' | 'knowledge';
export type EditorView = 'overview' | SectionId;

export interface SectionInfo {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  /** The line under the section's heading, in plain words; `name` is the assistant's ("Maya", or "your assistant"). */
  description: (name: string) => string;
  /** Other words people use for the whole section (its settings have their own, in SETTINGS). */
  keywords: string[];
}

export interface SectionGroup {
  id: string;
  /** Group names can use the assistant's name ("What Maya knows"). */
  label: (assistantName: string) => string;
  sections: SectionInfo[];
}

export const OVERVIEW = { label: 'Overview', icon: LayoutGrid, keywords: ['setup', 'progress', 'essentials', 'website code', 'embed'] };

export const SECTION_GROUPS: SectionGroup[] = [
  {
    id: 'personality',
    label: () => 'Personality',
    sections: [
      {
        id: 'persona',
        label: 'Identity & voice',
        icon: UserRound,
        description: (name) => `The name visitors see, the voice ${name} uses and the first message of every chat.`,
        keywords: ['persona', 'identity', 'voice', 'profile'],
      },
      {
        id: 'goals',
        label: 'Goals',
        icon: Target,
        description: (name) => `What ${name} works towards in every chat. Answering the visitor's question always comes first.`,
        keywords: ['objective', 'aim', 'purpose'],
      },
      {
        id: 'instructions',
        label: 'Instructions',
        icon: FileText,
        description: () => 'Anything specific to your business, in your own words: what to emphasise, what to avoid, special cases.',
        keywords: ['custom instructions', 'rules', 'prompt', 'brief'],
      },
    ],
  },
  {
    id: 'knowledge',
    label: (name) => `What ${name} knows`,
    sections: [
      {
        id: 'business',
        label: 'Business info',
        icon: Store,
        description: (name) => `Facts ${name} can always rely on, even without a knowledge base.`,
        keywords: ['business', 'company info', 'about'],
      },
      {
        id: 'knowledge',
        label: 'Knowledge bases',
        icon: BookOpen,
        description: (name) => `Documents, FAQs and web pages ${name} searches to answer questions, with the sources shown.`,
        keywords: ['knowledge', 'documents', 'faq', 'sources', 'files', 'web pages'],
      },
    ],
  },
  {
    id: 'conversations',
    label: () => 'Conversations',
    sections: [
      {
        id: 'conversationStarters',
        label: 'Conversation starters',
        icon: MessageCircleMore,
        description: () => 'One-click options under the greeting in the website chat, shown until the visitor writes.',
        keywords: ['starters', 'quick options', 'suggested questions', 'quick replies', 'buttons'],
      },
      {
        id: 'leadCapture',
        label: 'Lead capture',
        icon: IdCard,
        description: (name) => `Which contact details ${name} asks for, and when.`,
        keywords: ['lead', 'leads', 'contact details'],
      },
      {
        id: 'qualification',
        label: 'Qualification',
        icon: Gauge,
        description: (name) => `Questions ${name} weaves into the chat, scored to rank leads as hot, warm or cold.`,
        keywords: ['qualify', 'lead score', 'scoring'],
      },
      {
        id: 'booking',
        label: 'Booking',
        icon: CalendarCheck,
        description: (name) => `Let ${name} find open times and book, move or cancel appointments on your calendar.`,
        keywords: ['appointments', 'bookings', 'scheduling'],
      },
      {
        id: 'handoff',
        label: 'Handoff',
        icon: Headset,
        description: (name) => `When your team takes over the chat. ${capitalize(name)} stops replying until someone hands it back.`,
        keywords: ['human', 'person', 'team', 'transfer', 'live agent'],
      },
    ],
  },
  {
    id: 'rules',
    label: () => 'Rules & tools',
    sections: [
      {
        id: 'guardrails',
        label: 'Guardrails',
        icon: Shield,
        description: (name) => `Keep ${name} focused and safe.`,
        keywords: ['safety', 'limits', 'restrictions'],
      },
      {
        id: 'actions',
        label: 'Actions',
        icon: Zap,
        description: (name) => `What ${name} may do by itself: tools, CRM updates, tags and workflows.`,
        keywords: ['permissions', 'crm', 'automations'],
      },
      {
        id: 'model',
        label: 'Model',
        icon: Cpu,
        description: (name) => `The AI model behind ${name}. The server's choice suits most bots.`,
        keywords: ['llm', 'ai model', 'gpt', 'claude'],
      },
    ],
  },
];

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One setting the search can jump straight to. `id` is the `data-setting` anchor around its field in the section,
 * so the section can scroll to it and put the cursor there.
 */
export interface SettingInfo {
  id: string;
  section: SectionId;
  label: string;
  keywords: string[];
}

export const SETTINGS: SettingInfo[] = [
  { id: 'persona.template', section: 'persona', label: 'Use a template', keywords: ['template', 'receptionist', 'sales assistant', 'support agent', 'booking coordinator', 'preset'] },
  { id: 'persona.assistantName', section: 'persona', label: 'Assistant name', keywords: ['name', 'persona name'] },
  { id: 'persona.companyName', section: 'persona', label: 'Company name', keywords: ['business name', 'organization'] },
  { id: 'persona.role', section: 'persona', label: 'Role', keywords: ['job title', 'position'] },
  { id: 'persona.tone', section: 'persona', label: 'Tone', keywords: ['friendly', 'professional', 'casual', 'enthusiastic', 'empathetic'] },
  { id: 'persona.responseLength', section: 'persona', label: 'Reply length', keywords: ['response length', 'short', 'medium', 'detailed', 'long replies'] },
  { id: 'persona.language', section: 'persona', label: 'Language', keywords: ['auto', 'translate', 'multilingual'] },
  { id: 'persona.useEmojis', section: 'persona', label: 'Use emojis', keywords: ['emoji'] },
  { id: 'persona.personality', section: 'persona', label: 'Personality', keywords: ['character', 'style', 'come across'] },
  { id: 'persona.greeting', section: 'persona', label: 'Greeting', keywords: ['welcome message', 'first message', 'hello', 'intro'] },
  { id: 'goals.primary', section: 'goals', label: 'Main goal', keywords: ['primary goal'] },
  { id: 'goals.secondary', section: 'goals', label: 'More goals', keywords: ['extra goals', 'other goals', 'secondary goals'] },
  { id: 'instructions', section: 'instructions', label: 'Custom instructions', keywords: ['extra instructions', 'special cases'] },
  { id: 'business.description', section: 'business', label: 'What you do', keywords: ['description', 'about us'] },
  { id: 'business.services', section: 'business', label: 'Services and products', keywords: ['services', 'products', 'offerings'] },
  { id: 'business.extraFacts', section: 'business', label: 'Other facts', keywords: ['facts', 'parking', 'payment', 'policies'] },
  { id: 'business.hours', section: 'business', label: 'Opening hours', keywords: ['hours', 'open', 'business hours'] },
  { id: 'business.location', section: 'business', label: 'Location', keywords: ['address', 'where'] },
  { id: 'business.website', section: 'business', label: 'Website', keywords: ['url', 'site'] },
  { id: 'business.phone', section: 'business', label: 'Phone', keywords: ['phone number', 'telephone', 'business phone'] },
  { id: 'business.email', section: 'business', label: 'Email', keywords: ['email address', 'contact email', 'business email'] },
  { id: 'leadCapture.enabled', section: 'leadCapture', label: 'Capture leads', keywords: ['collect contact details', 'lead capture on'] },
  { id: 'leadCapture.fields', section: 'leadCapture', label: 'Details to ask for', keywords: ['fields', 'name', 'email', 'phone', 'required', 'when to ask', 'custom fields'] },
  { id: 'leadCapture.consentNotice', section: 'leadCapture', label: 'Privacy notice', keywords: ['privacy', 'data use', 'gdpr'] },
  { id: 'leadCapture.marketingOptIn', section: 'leadCapture', label: 'Marketing opt-in question', keywords: ['consent', 'opt-in', 'offers', 'newsletter'] },
  { id: 'qualification.enabled', section: 'qualification', label: 'Qualify leads', keywords: ['qualification on'] },
  { id: 'qualification.questions', section: 'qualification', label: 'Qualifying questions', keywords: ['questions', 'budget', 'timeline'] },
  { id: 'qualification.rules', section: 'qualification', label: 'Scoring rules', keywords: ['score', 'points', 'disqualify'] },
  { id: 'qualification.thresholds', section: 'qualification', label: 'Score thresholds', keywords: ['hot', 'warm', 'cold', 'qualified at'] },
  { id: 'qualification.outcomes', section: 'qualification', label: 'Outcomes', keywords: ['when qualified', 'when disqualified', 'lifecycle stage', 'tags'] },
  { id: 'qualification.qualifiedNextStep', section: 'qualification', label: 'Next step for qualified leads', keywords: ['next step', 'offer booking'] },
  { id: 'qualification.disqualifiedMessage', section: 'qualification', label: 'Message for disqualified leads', keywords: ['disqualified', 'closing message'] },
  { id: 'booking.enabled', section: 'booking', label: 'Book appointments', keywords: ['booking on', 'appointments'] },
  { id: 'booking.calendarId', section: 'booking', label: 'Calendar', keywords: ['availability', 'open times', 'slots'] },
  { id: 'booking.appointmentTitle', section: 'booking', label: 'Appointment title', keywords: ['event name'] },
  { id: 'booking.requiredFields', section: 'booking', label: 'Details required before booking', keywords: ['required fields', 'name', 'email', 'phone'] },
  { id: 'booking.requireQualification', section: 'booking', label: 'Only book qualified leads', keywords: ['qualified'] },
  { id: 'booking.allowReschedule', section: 'booking', label: 'Allow rescheduling', keywords: ['reschedule', 'move appointment'] },
  { id: 'booking.allowCancel', section: 'booking', label: 'Allow cancelling', keywords: ['cancel', 'cancellation'] },
  { id: 'handoff.enabled', section: 'handoff', label: 'Allow handoff', keywords: ['talk to a person', 'handoff on'] },
  { id: 'handoff.keywords', section: 'handoff', label: 'Trigger phrases', keywords: ['keywords', 'talk to a human'] },
  { id: 'handoff.message', section: 'handoff', label: 'Handoff message', keywords: ['transfer message'] },
  { id: 'handoff.notifyTeam', section: 'handoff', label: 'Notify the team', keywords: ['alert', 'notification', 'email the team'] },
  { id: 'handoff.waitMinutes', section: 'handoff', label: 'If nobody replies', keywords: ['wait', 'timeout', 'escalate', 'fallback', 'overdue'] },
  { id: 'handoff.respectTeamHours', section: 'handoff', label: 'Away message outside team hours', keywords: ['hours', 'away', 'offline', 'closed'] },
  { id: 'guardrails.stayOnTopic', section: 'guardrails', label: 'Stay on topic', keywords: ['off topic', 'focus'] },
  { id: 'guardrails.forbiddenTopics', section: 'guardrails', label: 'Forbidden topics', keywords: ['avoid', 'banned topics', 'competitors'] },
  { id: 'guardrails.unknownAnswer', section: 'guardrails', label: "When it doesn't know the answer", keywords: ['unknown answer', "don't know", 'fallback'] },
  { id: 'guardrails.maxAiReplies', section: 'guardrails', label: 'Max AI replies per conversation', keywords: ['reply limit', 'limit'] },
  { id: 'actions.tools', section: 'actions', label: 'Tools', keywords: ['abilities', 'what it may do'] },
  { id: 'actions.crm', section: 'actions', label: 'CRM actions', keywords: ['lifecycle stages', 'owners', 'assign', 'deals', 'pipeline', 'remove tags'] },
  { id: 'actions.askFirst', section: 'actions', label: 'Ask the team first', keywords: ['approvals', 'approve', 'confirm first'] },
  { id: 'actions.tags', section: 'actions', label: 'Allowed tags', keywords: ['tags', 'create tags'] },
  { id: 'actions.workflows', section: 'actions', label: 'Workflows', keywords: ['n8n', 'webhooks'] },
  { id: 'model.model', section: 'model', label: 'Model override', keywords: ['gpt', 'claude', 'openai', 'anthropic'] },
  { id: 'model.effort', section: 'model', label: 'Reasoning effort', keywords: ['effort', 'thinking'] },
  { id: 'model.maxOutputTokens', section: 'model', label: 'Max output tokens', keywords: ['tokens', 'reply size'] },
];

export const SECTIONS: SectionInfo[] = SECTION_GROUPS.flatMap((g) => g.sections);

/** Config sections the save sends whole when changed. */
export const CONFIG_SECTIONS: BotConfigSection[] = [
  'persona',
  'conversationStarters',
  'goals',
  'instructions',
  'business',
  'leadCapture',
  'qualification',
  'booking',
  'handoff',
  'guardrails',
  'actions',
];

export function sectionInfo(id: SectionId): SectionInfo {
  return SECTIONS.find((s) => s.id === id)!;
}

export function isEditorView(value: string | null): value is EditorView {
  return value === 'overview' || SECTIONS.some((s) => s.id === value);
}

// ---------- Validation errors → sections ----------

function sectionOfName(name: string): SectionId | null {
  if ((CONFIG_SECTIONS as string[]).includes(name)) return name as SectionId;
  if (name === 'model' || name === 'effort' || name === 'maxOutputTokens') return 'model';
  if (name === 'knowledgeBaseIds') return 'knowledge';
  if (name === 'customFields' || name === 'unknown custom fields') return 'leadCapture';
  if (name === 'unknown workflow keys') return 'actions';
  return null;
}

/** The section a server validation error points at (paths like `qualification.rules.0.value`, messages like "booking: …"). */
export function sectionOfError(d: ErrorDetail): SectionId | null {
  const path = d.path.startsWith('config.') ? d.path.slice(7) : d.path;
  const fromPath = path && path !== 'config' ? sectionOfName(path.split('.')[0]!) : null;
  return fromPath ?? sectionOfName(d.message.split(/[:.]/)[0]!.trim());
}

/** The error's message without a leading "section: " (the section is shown beside it). */
export function errorText(d: ErrorDetail): string {
  const prefixed = /^([A-Za-z]+):\s*([\s\S]*)$/.exec(d.message);
  const message = prefixed && sectionOfName(prefixed[1]!) ? prefixed[2]! : d.message;
  return message.charAt(0).toUpperCase() + message.slice(1);
}

// ---------- Status in the menu ----------

export interface SectionStatus {
  label: string;
  tone: 'on' | 'off' | 'neutral';
}

/** What the website chat would show: enabled starters ("talk to the team" ones need handoff on). */
export function shownStarters(config: BotConfig): number {
  return (config.conversationStarters ?? []).filter((s) => s.enabled && (s.action !== 'handoff' || config.handoff.enabled)).length;
}

export function sectionStatus(id: SectionId, draft: BotDraft): SectionStatus | null {
  const c = draft.config;
  const onOff = (on: boolean): SectionStatus => (on ? { label: 'On', tone: 'on' } : { label: 'Off', tone: 'off' });
  switch (id) {
    case 'leadCapture':
      return onOff(c.leadCapture.enabled);
    case 'qualification':
      return onOff(c.qualification.enabled);
    case 'booking':
      return onOff(c.booking.enabled);
    case 'handoff':
      return onOff(c.handoff.enabled);
    case 'conversationStarters': {
      const shown = shownStarters(c);
      return shown ? { label: String(shown), tone: 'neutral' } : null;
    }
    case 'knowledge':
      return draft.knowledgeBaseIds.length ? { label: String(draft.knowledgeBaseIds.length), tone: 'neutral' } : null;
    case 'model':
      return { label: draft.model.trim() || draft.effort ? 'Custom' : 'Default', tone: 'neutral' };
    default:
      return null;
  }
}

// ---------- The overview's essentials ----------

export interface Essential {
  id: string;
  title: string;
  icon: LucideIcon;
  /** The section its button opens. */
  section: SectionId;
  done: boolean;
  summary: string;
  /** Said in the overview's header when this is the next thing to do. */
  nextStep: string;
  /** The button when it isn't done ("Set up booking"). */
  action: string;
  /** A second section it covers, linked under the summary. */
  also?: { label: string; section: SectionId };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** What lead capture asks for ("Asks for name and email; phone is optional."); null when it has no fields. */
export function askedFor(lc: LeadCapture, customFields: CustomFieldDef[]): string | null {
  if (!lc.fields.length) return null;
  const fieldName = (key: string) =>
    (STANDARD_LEAD_FIELDS as readonly string[]).includes(key) ? key : (customFields.find((f) => f.key === key)?.label.toLowerCase() ?? key);
  const required = lc.fields.filter((f) => f.required).map((f) => fieldName(f.field));
  const optional = lc.fields.filter((f) => !f.required).map((f) => fieldName(f.field));
  return required.length
    ? `Asks for ${joinAnd(required)}${optional.length ? `; ${joinAnd(optional)} ${optional.length === 1 ? 'is' : 'are'} optional` : ''}.`
    : `Asks for ${joinAnd(optional)} when it fits.`;
}

const TONE_WORDS: Record<BotConfig['persona']['tone'], string> = {
  friendly: 'Friendly',
  professional: 'Professional',
  casual: 'Casual',
  enthusiastic: 'Enthusiastic',
  empathetic: 'Empathetic',
};
const LENGTH_WORDS: Record<BotConfig['persona']['responseLength'], string> = { short: 'short', medium: 'medium-length', detailed: 'detailed' };

/**
 * The parts every bot needs, done or not, worked out from the settings alone. Booking counts only when the
 * organization has a calendar: a business that doesn't take bookings can still be fully set up.
 */
export function essentials(draft: BotDraft, ctx: EditorContext): Essential[] {
  const c = draft.config;
  const name = c.persona.assistantName.trim() || 'your assistant';
  const list: Essential[] = [];

  const identityDone = Boolean(c.persona.assistantName.trim() && c.persona.greeting.trim());
  list.push({
    id: 'identity',
    title: 'Identity & voice',
    icon: UserRound,
    section: 'persona',
    done: identityDone,
    summary: identityDone
      ? `${c.persona.assistantName.trim()}, ${c.persona.role.trim() || 'assistant'}. ${TONE_WORDS[c.persona.tone]} tone, ${LENGTH_WORDS[c.persona.responseLength]} replies.`
      : 'Give your assistant a name and a greeting.',
    nextStep: 'Give your assistant a name and a greeting.',
    action: 'Set up identity',
  });

  const b = c.business;
  const hasBusiness = [b.description, b.services, b.hours, b.location, b.website, b.phone, b.email, b.extraFacts].some((v) => v.trim());
  const kbCount = draft.knowledgeBaseIds.length;
  list.push({
    id: 'knows',
    title: `What ${name} knows`,
    icon: BookOpen,
    section: 'business',
    done: hasBusiness || kbCount > 0,
    summary:
      hasBusiness && kbCount
        ? `Your business info and ${plural(kbCount, 'knowledge base')}.`
        : hasBusiness
          ? 'Your business info. No knowledge base yet.'
          : kbCount
            ? `${plural(kbCount, 'knowledge base')}. No business info yet.`
            : 'Nothing yet.',
    nextStep: `Add your business info or a knowledge base so ${name} can answer questions correctly.`,
    action: 'Add business info',
    also: { label: 'Knowledge bases', section: 'knowledge' },
  });

  const shown = shownStarters(c);
  list.push({
    id: 'starters',
    title: 'Conversation starters',
    icon: MessageCircleMore,
    section: 'conversationStarters',
    done: shown > 0,
    summary: shown ? `${plural(shown, 'quick option')} under the greeting.` : 'None yet: offer visitors a few one-click options.',
    nextStep: 'Add a few conversation starters so visitors can begin with one click.',
    action: 'Add starters',
  });

  const lc = c.leadCapture;
  list.push({
    id: 'leadCapture',
    title: 'Lead capture',
    icon: IdCard,
    section: 'leadCapture',
    done: lc.enabled && lc.fields.length > 0,
    summary: !lc.enabled ? "Off: visitors' contact details aren't collected." : (askedFor(lc, ctx.customFields) ?? 'On, but no fields to ask for.'),
    nextStep: `Turn on lead capture so ${name} collects contact details.`,
    action: 'Set up lead capture',
  });

  if (ctx.calendars.length) {
    const calendar = ctx.calendars.find((cal) => cal.id === c.booking.calendarId);
    list.push({
      id: 'booking',
      title: 'Booking',
      icon: CalendarCheck,
      section: 'booking',
      done: c.booking.enabled && Boolean(calendar),
      summary: !c.booking.enabled
        ? `Off: let ${name} find open times and book visits.`
        : calendar
          ? `Books visits on ${calendar.name}.`
          : 'On, but no calendar picked.',
      nextStep: `Turn on booking so ${name} can fill your calendar, not just answer questions.`,
      action: 'Set up booking',
    });
  }

  list.push({
    id: 'handoff',
    title: 'Handoff',
    icon: Headset,
    section: 'handoff',
    done: c.handoff.enabled,
    summary: c.handoff.enabled
      ? `Hands the chat to your team when asked${c.handoff.notifyTeam ? ', and tells them' : ''}.`
      : "Off: visitors can't reach a person.",
    nextStep: 'Turn on handoff so visitors can reach your team.',
    action: 'Set up handoff',
  });

  return list;
}

/** The overview's "More settings": everything that isn't an essential, with a short state. */
export function moreSettings(draft: BotDraft, ctx: EditorContext): Array<{ section: SectionId; summary: string }> {
  const c = draft.config;
  const rows: Array<{ section: SectionId; summary: string }> = [
    { section: 'goals', summary: c.goals.primary.trim() || 'Tell it what to work towards' },
    { section: 'instructions', summary: c.instructions.trim() ? 'Your own rules are set' : 'Extra rules in your own words' },
    {
      section: 'qualification',
      summary: c.qualification.enabled ? `On · ${plural(c.qualification.questions.length, 'question')}` : 'Off · rank leads with a few questions',
    },
    {
      section: 'guardrails',
      summary: `${c.guardrails.stayOnTopic ? 'Stays on topic' : 'Answers any topic'}${c.guardrails.forbiddenTopics.length ? ` · avoids ${plural(c.guardrails.forbiddenTopics.length, 'topic')}` : ''}`,
    },
    { section: 'actions', summary: 'What it may do: tools, tags, workflows' },
    { section: 'model', summary: draft.model.trim() || (draft.effort ? `Server model · ${draft.effort} effort` : 'Server default') },
  ];
  // Without a calendar, booking isn't an essential; it's still here to set up.
  if (!ctx.calendars.length) rows.splice(2, 0, { section: 'booking', summary: 'Add a calendar to let it book visits' });
  return rows;
}

// ---------- Settings search ----------

export interface SearchResult {
  view: EditorView;
  /** The setting to jump to in that section (a SETTINGS id); null opens the section at its top. */
  setting: string | null;
  label: string;
  /** Where it is ("Conversations", or a setting's section), and the word that matched when it isn't in the label. */
  where: string;
  matched: string | null;
  icon: LucideIcon;
}

const MAX_RESULTS = 25;

/**
 * Sections and single settings whose name or other words match what was typed, best first (a section before its
 * settings when they match as well); every section, in menu order, when nothing is typed.
 */
export function searchSettings(query: string, assistantName: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  const sections: Array<Omit<SearchResult, 'matched'> & { keywords: string[] }> = [
    { view: 'overview', setting: null, label: OVERVIEW.label, where: 'Setup', icon: OVERVIEW.icon, keywords: OVERVIEW.keywords },
    ...SECTION_GROUPS.flatMap((g) =>
      g.sections.map((s) => ({ view: s.id, setting: null, label: s.label, where: g.label(assistantName), icon: s.icon, keywords: s.keywords })),
    ),
  ];
  if (!q) return sections.map((r) => ({ view: r.view, setting: null, label: r.label, where: r.where, icon: r.icon, matched: null }));
  const settings = SETTINGS.map((s) => {
    const section = sectionInfo(s.section);
    return { view: s.section, setting: s.id, label: s.label, where: section.label, icon: section.icon, keywords: s.keywords };
  });
  const scored: Array<{ result: SearchResult; score: number; order: number }> = [];
  [...sections, ...settings].forEach(({ keywords, ...r }, order) => {
    const label = r.label.toLowerCase();
    const keyword = keywords.find((k) => k.toLowerCase().startsWith(q)) ?? keywords.find((k) => k.toLowerCase().includes(q));
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : keyword?.toLowerCase().startsWith(q) ? 2 : keyword ? 3 : -1;
    if (score >= 0) scored.push({ result: { ...r, matched: score >= 2 ? keyword! : null }, score, order });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, MAX_RESULTS)
    .map((s) => s.result);
}
