import { useAiConfig } from '../../lib/queries';
import { ArrowDown, ArrowUp, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Button, Card, Checkbox, ChipsInput, cx, EmptyState, Field, IconButton, Input, NumberInput, Select, Textarea, Toggle } from '../../components/ui';
import { initialsOf, slugify, TOOL_LABELS } from '../../lib/format';
import { Link } from '../../lib/router';
import { askedFor } from './editorNav';
import {
  ASK_FIRST_TOOLS,
  CRM_TOOL_KEYS,
  EFFORTS,
  STANDARD_LEAD_FIELDS,
  TOOL_KEYS,
  type Actions,
  type Booking,
  type BookingRequiredField,
  type BusinessProfile,
  type Calendar,
  type ConversationStarter,
  type CustomFieldDef,
  type Effort,
  type Goals,
  type Guardrails,
  type Handoff,
  type KnowledgeBase,
  type LeadCapture,
  type LeadCaptureField,
  type LeadTiming,
  type Persona,
  type Qualification,
  type QualificationOutcome,
  type QualificationQuestion,
  type QualificationRule,
  type QuestionType,
  type RuleOperator,
  type RuleValue,
  type StarterAction,
  type Member,
  type Pipeline,
  type Tag,
  type Workflow,
} from '../../lib/types';

export interface EditorContext {
  customFields: CustomFieldDef[];
  calendars: Calendar[];
  workflows: Workflow[] | null; // null = not allowed to list (non-admin)
  tags: Tag[];
  lifecycleStages: string[];
  knowledgeBases: KnowledgeBase[];
  /** The organization's other bots: their questions share the contact's answers under the same key. */
  otherBots: Array<{ name: string; questions: QualificationQuestion[] }>;
  /** Used when a bot has no company name of its own. */
  organizationName: string;
  /** The assistant's name as help text uses it: "Maya", or "your assistant" before it has one. */
  assistantName: string;
  /** Who the assistant may make a contact's owner. */
  members: Member[];
  /** Where the assistant may open deals. */
  pipelines: Pipeline[];
}

interface SectionProps<T> {
  value: T;
  onChange: (value: T) => void;
  ctx: EditorContext;
}

/** Side by side when the card is wide enough, one under another when it's narrow. */
function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div className={cx('grid gap-4', cols === 2 ? '@sm:grid-cols-2' : cols === 3 ? '@sm:grid-cols-3' : 'grid-cols-1')}>{children}</div>;
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={cx('text-caption tabular-nums', value.length > max ? 'text-danger-text' : 'text-muted')}>
      {value.length.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where the settings search can jump to: `id` is one of the editor's SETTINGS. */
function Setting({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  return (
    <div data-setting={id} className={cx('rounded-lg', className)}>
      {children}
    </div>
  );
}

/** A card of related settings under a plain heading; `aside` sits beside the heading (a button, a counter). */
function SettingsCard({
  title,
  description,
  aside,
  setting,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  /** Makes the whole card a search target. */
  setting?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-setting={setting} className="space-y-4 rounded-[14px] border border-border bg-surface p-5 @container">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-[15px] leading-5 font-semibold text-fg">
            {title}
          </h3>
          {description && <p className="mt-1 text-body-sm leading-5 text-muted">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** A feature that can be switched off: its switch, and a line on what it does right now, head the card. */
function FeatureCard({
  title,
  summary,
  checked,
  onChange,
  setting,
  children,
}: {
  title: string;
  summary: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  setting: string;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-[14px] border border-border bg-surface p-5 @container">
      <div data-setting={setting} className="flex items-start justify-between gap-4 rounded-lg">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[15px] leading-5 font-semibold text-fg">
            {title}
          </h3>
          <p className="mt-1 text-body-sm leading-5 text-muted">
            <span className={cx('font-semibold', checked ? 'text-success-text' : 'text-fg-2')}>{checked ? 'On' : 'Off'}</span>
            {' · '}
            {summary}
          </p>
        </div>
        <Toggle className="pt-0.5" checked={checked} onChange={onChange} ariaLabel={title} />
      </div>
      {children && <div className="space-y-4 border-t border-border pt-4">{children}</div>}
    </section>
  );
}

/** One of a few choices, as pills or as small cards with a line each (radio buttons underneath). */
function Choices<T extends string>({
  legend,
  value,
  options,
  onChange,
  variant = 'pills',
}: {
  legend: string;
  value: T;
  options: Array<{ value: T; label: string; description?: string }>;
  onChange: (value: T) => void;
  variant?: 'pills' | 'cards';
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-2 text-body-sm font-medium text-fg-2">{legend}</legend>
      <div className={variant === 'pills' ? 'flex flex-wrap gap-2' : 'grid gap-2.5 @sm:grid-cols-3'}>
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              className={cx(
                'cursor-pointer border transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
                variant === 'pills' ? 'rounded-full px-3.5 py-1.5 text-body-sm font-medium' : 'rounded-xl px-3.5 py-2.5',
                checked ? 'border-accent bg-accent-soft text-accent-text' : 'border-border-strong bg-surface text-fg-2 hover:border-accent/50 hover:text-fg',
              )}
            >
              <input type="radio" name={name} value={o.value} checked={checked} onChange={() => onChange(o.value)} className="sr-only" />
              {variant === 'cards' ? (
                <>
                  <span className="block text-body-sm font-semibold">{o.label}</span>
                  {o.description && <span className={cx('block text-caption', checked ? 'text-accent-text' : 'text-muted')}>{o.description}</span>}
                </>
              ) : (
                o.label
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A box with a dashed edge for "nothing here yet". */
function EmptyBox({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border-strong">{children}</div>;
}

// ---------- Persona ----------

const TONES: Array<{ value: Persona['tone']; label: string }> = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'casual', label: 'Casual' },
  { value: 'enthusiastic', label: 'Enthusiastic' },
  { value: 'empathetic', label: 'Empathetic' },
];

const LANGUAGES = ['auto', 'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Hindi', 'Arabic', 'Chinese', 'Japanese'];

export interface PersonalityTemplate {
  id: string;
  label: string;
  description: string;
  persona: Pick<Persona, 'role' | 'tone' | 'responseLength' | 'personality'>;
  /** Becomes the main goal. */
  goal: string;
}

/** Starting points for a new assistant; applied in the editor only, saved like any other change. */
export const PERSONALITY_TEMPLATES: PersonalityTemplate[] = [
  {
    id: 'receptionist',
    label: 'Receptionist',
    description: 'Welcoming and organized: answers questions and books visits.',
    persona: {
      role: 'receptionist',
      tone: 'friendly',
      responseLength: 'short',
      personality: 'Warm, welcoming and organized, like a great front desk. Makes people feel looked after and keeps things simple.',
    },
    goal: 'Answer questions and help visitors book an appointment.',
  },
  {
    id: 'sales',
    label: 'Sales assistant',
    description: 'Finds out what people need and recommends the right option.',
    persona: {
      role: 'sales assistant',
      tone: 'enthusiastic',
      responseLength: 'medium',
      personality: 'Confident and genuinely helpful. Asks about needs before recommending, explains the value in plain words, and is never pushy.',
    },
    goal: 'Understand what the visitor needs, recommend the right option and collect their details for a quote.',
  },
  {
    id: 'support',
    label: 'Support agent',
    description: 'Patient and clear: solves problems or hands them to the team.',
    persona: {
      role: 'support agent',
      tone: 'empathetic',
      responseLength: 'medium',
      personality: 'Patient, calm and clear. Acknowledges the problem, gives step-by-step help and checks that it worked.',
    },
    goal: "Resolve the customer's question, or hand it to the team when it needs a person.",
  },
  {
    id: 'booking',
    label: 'Booking coordinator',
    description: 'Efficient and precise about appointments.',
    persona: {
      role: 'booking coordinator',
      tone: 'professional',
      responseLength: 'short',
      personality: 'Efficient and precise. Offers clear options, confirms every detail and never leaves a booking half-done.',
    },
    goal: 'Book, move or cancel appointments quickly and confirm every detail.',
  },
];

const LENGTHS: Array<{ value: Persona['responseLength']; label: string; description: string }> = [
  { value: 'short', label: 'Short', description: 'One or two sentences' },
  { value: 'medium', label: 'Medium', description: 'A short paragraph' },
  { value: 'detailed', label: 'Detailed', description: 'Several paragraphs' },
];

/** "Use a template": the templates in a menu; picking one fills the draft (the editor asks first when that replaces text). */
function TemplateMenu({ onApply }: { onApply: (template: PersonalityTemplate) => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Opened, the first template takes the focus; a press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Back on the button, so a confirmation that follows returns the focus there too.
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') focus(at + 1);
    else if (e.key === 'ArrowUp') focus(at - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(items.length - 1);
    else if (e.key === 'Escape') close();
    else {
      if (e.key === 'Tab') setOpen(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        icon={<LayoutTemplate className="size-4" aria-hidden />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Use a template
      </Button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Templates"
          onKeyDown={onKeyDown}
          className="absolute top-full right-0 z-20 mt-2 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-pop"
        >
          {PERSONALITY_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close();
                onApply(t);
              }}
              className="flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus:bg-accent-soft"
            >
              <span className="text-body-sm font-semibold text-fg">{t.label}</span>
              <span className="text-caption text-muted">{t.description}</span>
            </button>
          ))}
          <p className="mt-1 border-t border-border px-3 pt-2 pb-1 text-caption text-muted">
            Fills the role, tone, reply length, personality and main goal. Nothing is saved until you press Save.
          </p>
        </div>
      )}
    </div>
  );
}

/** The greeting as the website chat shows it: the chat's picture, the bubble, and the assistant's name. */
function GreetingPreview({ greeting, chatName, assistantName }: { greeting: string; chatName: string; assistantName: string }) {
  return (
    <div aria-hidden className="rounded-xl bg-surface-2 p-4">
      <p className="mb-3 text-label font-semibold tracking-wider text-muted uppercase">Preview</p>
      <div className="flex items-end gap-2">
        <span className="mb-5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-text">
          {initialsOf(chatName)}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="rounded-[18px] rounded-bl-md bg-surface px-3.5 py-2 text-body leading-[21px] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {greeting.trim() ? greeting : <span className="text-muted">Your greeting shows here.</span>}
          </p>
          <p className="px-1 text-label leading-4 text-muted">{assistantName} · Just now</p>
        </div>
      </div>
    </div>
  );
}

export function PersonaSection({ value, onChange, ctx, onApplyTemplate }: SectionProps<Persona> & { onApplyTemplate: (template: PersonalityTemplate) => void }) {
  const set = <K extends keyof Persona>(key: K, v: Persona[K]) => onChange({ ...value, [key]: v });
  const name = value.assistantName.trim();
  const company = value.companyName.trim() || ctx.organizationName;
  const language = value.language.trim();
  const chips = [
    TONES.find((t) => t.value === value.tone)?.label ?? value.tone,
    `${LENGTHS.find((l) => l.value === value.responseLength)?.label ?? value.responseLength} replies`,
    !language || language.toLowerCase() === 'auto' ? "Replies in the visitor's language" : `Replies in ${language}`,
    value.useEmojis ? 'Uses emoji' : 'No emoji',
  ];
  return (
    <>
      <section aria-label={`How ${ctx.assistantName} comes across`} className="flex flex-wrap items-center gap-4 rounded-[14px] border border-border bg-surface p-5">
        <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-ai-soft font-display text-2xl font-bold text-ai-text ring-1 ring-ai/30">
          {(name || '?').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <div>
            <p className="truncate text-heading font-semibold text-fg">{name || 'No name yet'}</p>
            <p className="truncate text-body-sm text-muted">
              {capitalize(value.role.trim() || 'assistant')}
              {company && ` at ${company}`}
            </p>
          </div>
          <ul aria-label="Voice" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <li key={c} className="rounded-full bg-surface-2 px-2.5 text-caption leading-[22px] font-medium text-fg-2">
                {c}
              </li>
            ))}
          </ul>
        </div>
        <Setting id="persona.template" className="self-start">
          <TemplateMenu onApply={onApplyTemplate} />
        </Setting>
      </section>

      <SettingsCard title="Identity" description="The name, company and role visitors see.">
        <Grid>
          <Setting id="persona.assistantName">
            <Field label="Assistant name" hint="Shown in the chat header and used when it introduces itself.">
              <Input value={value.assistantName} maxLength={60} onChange={(e) => set('assistantName', e.target.value)} />
            </Field>
          </Setting>
          <Setting id="persona.companyName">
            <Field label="Company name" hint={ctx.organizationName ? `Leave empty to use “${ctx.organizationName}”.` : undefined}>
              <Input value={value.companyName} maxLength={120} placeholder={ctx.organizationName} onChange={(e) => set('companyName', e.target.value)} />
            </Field>
          </Setting>
        </Grid>
        <Setting id="persona.role">
          <Field label="Role" hint="e.g. patient coordinator, sales assistant.">
            <Input value={value.role} maxLength={120} onChange={(e) => set('role', e.target.value)} />
          </Field>
        </Setting>
      </SettingsCard>

      <SettingsCard title="Voice" description={`How ${ctx.assistantName} talks. Save, then try it in the test chat.`}>
        <Setting id="persona.tone">
          <Choices legend="Tone" value={value.tone} options={TONES} onChange={(v) => set('tone', v)} />
        </Setting>
        <Setting id="persona.responseLength">
          <Choices legend="Reply length" variant="cards" value={value.responseLength} options={LENGTHS} onChange={(v) => set('responseLength', v)} />
        </Setting>
        <Grid>
          <Setting id="persona.language">
            <Field label="Language" hint="“auto” replies in the visitor's language. Or type a language name or code.">
              <Input list="bot-languages" value={value.language} maxLength={40} onChange={(e) => set('language', e.target.value)} />
            </Field>
          </Setting>
          <Setting id="persona.useEmojis">
            <Toggle label="Use emojis" description="Allow the occasional emoji in replies." checked={value.useEmojis} onChange={(v) => set('useEmojis', v)} />
          </Setting>
        </Grid>
        <datalist id="bot-languages">
          {LANGUAGES.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <Setting id="persona.personality">
          <Field label="Personality" hint="How it should come across, in your own words. Adds to the tone above (up to 600 characters).">
            <Textarea
              rows={3}
              maxLength={600}
              value={value.personality}
              placeholder="e.g. Warm and reassuring, a little playful, like our front desk."
              onChange={(e) => set('personality', e.target.value)}
            />
          </Field>
        </Setting>
      </SettingsCard>

      <SettingsCard title="Greeting" description="The first message visitors see when they open the chat.">
        <div className="grid items-start gap-4 @lg:grid-cols-2">
          <Setting id="persona.greeting">
            <Field label="Greeting message">
              <Textarea rows={4} value={value.greeting} maxLength={500} onChange={(e) => set('greeting', e.target.value)} />
            </Field>
          </Setting>
          <GreetingPreview greeting={value.greeting} chatName={company || name} assistantName={name || 'Assistant'} />
        </div>
      </SettingsCard>
    </>
  );
}

// ---------- Goals ----------

export function GoalsSection({ value, onChange, ctx }: SectionProps<Goals>) {
  const setOther = (i: number, text: string) => onChange({ ...value, secondary: value.secondary.map((g, j) => (j === i ? text : g)) });
  return (
    <SettingsCard title={`What ${ctx.assistantName} works towards`} description="It never pushes: the visitor's question always comes first.">
      <Setting id="goals.primary">
        <Field label="Main goal" hint="One sentence, e.g. “Get visitors to book a free consultation.”">
          <Input value={value.primary} maxLength={300} placeholder="e.g. Get visitors to book a free consultation." onChange={(e) => onChange({ ...value, primary: e.target.value })} />
        </Field>
      </Setting>
      <Setting id="goals.secondary" className="space-y-2">
        <p className="text-body-sm font-medium text-fg-2">More goals</p>
        {value.secondary.map((goal, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input aria-label={`Goal ${i + 2}`} value={goal} maxLength={200} onChange={(e) => setOther(i, e.target.value)} />
            <IconButton label={`Remove goal ${i + 2}`} size="sm" onClick={() => onChange({ ...value, secondary: value.secondary.filter((_, j) => j !== i) })}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={value.secondary.length >= 5} onClick={() => onChange({ ...value, secondary: [...value.secondary, ''] })}>
          Add goal
        </Button>
        <p className="text-caption text-muted">Up to 5, e.g. “Mention the new-patient offer when it fits.”</p>
      </Setting>
      <p className="text-body-sm text-muted">
        Built-in goals are added for what you switch on: answering from your information, capturing details, qualifying, booking and handing off.
      </p>
    </SettingsCard>
  );
}

// ---------- Instructions ----------

export function InstructionsSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SettingsCard
      setting="instructions"
      title="Your instructions"
      description="Write them as you would brief a new team member. The assistant already knows how to capture leads, qualify and book — no need to explain that."
      aside={<Counter value={value} max={12000} />}
    >
      <Textarea
        aria-label="Custom instructions"
        rows={18}
        className="font-mono text-body-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'e.g. When someone asks about pricing, give the range and offer a free consultation.\nNever quote prices for custom work.'}
      />
    </SettingsCard>
  );
}

// ---------- Business ----------

export function BusinessSection({ value, onChange }: SectionProps<BusinessProfile>) {
  const set = <K extends keyof BusinessProfile>(key: K, v: string) => onChange({ ...value, [key]: v });
  return (
    <>
      <SettingsCard title="About your business" description="In your own words. Short and specific works best.">
        <Setting id="business.description">
          <Field label="What you do">
            <Textarea rows={3} maxLength={4000} value={value.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
        </Setting>
        <Setting id="business.services">
          <Field label="Services / products">
            <Textarea rows={3} maxLength={4000} value={value.services} onChange={(e) => set('services', e.target.value)} />
          </Field>
        </Setting>
        <Setting id="business.extraFacts">
          <Field label="Other facts" hint="Parking, payment options, policies — short facts the assistant should know.">
            <Textarea rows={4} maxLength={8000} value={value.extraFacts} onChange={(e) => set('extraFacts', e.target.value)} />
          </Field>
        </Setting>
      </SettingsCard>
      <SettingsCard title="Hours and contact details" description="What visitors ask for most. Leave out anything you'd rather not share.">
        <Grid>
          <Setting id="business.hours">
            <Field label="Opening hours">
              <Input maxLength={1000} value={value.hours} onChange={(e) => set('hours', e.target.value)} />
            </Field>
          </Setting>
          <Setting id="business.location">
            <Field label="Location">
              <Input maxLength={500} value={value.location} onChange={(e) => set('location', e.target.value)} />
            </Field>
          </Setting>
          <Setting id="business.website">
            <Field label="Website">
              <Input type="url" maxLength={300} value={value.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
            </Field>
          </Setting>
          <Setting id="business.phone">
            <Field label="Phone">
              <Input maxLength={60} value={value.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
          </Setting>
          <Setting id="business.email">
            <Field label="Email">
              <Input type="email" maxLength={200} value={value.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
          </Setting>
        </Grid>
      </SettingsCard>
    </>
  );
}

// ---------- Lead capture ----------

const TIMINGS: Array<{ value: LeadTiming; label: string }> = [
  { value: 'early', label: 'Early in the chat' },
  { value: 'natural', label: 'When it fits naturally' },
  { value: 'before_booking', label: 'Only before booking' },
];

export function LeadCaptureSection({ value, onChange, ctx }: SectionProps<LeadCapture>) {
  const options: Array<{ key: string; label: string }> = [
    ...STANDARD_LEAD_FIELDS.map((f) => ({ key: f as string, label: f.charAt(0).toUpperCase() + f.slice(1) })),
    ...ctx.customFields.map((f) => ({ key: f.key, label: `${f.label} (custom)` })),
  ];
  const used = new Set(value.fields.map((f) => f.field));
  const setField = (i: number, patch: Partial<LeadCaptureField>) => onChange({ ...value, fields: value.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const nextFree = options.find((o) => !used.has(o.key));
  return (
    <>
      <FeatureCard
        title="Capture leads"
        setting="leadCapture.enabled"
        checked={value.enabled}
        onChange={(v) => onChange({ ...value, enabled: v })}
        summary={value.enabled ? (askedFor(value, ctx.customFields) ?? 'No details to ask for yet: add one below.') : "Visitors' contact details aren't collected."}
      >
        <Setting id="leadCapture.fields">
          <Card className={cx(!value.enabled && 'opacity-60')}>
            {/* On a very narrow card the table scrolls sideways by itself rather than squeezing its menus. */}
            <div className="overflow-x-auto">
              <div className="min-w-[27rem]">
                <div className="grid grid-cols-[minmax(7rem,1fr)_4.5rem_minmax(9rem,12rem)_2.25rem] items-center gap-3 border-b border-border px-4 py-2 text-caption font-medium text-muted">
                  <span>Field</span>
                  <span>Required</span>
                  <span>When to ask</span>
                  <span className="sr-only">Remove</span>
                </div>
                {value.fields.length === 0 && <p className="px-4 py-6 text-center text-body-sm text-muted">No fields — add at least a name or email so leads can be followed up.</p>}
                {value.fields.map((f, i) => (
                  <div key={i} className="grid grid-cols-[minmax(7rem,1fr)_4.5rem_minmax(9rem,12rem)_2.25rem] items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
                    <Select aria-label="Field" value={f.field} onChange={(e) => setField(i, { field: e.target.value })}>
                      {!options.some((o) => o.key === f.field) && <option value={f.field}>{f.field} (unknown)</option>}
                      {options.map((o) => (
                        <option key={o.key} value={o.key} disabled={o.key !== f.field && used.has(o.key)}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    <Toggle checked={f.required} onChange={(v) => setField(i, { required: v })} id={`lc-req-${i}`} ariaLabel={`${f.field} required`} />
                    <Select aria-label="When to ask" value={f.timing} onChange={(e) => setField(i, { timing: e.target.value as LeadTiming })}>
                      {TIMINGS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                    <IconButton label="Remove field" size="sm" onClick={() => onChange({ ...value, fields: value.fields.filter((_, j) => j !== i) })}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
              <Button
                size="sm"
                icon={<Plus className="size-3.5" />}
                disabled={!nextFree || value.fields.length >= 20}
                onClick={() => nextFree && onChange({ ...value, fields: [...value.fields, { field: nextFree.key, required: false, timing: 'natural' }] })}
              >
                Add field
              </Button>
              <Link to="/automations?tab=fields" className="text-caption text-accent-text hover:underline">
                Manage custom fields
              </Link>
            </div>
          </Card>
        </Setting>
      </FeatureCard>
      <SettingsCard title="Privacy and consent" description="Both are optional: leave a box empty to skip it.">
        <Setting id="leadCapture.consentNotice">
          <Field label="Privacy notice" hint="Mentioned when collecting details, e.g. how you use them. Informational only; leave empty to skip.">
            <Textarea rows={2} maxLength={500} value={value.consentNotice} onChange={(e) => onChange({ ...value, consentNotice: e.target.value })} />
          </Field>
        </Setting>
        <Setting id="leadCapture.marketingOptIn">
          <Field
            label="Marketing opt-in question"
            hint="Posted word for word once the visitor has shared an email or phone; their yes or no is recorded as consent, with their reply as proof. Name your business and say they can opt out anytime. Leave empty to not ask."
          >
            <Textarea
              rows={2}
              maxLength={500}
              placeholder="Would you like occasional offers from us by email or text? You can opt out anytime."
              value={value.marketingOptIn}
              onChange={(e) => onChange({ ...value, marketingOptIn: e.target.value })}
            />
          </Field>
        </Setting>
      </SettingsCard>
    </>
  );
}

// ---------- Qualification ----------

const QUESTION_TYPES: Array<{ value: QuestionType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'select', label: 'Single choice' },
  { value: 'multi_select', label: 'Multiple choice' },
  { value: 'date', label: 'Date' },
];

const OPERATORS: Array<{ value: RuleOperator; label: string }> = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'in', label: 'is one of' },
  { value: 'not_in', label: 'is not one of' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'answered', label: 'is answered' },
];

/** Keeps a rule's value in the shape its operator expects. */
function coerceRuleValue(operator: RuleOperator, value: RuleValue, question: QualificationQuestion | undefined): RuleValue {
  if (operator === 'answered') return null;
  if (operator === 'in' || operator === 'not_in') {
    if (Array.isArray(value)) return value;
    return value === null || value === '' ? [] : [String(value)];
  }
  if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
    const n = typeof value === 'number' ? value : Number(Array.isArray(value) ? value[0] : value);
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(value)) value = value[0] ?? null;
  if (question?.type === 'boolean' && operator !== 'contains') return typeof value === 'boolean' ? value : value === 'false' ? false : true;
  if (question?.type === 'number' && operator !== 'contains') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && value !== null && value !== '' ? n : null;
  }
  return value === null ? '' : String(value);
}

function RuleValueEditor({ rule, question, onChange }: { rule: QualificationRule; question: QualificationQuestion | undefined; onChange: (v: RuleValue) => void }) {
  const op = rule.operator;
  if (op === 'answered') return <span className="text-caption text-muted">—</span>;
  const options = question?.options ?? [];
  if (op === 'in' || op === 'not_in') {
    const arr = Array.isArray(rule.value) ? rule.value : [];
    return <ChipsInput ariaLabel="Values" value={arr} onChange={onChange} suggestions={options} placeholder={options.length ? 'Pick or type…' : 'Type and press Enter'} />;
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    return <NumberInput aria-label="Value" value={typeof rule.value === 'number' ? rule.value : null} allowEmpty onChange={onChange} />;
  }
  if (question?.type === 'boolean' && op !== 'contains') {
    return (
      <Select aria-label="Value" value={String(rule.value === true)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (question?.type === 'number' && op !== 'contains') {
    return <NumberInput aria-label="Value" value={typeof rule.value === 'number' ? rule.value : null} allowEmpty onChange={onChange} />;
  }
  if ((question?.type === 'select' || question?.type === 'multi_select') && options.length && op !== 'contains') {
    const v = typeof rule.value === 'string' ? rule.value : '';
    return (
      <Select aria-label="Value" value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {!options.includes(v) && v && <option value={v}>{v}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  }
  return <Input aria-label="Value" value={rule.value === null ? '' : String(rule.value)} onChange={(e) => onChange(e.target.value)} />;
}

function OutcomeEditor({ title, value, onChange, ctx }: { title: string; value: QualificationOutcome; onChange: (v: QualificationOutcome) => void; ctx: EditorContext }) {
  return (
    <Card className="space-y-3 p-4">
      <p className="text-body-sm font-semibold text-fg">{title}</p>
      <Field label="Add tags">
        <ChipsInput value={value.tags} onChange={(tags) => onChange({ ...value, tags })} suggestions={ctx.tags.map((t) => t.name)} placeholder="Tag names" />
      </Field>
      <Field label="Set lifecycle stage">
        <Select value={value.lifecycleStage ?? ''} onChange={(e) => onChange({ ...value, lifecycleStage: e.target.value || null })}>
          <option value="">Don't change</option>
          {value.lifecycleStage && !ctx.lifecycleStages.includes(value.lifecycleStage) && <option value={value.lifecycleStage}>{value.lifecycleStage}</option>}
          {ctx.lifecycleStages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      <Toggle label="Notify the team" checked={value.notifyTeam} onChange={(notifyTeam) => onChange({ ...value, notifyTeam })} />
    </Card>
  );
}

export function QualificationSection({ value, onChange, ctx }: SectionProps<Qualification>) {
  const set = <K extends keyof Qualification>(key: K, v: Qualification[K]) => onChange({ ...value, [key]: v });
  const setQuestion = (i: number, patch: Partial<QualificationQuestion>) => {
    const old = value.questions[i];
    const questions = value.questions.map((q, j) => (j === i ? { ...q, ...patch } : q));
    let rules = value.rules;
    // Renaming a question key carries its scoring rules along.
    if (old && patch.key !== undefined && patch.key !== old.key) rules = rules.map((r) => (r.questionKey === old.key ? { ...r, questionKey: patch.key! } : r));
    onChange({ ...value, questions, rules });
  };
  const moveQuestion = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.questions.length) return;
    const questions = [...value.questions];
    [questions[i], questions[j]] = [questions[j]!, questions[i]!];
    onChange({ ...value, questions });
  };
  const setRule = (i: number, patch: Partial<QualificationRule>) => onChange({ ...value, rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const questionByKey = (key: string) => value.questions.find((q) => q.key === key);
  // Another bot asking the same key differently: the contact's answer is shared, and one that doesn't fit is asked again.
  const clashes = (q: QualificationQuestion) =>
    ctx.otherBots
      .filter((b) =>
        b.questions.some(
          (o) => o.key === q.key && (o.type !== q.type || [...o.options].sort().join('\n').toLowerCase() !== [...q.options].sort().join('\n').toLowerCase()),
        ),
      )
      .map((b) => b.name);
  const newKey = () => {
    let n = value.questions.length + 1;
    while (value.questions.some((q) => q.key === `question_${n}`)) n++;
    return `question_${n}`;
  };

  const count = value.questions.length;
  return (
    <>
      <FeatureCard
        title="Qualify leads"
        setting="qualification.enabled"
        checked={value.enabled}
        onChange={(v) => set('enabled', v)}
        summary={
          !value.enabled
            ? "Leads aren't scored."
            : count
              ? `Asks ${count} question${count === 1 ? '' : 's'} and scores the answers; hot from ${value.thresholds.hot} points.`
              : 'No questions to ask yet: add one below.'
        }
      />

      <SettingsCard
        setting="qualification.questions"
        title="Questions"
        description="Asked one at a time, in this order, when it fits the conversation."
        aside={
          <Button
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={value.questions.length >= 25}
            onClick={() => set('questions', [...value.questions, { key: newKey(), question: '', type: 'text', options: [], required: true, saveToCustomField: null }])}
          >
            Add question
          </Button>
        }
      >
        {value.questions.length === 0 ? (
          <EmptyBox>
            <EmptyState title="No questions yet" description="Add questions like budget, timeline or the service they need. Each answer can add points to the lead score." />
          </EmptyBox>
        ) : (
          <div className="space-y-3">
            {value.questions.map((q, i) => (
              <Card key={i} className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-caption font-medium text-muted">{i + 1}</span>
                  <div className="grid min-w-0 flex-1 gap-3 @md:grid-cols-[1fr_180px]">
                    <Field label="Question">
                      <Input value={q.question} maxLength={300} placeholder="What's your budget?" onChange={(e) => setQuestion(i, { question: e.target.value })} />
                    </Field>
                    <Field label="Key" hint="Used in rules and exports.">
                      <Input className="font-mono text-body-sm" value={q.key} maxLength={64} onChange={(e) => setQuestion(i, { key: slugify(e.target.value) })} />
                    </Field>
                    <Field label="Answer type">
                      <Select
                        value={q.type}
                        onChange={(e) => {
                          const type = e.target.value as QuestionType;
                          setQuestion(i, { type, options: type === 'select' || type === 'multi_select' ? q.options : [] });
                        }}
                      >
                        {QUESTION_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Save answer to field">
                      <Select value={q.saveToCustomField ?? ''} onChange={(e) => setQuestion(i, { saveToCustomField: e.target.value || null })}>
                        <option value="">Don't save</option>
                        {ctx.customFields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {(q.type === 'select' || q.type === 'multi_select') && (
                      <Field label="Options" className="@md:col-span-2" error={q.options.length === 0 ? 'Add at least one option.' : null}>
                        <ChipsInput value={q.options} onChange={(options) => setQuestion(i, { options })} placeholder="Type an option and press Enter" />
                      </Field>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 pt-6">
                    <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => moveQuestion(i, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label="Move down" size="sm" disabled={i === value.questions.length - 1} onClick={() => moveQuestion(i, 1)}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton
                      label="Remove question"
                      size="sm"
                      onClick={() => onChange({ ...value, questions: value.questions.filter((_, j) => j !== i), rules: value.rules.filter((r) => r.questionKey !== q.key) })}
                    >
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                </div>
                <div className="pl-9">
                  <Toggle size="sm" label={<span className="text-body-sm font-normal">Required to qualify</span>} checked={q.required} onChange={(required) => setQuestion(i, { required })} />
                </div>
                {clashes(q).length > 0 && (
                  <p className="pl-9 text-caption text-warning-text">
                    {clashes(q).join(', ')} also {clashes(q).length === 1 ? 'uses' : 'use'} the key “{q.key}” with a different answer type or options. A contact's answer
                    under this key is shared between them, and one that doesn't fit this question is asked again. Use a different key to keep them apart.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        setting="qualification.rules"
        title="Scoring rules"
        description="Each matching rule adds (or subtracts) points. A matching disqualifier ends qualification regardless of score."
        aside={
          <Button
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={value.questions.length === 0 || value.rules.length >= 100}
            onClick={() => {
              const q = value.questions[0]!;
              set('rules', [...value.rules, { questionKey: q.key, operator: 'answered', value: null, points: 10, disqualify: false }]);
            }}
          >
            Add rule
          </Button>
        }
      >
        {value.rules.length === 0 ? (
          <EmptyBox>
            <EmptyState title="No scoring rules" description={value.questions.length ? 'Add a rule, e.g. “budget ≥ 10000 → +40 points”.' : 'Add a question first, then score its answers here.'} />
          </EmptyBox>
        ) : (
          <Card className="divide-y divide-border">
            {value.rules.map((r, i) => {
              const question = questionByKey(r.questionKey);
              return (
                <div key={i} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-8 shrink-0 text-caption font-medium text-muted">If</span>
                    <Select
                      aria-label={`Rule ${i + 1} question`}
                      className="min-w-40 flex-1"
                      value={r.questionKey}
                      onChange={(e) => {
                        const q = questionByKey(e.target.value);
                        setRule(i, { questionKey: e.target.value, value: coerceRuleValue(r.operator, r.value, q) });
                      }}
                    >
                      {!question && <option value={r.questionKey}>{r.questionKey} (missing)</option>}
                      {value.questions.map((q) => (
                        <option key={q.key} value={q.key}>
                          {q.key}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label={`Rule ${i + 1} condition`}
                      className="w-40 shrink-0"
                      value={r.operator}
                      onChange={(e) => {
                        const operator = e.target.value as RuleOperator;
                        setRule(i, { operator, value: coerceRuleValue(operator, r.value, question) });
                      }}
                    >
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    <IconButton label={`Remove rule ${i + 1}`} size="sm" onClick={() => set('rules', value.rules.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-10">
                    {r.operator !== 'answered' && (
                      <div className="min-w-44 flex-1">
                        <RuleValueEditor rule={r} question={question} onChange={(v) => setRule(i, { value: v })} />
                      </div>
                    )}
                    <span className="text-caption text-muted">then</span>
                    <NumberInput aria-label={`Rule ${i + 1} points`} className="w-20" value={r.points} step={1} onChange={(v) => setRule(i, { points: Math.round(v ?? 0) })} />
                    <span className="text-caption text-muted">points</span>
                    <Toggle size="sm" className="ml-2" label={<span className="text-caption font-normal text-fg-2">Disqualify</span>} checked={r.disqualify} onChange={(disqualify) => setRule(i, { disqualify })} />
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </SettingsCard>

      <SettingsCard setting="qualification.thresholds" title="Score thresholds" description="Hot when the score reaches the hot threshold, warm from the warm threshold, otherwise cold.">
        <Grid cols={3}>
          <Field label="Hot from" hint="Score ≥ this is hot.">
            <NumberInput value={value.thresholds.hot} step={1} onChange={(v) => set('thresholds', { ...value.thresholds, hot: Math.round(v ?? 0) })} />
          </Field>
          <Field label="Warm from" error={value.thresholds.warm > value.thresholds.hot ? 'Must not be above the hot threshold.' : null}>
            <NumberInput value={value.thresholds.warm} step={1} onChange={(v) => set('thresholds', { ...value.thresholds, warm: Math.round(v ?? 0) })} />
          </Field>
          <Field label="Qualified at" hint="Minimum score once all required questions are answered.">
            <NumberInput value={value.qualifyAt} step={1} onChange={(v) => set('qualifyAt', Math.round(v ?? 0))} />
          </Field>
        </Grid>
      </SettingsCard>

      <SettingsCard setting="qualification.outcomes" title="Outcomes" description="What happens automatically when a lead is qualified or disqualified.">
        <Grid>
          <OutcomeEditor title="When qualified" value={value.onQualified} onChange={(v) => set('onQualified', v)} ctx={ctx} />
          <OutcomeEditor title="When disqualified" value={value.onDisqualified} onChange={(v) => set('onDisqualified', v)} ctx={ctx} />
        </Grid>
        <Grid>
          <Setting id="qualification.qualifiedNextStep">
            <Field label="Next step for qualified leads">
              <Select value={value.qualifiedNextStep} onChange={(e) => set('qualifiedNextStep', e.target.value as Qualification['qualifiedNextStep'])}>
                <option value="offer_booking">Offer to book an appointment</option>
                <option value="collect_contact">Make sure contact details are collected</option>
                <option value="handoff">Hand over to the team</option>
                <option value="none">Nothing special</option>
              </Select>
            </Field>
          </Setting>
          <Setting id="qualification.disqualifiedMessage">
            <Field label="Message for disqualified leads" hint="Optional. A polite closing line, e.g. pointing to other resources.">
              <Textarea rows={2} maxLength={500} value={value.disqualifiedMessage} onChange={(e) => set('disqualifiedMessage', e.target.value)} />
            </Field>
          </Setting>
        </Grid>
      </SettingsCard>
    </>
  );
}

// ---------- Booking ----------

const BOOKING_FIELDS: BookingRequiredField[] = ['name', 'email', 'phone'];

export function BookingSection({ value, onChange, ctx }: SectionProps<Booking>) {
  const set = <K extends keyof Booking>(key: K, v: Booking[K]) => onChange({ ...value, [key]: v });
  const calendar = ctx.calendars.find((c) => c.id === value.calendarId);
  return (
    <>
      <FeatureCard
        title="Book appointments"
        setting="booking.enabled"
        checked={value.enabled}
        onChange={(v) => set('enabled', v)}
        summary={
          !value.enabled
            ? `${capitalize(ctx.assistantName)} can check availability and book, move or cancel visits once this is on.`
            : calendar
              ? `Books visits on ${calendar.name}.`
              : 'Choose a calendar below to start booking.'
        }
      >
        <Grid>
          <Setting id="booking.calendarId">
            <Field
              label="Calendar"
              error={value.enabled && !value.calendarId ? 'Choose a calendar to enable booking.' : null}
              hint={
                <>
                  Opening hours and slot length come from the calendar.{' '}
                  <Link to="/appointments/calendars" className="text-accent-text hover:underline">
                    Manage calendars
                  </Link>
                </>
              }
            >
              <Select value={value.calendarId ?? ''} onChange={(e) => set('calendarId', e.target.value || null)}>
                <option value="">No calendar</option>
                {ctx.calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.timezone}){c.isActive ? '' : ' — inactive'}
                  </option>
                ))}
              </Select>
            </Field>
          </Setting>
          <Setting id="booking.appointmentTitle">
            <Field label="Appointment title">
              <Input value={value.appointmentTitle} maxLength={120} onChange={(e) => set('appointmentTitle', e.target.value)} />
            </Field>
          </Setting>
        </Grid>
      </FeatureCard>

      <SettingsCard title="Before booking" description="What the assistant makes sure of first.">
        <Setting id="booking.requiredFields">
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-body-sm font-medium text-fg-2">Details required before booking</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {BOOKING_FIELDS.map((f) => (
                <Checkbox
                  key={f}
                  label={f.charAt(0).toUpperCase() + f.slice(1)}
                  checked={value.requiredFields.includes(f)}
                  onChange={(e) => set('requiredFields', e.target.checked ? [...value.requiredFields, f] : value.requiredFields.filter((x) => x !== f))}
                />
              ))}
            </div>
          </fieldset>
        </Setting>
        <Setting id="booking.requireQualification">
          <Toggle label="Only book qualified leads" description="Requires qualification to be enabled." checked={value.requireQualification} onChange={(v) => set('requireQualification', v)} />
        </Setting>
      </SettingsCard>

      <SettingsCard title="After booking" description="What visitors can change by asking in the chat.">
        <Setting id="booking.allowReschedule">
          <Toggle label="Allow rescheduling" checked={value.allowReschedule} onChange={(v) => set('allowReschedule', v)} />
        </Setting>
        <Setting id="booking.allowCancel">
          <Toggle label="Allow cancelling" checked={value.allowCancel} onChange={(v) => set('allowCancel', v)} />
        </Setting>
      </SettingsCard>
    </>
  );
}

// ---------- Handoff ----------

export function HandoffSection({ value, onChange, ctx }: SectionProps<Handoff>) {
  const set = <K extends keyof Handoff>(key: K, v: Handoff[K]) => onChange({ ...value, [key]: v });
  return (
    <FeatureCard
      title="Allow handoff"
      setting="handoff.enabled"
      checked={value.enabled}
      onChange={(v) => set('enabled', v)}
      summary={
        value.enabled
          ? `Hands the chat to your team when asked${value.notifyTeam ? ', and tells them' : ''}. ${capitalize(ctx.assistantName)} can also decide to hand over.`
          : "Visitors can't reach a person through the chat."
      }
    >
      <Setting id="handoff.keywords">
        <Field label="Trigger phrases" hint="If a visitor's message contains one of these, the chat goes straight to a human.">
          <ChipsInput value={value.keywords} onChange={(keywords) => set('keywords', keywords.filter((k) => k.length >= 2))} placeholder="talk to a human" />
        </Field>
      </Setting>
      <Setting id="handoff.message">
        <Field label="Handoff message" hint="Sent to the visitor when the conversation is handed over.">
          <Textarea rows={3} maxLength={500} value={value.message} onChange={(e) => set('message', e.target.value)} />
        </Field>
      </Setting>
      <Setting id="handoff.notifyTeam">
        <Toggle label="Notify the team" description="In-app notification plus email to your notification addresses." checked={value.notifyTeam} onChange={(v) => set('notifyTeam', v)} />
      </Setting>
      <Setting id="handoff.waitMinutes">
        <Field label="If nobody replies" hint="Minutes to wait after a handoff before alerting the team again and doing what's chosen below. 0 means never.">
          <NumberInput min={0} max={1440} step={1} value={value.waitMinutes} onChange={(v) => set('waitMinutes', v ?? 0)} />
        </Field>
        <Field label="Then" hint={`Both "take back" options hand the chat back to ${capitalize(ctx.assistantName)}; your team can still take it over again.`}>
          <Select value={value.fallback} disabled={value.waitMinutes === 0} onChange={(e) => set('fallback', e.target.value as Handoff['fallback'])}>
            <option value="keep_waiting">Keep waiting (just alert the team)</option>
            <option value="resume_ai">Tell the visitor and let the assistant keep helping</option>
            <option value="ask_contact_details">Ask for email or phone and let the assistant keep helping</option>
          </Select>
        </Field>
      </Setting>
      <Setting id="handoff.respectTeamHours">
        <Toggle
          label="Use the away message outside team hours"
          description="Team hours are set in Settings → Organization."
          checked={value.respectTeamHours}
          onChange={(v) => set('respectTeamHours', v)}
        />
        {value.respectTeamHours && (
          <Field label="Away message" hint="Sent instead of the handoff message when your team is away.">
            <Textarea rows={3} maxLength={500} value={value.awayMessage} onChange={(e) => set('awayMessage', e.target.value)} />
          </Field>
        )}
      </Setting>
    </FeatureCard>
  );
}

// ---------- Conversation starters ----------

const MAX_STARTERS = 10;

const STARTER_ACTIONS: Array<{ value: StarterAction; label: string }> = [
  { value: 'message', label: 'Send the message' },
  { value: 'handoff', label: 'Send it and hand off to the team' },
];

/** Examples to start from: editable, and not shown to visitors until saved. */
const SUGGESTED_STARTERS: Array<Pick<ConversationStarter, 'label' | 'message' | 'action'>> = [
  { label: 'Book an appointment', message: "I'd like to book an appointment.", action: 'message' },
  { label: 'Reschedule my appointment', message: 'I need to reschedule my appointment.', action: 'message' },
  { label: 'Cancel my appointment', message: 'I need to cancel my appointment.', action: 'message' },
  { label: 'Talk to the team', message: "I'd like to talk to someone on your team.", action: 'handoff' },
];

export function StartersSection({
  value,
  onChange,
  handoffEnabled,
}: {
  value: ConversationStarter[];
  onChange: (value: ConversationStarter[]) => void;
  handoffEnabled: boolean;
}) {
  // The list order is the display order.
  const commit = (starters: ConversationStarter[]) => onChange(starters.map((s, order) => ({ ...s, order })));
  const set = (i: number, patch: Partial<ConversationStarter>) => commit(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const starters = [...value];
    [starters[i], starters[j]] = [starters[j]!, starters[i]!];
    commit(starters);
  };
  const add = (starters: Array<Pick<ConversationStarter, 'label' | 'message' | 'action'>>) =>
    commit(
      [...value, ...starters.map((s) => ({ id: crypto.randomUUID(), label: s.label, message: s.message, action: s.action, enabled: true, order: 0 }))].slice(0, MAX_STARTERS),
    );
  const labelError = (s: ConversationStarter) => {
    const label = s.label.trim().toLowerCase();
    if (!label) return 'Add the text for the button.';
    return value.filter((o) => o.label.trim().toLowerCase() === label).length > 1 ? 'Another starter has the same text.' : null;
  };
  const shown = value.filter((s) => s.enabled && (s.action !== 'handoff' || handoffEnabled)).length;

  return (
    <SettingsCard
      title="Starters"
      description="Shown in this order. A click sends the message as the visitor's own, and the assistant answers it as usual."
      aside={
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={value.length >= MAX_STARTERS} onClick={() => add([{ label: '', message: '', action: 'message' }])}>
          Add starter
        </Button>
      }
    >
      {value.length === 0 ? (
        <EmptyBox>
          <EmptyState
            title="No conversation starters"
            description="Visitors see just the greeting. Offer a few one-click options, such as booking an appointment or talking to your team."
            action={
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => add(SUGGESTED_STARTERS)}>
                Add suggested starters
              </Button>
            }
          />
        </EmptyBox>
      ) : (
        <div className="space-y-3">
          {value.map((s, i) => (
            <Card key={s.id} role="group" aria-label={`Starter ${i + 1}`} className="space-y-3 p-4">
              <div className="flex items-start gap-3">
                <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-caption font-medium text-muted">{i + 1}</span>
                <div className="grid min-w-0 flex-1 gap-3 @lg:grid-cols-[1fr_230px]">
                  <Field label="Button text" error={labelError(s)}>
                    <Input value={s.label} maxLength={60} placeholder="Book an appointment" onChange={(e) => set(i, { label: e.target.value })} />
                  </Field>
                  <Field label="When clicked">
                    <Select value={s.action} onChange={(e) => set(i, { action: e.target.value as StarterAction })}>
                      {STARTER_ACTIONS.map((a) => (
                        <option key={a.value} value={a.value}>
                          {a.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Message" hint="Sent as the visitor's message. Leave empty to send the button text." className="@lg:col-span-2">
                    <Input
                      value={s.message}
                      maxLength={500}
                      placeholder={s.label.trim() || "I'd like to book an appointment."}
                      onChange={(e) => set(i, { message: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="flex shrink-0 flex-col gap-1 pt-6">
                  <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-4" />
                  </IconButton>
                  <IconButton label="Move down" size="sm" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-4" />
                  </IconButton>
                  <IconButton label="Remove starter" size="sm" onClick={() => commit(value.filter((_, j) => j !== i))}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              </div>
              <div className="pl-9">
                <Toggle size="sm" label={<span className="text-body-sm font-normal">Show in the chat</span>} checked={s.enabled} onChange={(enabled) => set(i, { enabled })} />
              </div>
              {s.enabled && s.action === 'handoff' && !handoffEnabled && (
                <p className="pl-9 text-caption text-warning-text">
                  Human handoff is off (Handoff tab), so this starter can't be saved as shown. Turn handoff on, choose “Send the message”, or hide it.
                </p>
              )}
            </Card>
          ))}
          <p className="text-caption text-muted">
            {shown} of {value.length} shown in the chat (up to {MAX_STARTERS}). Three to five short options work best.
          </p>
        </div>
      )}
    </SettingsCard>
  );
}

// ---------- Guardrails ----------

export function GuardrailsSection({ value, onChange }: SectionProps<Guardrails>) {
  const set = <K extends keyof Guardrails>(key: K, v: Guardrails[K]) => onChange({ ...value, [key]: v });
  return (
    <>
      <SettingsCard title="Topics" description="What the assistant talks about, and what it stays away from.">
        <Setting id="guardrails.stayOnTopic">
          <Toggle label="Stay on topic" description="Politely decline questions unrelated to your business." checked={value.stayOnTopic} onChange={(v) => set('stayOnTopic', v)} />
        </Setting>
        <Setting id="guardrails.forbiddenTopics">
          <Field label="Forbidden topics" hint="The assistant won't discuss these, e.g. competitors, medical diagnoses, legal advice.">
            <ChipsInput value={value.forbiddenTopics} onChange={(v) => set('forbiddenTopics', v)} placeholder="Type a topic and press Enter" />
          </Field>
        </Setting>
      </SettingsCard>
      <SettingsCard title="When it can't help" description="What it does without an answer, and when it leaves the chat to your team.">
        <Grid>
          <Setting id="guardrails.unknownAnswer">
            <Field label="When it doesn't know the answer">
              <Select value={value.unknownAnswer} onChange={(e) => set('unknownAnswer', e.target.value as Guardrails['unknownAnswer'])}>
                <option value="collect_contact">Take their details so the team can follow up</option>
                <option value="offer_handoff">Offer to connect them with the team</option>
                <option value="say_dont_know">Say it doesn't know</option>
              </Select>
            </Field>
          </Setting>
          <Setting id="guardrails.maxAiReplies">
            <Field label="Max AI replies per conversation" hint="After this, the conversation waits for a human.">
              <NumberInput min={1} max={500} value={value.maxAiRepliesPerConversation} onChange={(v) => set('maxAiRepliesPerConversation', Math.round(v ?? 1))} />
            </Field>
          </Setting>
        </Grid>
      </SettingsCard>
    </>
  );
}

// ---------- Actions ----------

export function ActionsSection({ value, onChange, ctx }: SectionProps<Actions>) {
  const set = <K extends keyof Actions>(key: K, v: Actions[K]) => onChange({ ...value, [key]: v });
  const disabled = new Set(value.disabledTools);
  return (
    <>
      <SettingsCard setting="actions.tools" title="Tools" description="What the assistant is allowed to do. Tools for disabled features (e.g. booking) are hidden automatically.">
        <Card className="divide-y divide-border">
          {TOOL_KEYS.filter((key) => !CRM_TOOL_KEYS.includes(key)).map((key) => (
            <div key={key} className="px-4 py-3">
              <Toggle
                label={
                  <span className="flex items-center gap-2">
                    {TOOL_LABELS[key]?.label ?? key}
                    <code className="font-mono text-label font-normal text-muted">{key}</code>
                  </span>
                }
                description={TOOL_LABELS[key]?.description}
                checked={!disabled.has(key)}
                onChange={(on) => set('disabledTools', on ? value.disabledTools.filter((t) => t !== key) : [...value.disabledTools, key])}
              />
            </div>
          ))}
        </Card>
      </SettingsCard>
      <SettingsCard
        setting="actions.crm"
        title="CRM actions"
        description="Let the assistant keep the CRM up to date as it chats. Each action is off until you choose what it may do, and every change shows on the conversation's timeline."
      >
        <Card className="divide-y divide-border">
          <div className="space-y-2 px-4 py-3">
            <p className="text-body-sm font-medium text-fg">Lifecycle stages it may set</p>
            <p className="text-caption text-muted">None ticked = the assistant never changes the stage.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {[...ctx.lifecycleStages, ...value.lifecycleStages.filter((s) => !ctx.lifecycleStages.includes(s))].map((stage) => (
                <Checkbox
                  key={stage}
                  label={ctx.lifecycleStages.includes(stage) ? stage : `${stage} (no longer a stage)`}
                  checked={value.lifecycleStages.includes(stage)}
                  onChange={(e) => set('lifecycleStages', e.target.checked ? [...value.lifecycleStages, stage] : value.lifecycleStages.filter((s) => s !== stage))}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2 px-4 py-3">
            <p className="text-body-sm font-medium text-fg">Team members it may make a contact's owner</p>
            <p className="text-caption text-muted">None ticked = the assistant never assigns owners. It sees their names, never their emails; say in the instructions who looks after whom.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {ctx.members.map((m) => (
                <Checkbox
                  key={m.userId}
                  label={m.name || m.email}
                  checked={value.owners.includes(m.userId)}
                  onChange={(e) => set('owners', e.target.checked ? [...value.owners, m.userId] : value.owners.filter((id) => id !== m.userId))}
                />
              ))}
              {value.owners
                .filter((id) => !ctx.members.some((m) => m.userId === id))
                .map((id) => (
                  <Checkbox key={id} label="A former team member" checked onChange={() => set('owners', value.owners.filter((x) => x !== id))} />
                ))}
            </div>
          </div>
          <div className="px-4 py-3">
            <Toggle
              label="Remove tags"
              description="Tags from the allowed list below; with no list, only tags the assistant added itself (never the team's)."
              checked={value.removeTags}
              onChange={(v) => set('removeTags', v)}
            />
          </div>
          <div className="space-y-3 px-4 py-3">
            <Toggle
              label="Create and update deals"
              description="One open deal per contact: the assistant opens it when they show real intent to buy, and keeps its stage and value current."
              checked={value.deals.enabled}
              onChange={(v) => set('deals', { ...value.deals, enabled: v })}
            />
            {value.deals.enabled && (
              <div className="grid gap-4 pl-12 @md:grid-cols-2">
                <Field label="Pipeline">
                  <Select value={value.deals.pipelineId ?? ''} onChange={(e) => set('deals', { ...value.deals, pipelineId: e.target.value || null })}>
                    <option value="">{ctx.pipelines[0] ? `The first pipeline (${ctx.pipelines[0].name})` : 'The first pipeline'}</option>
                    {value.deals.pipelineId && !ctx.pipelines.some((p) => p.id === value.deals.pipelineId) && (
                      <option value={value.deals.pipelineId}>A deleted pipeline: choose another</option>
                    )}
                    {ctx.pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Toggle
                  className="self-end pb-2"
                  label="May mark deals won or lost"
                  description="Otherwise closing a deal is left to your team."
                  checked={value.deals.canClose}
                  onChange={(v) => set('deals', { ...value.deals, canClose: v })}
                />
              </div>
            )}
          </div>
        </Card>
      </SettingsCard>
      <SettingsCard
        setting="actions.askFirst"
        title="Ask the team first"
        description="The assistant asks your team before doing these, and tells the customer a team member will confirm. Requests wait under Approvals and on the conversation, and expire after 7 days."
      >
        <Card className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {ASK_FIRST_TOOLS.map((key) => (
              <Checkbox
                key={key}
                label={TOOL_LABELS[key]?.label ?? key}
                checked={value.askFirst.includes(key)}
                onChange={(e) => set('askFirst', e.target.checked ? [...value.askFirst, key] : value.askFirst.filter((k) => k !== key))}
              />
            ))}
          </div>
          <p className="text-caption text-muted">Only matters for actions that are on. Workflows ask first per workflow, in Automations → Workflows.</p>
        </Card>
      </SettingsCard>
      <SettingsCard setting="actions.tags" title="Tags" description="Which tags the assistant may apply to contacts.">
        <Field label="Allowed tags" hint="Leave empty to allow any existing tag.">
          <ChipsInput value={value.allowedTags} onChange={(v) => set('allowedTags', v)} suggestions={ctx.tags.map((t) => t.name)} placeholder="Tag names" />
        </Field>
        <Toggle label="Allow creating new tags" description="Otherwise the assistant can only use tags that already exist." checked={value.allowCreateTags} onChange={(v) => set('allowCreateTags', v)} />
      </SettingsCard>
      <SettingsCard setting="actions.workflows" title="Workflows" description="n8n workflows the assistant may trigger (needs the “Trigger workflow” tool).">
        {ctx.workflows === null ? (
          <p className="text-body-sm text-muted">Only admins can manage workflows.</p>
        ) : ctx.workflows.length === 0 ? (
          <EmptyBox>
            <EmptyState
              title="No workflows yet"
              description="Connect an n8n workflow to let the assistant update your CRM, send quotes and more."
              action={
                <Link to="/automations?tab=workflows" className="text-body-sm font-medium text-accent-text hover:underline">
                  Add a workflow →
                </Link>
              }
            />
          </EmptyBox>
        ) : (
          <Card className="divide-y divide-border">
            {ctx.workflows.map((w) => (
              <div key={w.id} className="px-4 py-3">
                <Checkbox
                  label={
                    <span className="flex items-center gap-2">
                      {w.name} <code className="font-mono text-label text-muted">{w.key}</code>
                      {!w.isActive && <Badge tone="slate">inactive</Badge>}
                    </span>
                  }
                  description={w.description}
                  checked={value.workflowKeys.includes(w.key)}
                  onChange={(e) => set('workflowKeys', e.target.checked ? [...value.workflowKeys, w.key] : value.workflowKeys.filter((k) => k !== w.key))}
                />
              </div>
            ))}
            {value.workflowKeys
              .filter((k) => !ctx.workflows!.some((w) => w.key === k))
              .map((k) => (
                <div key={k} className="flex items-center justify-between px-4 py-3 text-body-sm text-danger-text">
                  Unknown workflow “{k}”
                  <Button size="xs" variant="ghost" onClick={() => set('workflowKeys', value.workflowKeys.filter((x) => x !== k))}>
                    Remove
                  </Button>
                </div>
              ))}
          </Card>
        )}
      </SettingsCard>
    </>
  );
}

// ---------- Model ----------

/** Empty strings mean "follow the server configuration" (sent to the API as null). */
export interface ModelSettings {
  model: string;
  effort: Effort | '';
  maxOutputTokens: number;
}

const EFFORT_HELP: Record<Effort, string> = {
  low: 'Fastest and cheapest reasoning. Good for most website chats.',
  medium: 'A little more thinking for multi-step requests.',
  high: 'More careful reasoning; slower replies.',
};

export function ModelSection({ value, onChange }: { value: ModelSettings; onChange: (v: ModelSettings) => void }) {
  const ai = useAiConfig();
  const server = ai.data;
  const modelValid = /^[A-Za-z0-9._:/@-]*$/.test(value.model.trim());
  const serverEffort = server?.reasoningEffort ? `${server.reasoningEffort} effort` : 'no effort setting';
  return (
    <SettingsCard
      title="AI model"
      description="The server configuration chooses the AI provider and model for every bot. Override them here only when this bot needs something different."
    >
      <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-body-sm text-muted">
        Server default:{' '}
        <span className="font-mono text-caption text-fg">
          {server ? `${server.provider} · ${server.model} · ${serverEffort}` : ai.isLoading ? 'loading…' : 'unavailable'}
        </span>
        {server && !server.pricing.model && <span className="block text-caption">No price is configured for this model, so its cost shows as $0.</span>}
      </p>
      <Grid>
        <Setting id="model.model">
          <Field
            label="Model override"
            hint="Leave empty to follow the server's model. Must be a model your configured provider offers."
            error={modelValid ? null : 'Letters, digits and . _ : / @ - only.'}
          >
            <Input
              className="font-mono text-body-sm"
              placeholder={server ? `Server default (${server.model})` : 'Server default'}
              value={value.model}
              onChange={(e) => onChange({ ...value, model: e.target.value })}
            />
          </Field>
        </Setting>
        <Setting id="model.effort">
          <Field label="Reasoning effort" hint={value.effort ? EFFORT_HELP[value.effort] : 'Only reasoning models use this. Leave on the server default otherwise.'}>
            <Select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as Effort | '' })}>
              <option value="">Server default ({server?.reasoningEffort ?? 'not set'})</option>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Field>
        </Setting>
        <Setting id="model.maxOutputTokens">
          <Field label="Max output tokens" hint="Upper bound per reply, 1,024–64,000." error={value.maxOutputTokens < 1024 || value.maxOutputTokens > 64000 ? 'Between 1,024 and 64,000.' : null}>
            <NumberInput min={1024} max={64000} step={256} value={value.maxOutputTokens} onChange={(v) => onChange({ ...value, maxOutputTokens: Math.round(v ?? 0) })} />
          </Field>
        </Setting>
      </Grid>
    </SettingsCard>
  );
}

// ---------- Knowledge ----------

export function KnowledgeSection({ value, onChange, ctx }: { value: string[]; onChange: (v: string[]) => void; ctx: EditorContext }) {
  return (
    <SettingsCard title="Knowledge bases to search" description={`Tick the ones ${ctx.assistantName} should use. Their documents and pages are managed in Knowledge.`}>
      {ctx.knowledgeBases.length === 0 ? (
        <EmptyBox>
          <EmptyState
            title="No knowledge bases"
            description="Create one and add FAQs, web pages or documents."
            action={
              <Link to="/knowledge" className="text-body-sm font-medium text-accent-text hover:underline">
                Go to Knowledge →
              </Link>
            }
          />
        </EmptyBox>
      ) : (
        <Card className="divide-y divide-border">
          {ctx.knowledgeBases.map((kb) => (
            <div key={kb.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <Checkbox
                label={kb.name}
                description={kb.description || undefined}
                checked={value.includes(kb.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, kb.id] : value.filter((id) => id !== kb.id))}
              />
              <Link to={`/knowledge/${kb.id}`} className="shrink-0 text-caption text-accent-text hover:underline">
                {kb.documentCount} document{kb.documentCount === 1 ? '' : 's'}
              </Link>
            </div>
          ))}
        </Card>
      )}
      {value.length === 0 && ctx.knowledgeBases.length > 0 && (
        <p className="text-body-sm text-warning-text">No knowledge base selected — the assistant will only use the business info and instructions.</p>
      )}
    </SettingsCard>
  );
}
