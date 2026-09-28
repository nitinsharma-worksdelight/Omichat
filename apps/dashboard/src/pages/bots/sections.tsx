import { useAiConfig } from '../../lib/queries';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ChipsInput,
  cx,
  EmptyState,
  Field,
  IconButton,
  Input,
  NumberInput,
  Section,
  Select,
  Textarea,
  Toggle,
} from '../../components/ui';
import { slugify, TOOL_LABELS } from '../../lib/format';
import { Link } from '../../lib/router';
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

function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 }) {
  return <div className={cx('grid gap-4', cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-1')}>{children}</div>;
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={cx('text-xs tabular-nums', value.length > max ? 'text-danger-text' : 'text-muted')}>
      {value.length.toLocaleString()} / {max.toLocaleString()}
    </span>
  );
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

export function PersonaSection({ value, onChange, ctx, onApplyTemplate }: SectionProps<Persona> & { onApplyTemplate: (template: PersonalityTemplate) => void }) {
  const set = <K extends keyof Persona>(key: K, v: Persona[K]) => onChange({ ...value, [key]: v });
  return (
    <Section title="Persona" description="Who the assistant is and how it sounds.">
      <div>
        <p className="mb-2 text-[13px] font-medium text-fg-2">Start from a template</p>
        <div className="flex flex-wrap gap-2">
          {PERSONALITY_TEMPLATES.map((t) => (
            <Button key={t.id} size="sm" title={t.description} onClick={() => onApplyTemplate(t)}>
              {t.label}
            </Button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted">Fills the role, tone, reply length, personality and main goal. Review them, then save.</p>
      </div>
      <Grid>
        <Field label="Assistant name" hint="Shown in the chat header and used when it introduces itself.">
          <Input value={value.assistantName} maxLength={60} onChange={(e) => set('assistantName', e.target.value)} />
        </Field>
        <Field label="Company name" hint={ctx.organizationName ? `Leave empty to use “${ctx.organizationName}”.` : undefined}>
          <Input value={value.companyName} maxLength={120} placeholder={ctx.organizationName} onChange={(e) => set('companyName', e.target.value)} />
        </Field>
        <Field label="Role" hint="e.g. patient coordinator, sales assistant.">
          <Input value={value.role} maxLength={120} onChange={(e) => set('role', e.target.value)} />
        </Field>
        <Field label="Tone">
          <Select value={value.tone} onChange={(e) => set('tone', e.target.value as Persona['tone'])}>
            {TONES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reply length">
          <Select value={value.responseLength} onChange={(e) => set('responseLength', e.target.value as Persona['responseLength'])}>
            <option value="short">Short — one or two sentences</option>
            <option value="medium">Medium</option>
            <option value="detailed">Detailed</option>
          </Select>
        </Field>
        <Field label="Language" hint="“auto” replies in the visitor's language. Or type a language name or code.">
          <Input list="bot-languages" value={value.language} maxLength={40} onChange={(e) => set('language', e.target.value)} />
        </Field>
      </Grid>
      <datalist id="bot-languages">
        {LANGUAGES.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <Field label="Personality" hint="How it should come across, in your own words. Adds to the tone above (up to 600 characters).">
        <Textarea
          rows={3}
          maxLength={600}
          value={value.personality}
          placeholder="e.g. Warm and reassuring, a little playful, like our front desk."
          onChange={(e) => set('personality', e.target.value)}
        />
      </Field>
      <Toggle label="Use emojis" description="Allow the occasional emoji in replies." checked={value.useEmojis} onChange={(v) => set('useEmojis', v)} />
      <Field label="Greeting" hint="The first message visitors see when they open the chat.">
        <Textarea rows={3} value={value.greeting} maxLength={500} onChange={(e) => set('greeting', e.target.value)} />
      </Field>
    </Section>
  );
}

// ---------- Goals ----------

export function GoalsSection({ value, onChange }: SectionProps<Goals>) {
  const setOther = (i: number, text: string) => onChange({ ...value, secondary: value.secondary.map((g, j) => (j === i ? text : g)) });
  return (
    <Section title="Goals" description="What the assistant works towards. It still answers the customer's question first and never pushes.">
      <Field label="Main goal" hint="One sentence, e.g. “Get visitors to book a free consultation.”">
        <Input value={value.primary} maxLength={300} placeholder="e.g. Get visitors to book a free consultation." onChange={(e) => onChange({ ...value, primary: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-fg-2">More goals</p>
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
        <p className="text-xs text-muted">Up to 5, e.g. “Mention the new-patient offer when it fits.”</p>
      </div>
      <p className="text-[13px] text-muted">
        Built-in goals are added for what you switch on: answering from your information, capturing details, qualifying, booking and handing off.
      </p>
    </Section>
  );
}

// ---------- Instructions ----------

export function InstructionsSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Section
      title="Custom instructions"
      description="Anything specific to your business: what to emphasise, what to avoid, how to handle special cases."
      actions={<Counter value={value} max={12000} />}
    >
      <Field label="Instructions" hint="Write it as you would brief a new team member. The assistant already knows how to capture leads, qualify and book — no need to explain that.">
        <Textarea
          rows={18}
          className="font-mono text-[13px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'e.g. When someone asks about pricing, give the range and offer a free consultation.\nNever quote prices for custom work.'}
        />
      </Field>
    </Section>
  );
}

// ---------- Business ----------

export function BusinessSection({ value, onChange }: SectionProps<BusinessProfile>) {
  const set = <K extends keyof BusinessProfile>(key: K, v: string) => onChange({ ...value, [key]: v });
  return (
    <Section title="Business info" description="Facts the assistant can always rely on, even without a knowledge base.">
      <Field label="What you do">
        <Textarea rows={3} maxLength={4000} value={value.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Services / products">
        <Textarea rows={3} maxLength={4000} value={value.services} onChange={(e) => set('services', e.target.value)} />
      </Field>
      <Grid>
        <Field label="Opening hours">
          <Input maxLength={1000} value={value.hours} onChange={(e) => set('hours', e.target.value)} />
        </Field>
        <Field label="Location">
          <Input maxLength={500} value={value.location} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label="Website">
          <Input type="url" maxLength={300} value={value.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Phone">
          <Input maxLength={60} value={value.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" maxLength={200} value={value.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </Grid>
      <Field label="Other facts" hint="Parking, payment options, policies — short facts the assistant should know.">
        <Textarea rows={4} maxLength={8000} value={value.extraFacts} onChange={(e) => set('extraFacts', e.target.value)} />
      </Field>
    </Section>
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
    <Section title="Lead capture" description="Which contact details the assistant collects, and when it asks.">
      <Toggle label="Capture leads" description="Ask visitors for their details during the conversation." checked={value.enabled} onChange={(v) => onChange({ ...value, enabled: v })} />
      <Card className={cx(!value.enabled && 'opacity-60')}>
        <div className="grid grid-cols-[1fr_110px_190px_36px] items-center gap-3 border-b border-border px-4 py-2 text-xs font-medium text-muted">
          <span>Field</span>
          <span>Required</span>
          <span>When to ask</span>
          <span className="sr-only">Remove</span>
        </div>
        {value.fields.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">No fields — add at least a name or email so leads can be followed up.</p>}
        {value.fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[1fr_110px_190px_36px] items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
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
        <div className="flex items-center justify-between px-4 py-2.5">
          <Button
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={!nextFree || value.fields.length >= 20}
            onClick={() => nextFree && onChange({ ...value, fields: [...value.fields, { field: nextFree.key, required: false, timing: 'natural' }] })}
          >
            Add field
          </Button>
          <Link to="/automations?tab=fields" className="text-xs text-accent-text hover:underline">
            Manage custom fields
          </Link>
        </div>
      </Card>
      <Field label="Privacy notice" hint="Mentioned when collecting details, e.g. how you use them. Informational only; leave empty to skip.">
        <Textarea rows={2} maxLength={500} value={value.consentNotice} onChange={(e) => onChange({ ...value, consentNotice: e.target.value })} />
      </Field>
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
    </Section>
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
  if (op === 'answered') return <span className="text-xs text-muted">—</span>;
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
      <p className="text-[13px] font-semibold text-fg">{title}</p>
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

  return (
    <div className="space-y-8">
      <Section title="Lead qualification" description="Questions the assistant weaves into the conversation, scored to rank leads as hot, warm or cold.">
        <Toggle label="Qualify leads" description="Ask the questions below and score the answers." checked={value.enabled} onChange={(v) => set('enabled', v)} />
      </Section>

      <Section
        title="Questions"
        description="Asked one at a time, in this order, when it fits the conversation."
        actions={
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
          <Card>
            <EmptyState title="No questions yet" description="Add questions like budget, timeline or the service they need. Each answer can add points to the lead score." />
          </Card>
        ) : (
          <div className="space-y-3">
            {value.questions.map((q, i) => (
              <Card key={i} className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-muted">{i + 1}</span>
                  <div className="grid flex-1 grid-cols-[1fr_180px] gap-3">
                    <Field label="Question">
                      <Input value={q.question} maxLength={300} placeholder="What's your budget?" onChange={(e) => setQuestion(i, { question: e.target.value })} />
                    </Field>
                    <Field label="Key" hint="Used in rules and exports.">
                      <Input className="font-mono text-[13px]" value={q.key} maxLength={64} onChange={(e) => setQuestion(i, { key: slugify(e.target.value) })} />
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
                      <Field label="Options" className="col-span-2" error={q.options.length === 0 ? 'Add at least one option.' : null}>
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
                  <Toggle size="sm" label={<span className="text-[13px] font-normal">Required to qualify</span>} checked={q.required} onChange={(required) => setQuestion(i, { required })} />
                </div>
                {clashes(q).length > 0 && (
                  <p className="pl-9 text-xs text-warning-text">
                    {clashes(q).join(', ')} also {clashes(q).length === 1 ? 'uses' : 'use'} the key “{q.key}” with a different answer type or options. A contact's answer
                    under this key is shared between them, and one that doesn't fit this question is asked again. Use a different key to keep them apart.
                  </p>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Scoring rules"
        description="Each matching rule adds (or subtracts) points. A matching disqualifier ends qualification regardless of score."
        actions={
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
          <Card>
            <EmptyState title="No scoring rules" description={value.questions.length ? 'Add a rule, e.g. “budget ≥ 10000 → +40 points”.' : 'Add a question first, then score its answers here.'} />
          </Card>
        ) : (
          <Card className="divide-y divide-border">
            {value.rules.map((r, i) => {
              const question = questionByKey(r.questionKey);
              return (
                <div key={i} className="space-y-2 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="w-8 shrink-0 text-xs font-medium text-muted">If</span>
                    <Select
                      aria-label={`Rule ${i + 1} question`}
                      className="min-w-0 flex-1"
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
                    <span className="text-xs text-muted">then</span>
                    <NumberInput aria-label={`Rule ${i + 1} points`} className="w-20" value={r.points} step={1} onChange={(v) => setRule(i, { points: Math.round(v ?? 0) })} />
                    <span className="text-xs text-muted">points</span>
                    <Toggle size="sm" className="ml-2" label={<span className="text-xs font-normal text-fg-2">Disqualify</span>} checked={r.disqualify} onChange={(disqualify) => setRule(i, { disqualify })} />
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </Section>

      <Section title="Score thresholds" description="Hot when the score reaches the hot threshold, warm from the warm threshold, otherwise cold.">
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
      </Section>

      <Section title="Outcomes" description="What happens automatically when a lead is qualified or disqualified.">
        <Grid>
          <OutcomeEditor title="When qualified" value={value.onQualified} onChange={(v) => set('onQualified', v)} ctx={ctx} />
          <OutcomeEditor title="When disqualified" value={value.onDisqualified} onChange={(v) => set('onDisqualified', v)} ctx={ctx} />
        </Grid>
        <Grid>
          <Field label="Next step for qualified leads">
            <Select value={value.qualifiedNextStep} onChange={(e) => set('qualifiedNextStep', e.target.value as Qualification['qualifiedNextStep'])}>
              <option value="offer_booking">Offer to book an appointment</option>
              <option value="collect_contact">Make sure contact details are collected</option>
              <option value="handoff">Hand over to the team</option>
              <option value="none">Nothing special</option>
            </Select>
          </Field>
          <Field label="Message for disqualified leads" hint="Optional. A polite closing line, e.g. pointing to other resources.">
            <Textarea rows={2} maxLength={500} value={value.disqualifiedMessage} onChange={(e) => set('disqualifiedMessage', e.target.value)} />
          </Field>
        </Grid>
      </Section>
    </div>
  );
}

// ---------- Booking ----------

const BOOKING_FIELDS: BookingRequiredField[] = ['name', 'email', 'phone'];

export function BookingSection({ value, onChange, ctx }: SectionProps<Booking>) {
  const set = <K extends keyof Booking>(key: K, v: Booking[K]) => onChange({ ...value, [key]: v });
  return (
    <Section title="Booking" description="Let the assistant find open slots and book appointments on your calendar.">
      <Toggle label="Book appointments" description="The assistant can check availability and book, reschedule or cancel." checked={value.enabled} onChange={(v) => set('enabled', v)} />
      <Grid>
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
        <Field label="Appointment title">
          <Input value={value.appointmentTitle} maxLength={120} onChange={(e) => set('appointmentTitle', e.target.value)} />
        </Field>
      </Grid>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-[13px] font-medium text-fg-2">Details required before booking</legend>
        <div className="flex gap-6">
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
      <div className="space-y-3">
        <Toggle label="Only book qualified leads" description="Requires qualification to be enabled." checked={value.requireQualification} onChange={(v) => set('requireQualification', v)} />
        <Toggle label="Allow rescheduling" checked={value.allowReschedule} onChange={(v) => set('allowReschedule', v)} />
        <Toggle label="Allow cancelling" checked={value.allowCancel} onChange={(v) => set('allowCancel', v)} />
      </div>
    </Section>
  );
}

// ---------- Handoff ----------

export function HandoffSection({ value, onChange }: SectionProps<Handoff>) {
  const set = <K extends keyof Handoff>(key: K, v: Handoff[K]) => onChange({ ...value, [key]: v });
  return (
    <Section title="Human handoff" description="When the assistant hands the conversation to your team, the AI stops replying until someone resumes it.">
      <Toggle label="Allow handoff" description="Visitors can ask for a person; the assistant can also decide to transfer." checked={value.enabled} onChange={(v) => set('enabled', v)} />
      <Field label="Trigger phrases" hint="If a visitor's message contains one of these, the chat goes straight to a human.">
        <ChipsInput value={value.keywords} onChange={(keywords) => set('keywords', keywords.filter((k) => k.length >= 2))} placeholder="talk to a human" />
      </Field>
      <Field label="Handoff message" hint="Sent to the visitor when the conversation is handed over.">
        <Textarea rows={3} maxLength={500} value={value.message} onChange={(e) => set('message', e.target.value)} />
      </Field>
      <Toggle label="Notify the team" description="In-app notification plus email to your notification addresses." checked={value.notifyTeam} onChange={(v) => set('notifyTeam', v)} />
    </Section>
  );
}

// ---------- Guardrails ----------

export function GuardrailsSection({ value, onChange }: SectionProps<Guardrails>) {
  const set = <K extends keyof Guardrails>(key: K, v: Guardrails[K]) => onChange({ ...value, [key]: v });
  return (
    <Section title="Guardrails" description="Keep the assistant focused and safe.">
      <Toggle label="Stay on topic" description="Politely decline questions unrelated to your business." checked={value.stayOnTopic} onChange={(v) => set('stayOnTopic', v)} />
      <Field label="Forbidden topics" hint="The assistant won't discuss these, e.g. competitors, medical diagnoses, legal advice.">
        <ChipsInput value={value.forbiddenTopics} onChange={(v) => set('forbiddenTopics', v)} placeholder="Type a topic and press Enter" />
      </Field>
      <Grid>
        <Field label="When it doesn't know the answer">
          <Select value={value.unknownAnswer} onChange={(e) => set('unknownAnswer', e.target.value as Guardrails['unknownAnswer'])}>
            <option value="collect_contact">Take their details so the team can follow up</option>
            <option value="offer_handoff">Offer to connect them with the team</option>
            <option value="say_dont_know">Say it doesn't know</option>
          </Select>
        </Field>
        <Field label="Max AI replies per conversation" hint="After this, the conversation waits for a human.">
          <NumberInput min={1} max={500} value={value.maxAiRepliesPerConversation} onChange={(v) => set('maxAiRepliesPerConversation', Math.round(v ?? 1))} />
        </Field>
      </Grid>
    </Section>
  );
}

// ---------- Actions ----------

export function ActionsSection({ value, onChange, ctx }: SectionProps<Actions>) {
  const set = <K extends keyof Actions>(key: K, v: Actions[K]) => onChange({ ...value, [key]: v });
  const disabled = new Set(value.disabledTools);
  return (
    <div className="space-y-8">
      <Section title="Tools" description="What the assistant is allowed to do. Tools for disabled features (e.g. booking) are hidden automatically.">
        <Card className="divide-y divide-border">
          {TOOL_KEYS.filter((key) => !CRM_TOOL_KEYS.includes(key)).map((key) => (
            <div key={key} className="px-4 py-3">
              <Toggle
                label={
                  <span className="flex items-center gap-2">
                    {TOOL_LABELS[key]?.label ?? key}
                    <code className="font-mono text-[11px] font-normal text-faint">{key}</code>
                  </span>
                }
                description={TOOL_LABELS[key]?.description}
                checked={!disabled.has(key)}
                onChange={(on) => set('disabledTools', on ? value.disabledTools.filter((t) => t !== key) : [...value.disabledTools, key])}
              />
            </div>
          ))}
        </Card>
      </Section>
      <Section
        title="CRM actions"
        description="Let the assistant keep the CRM up to date as it chats. Each action is off until you choose what it may do, and every change shows on the conversation's timeline."
      >
        <Card className="divide-y divide-border">
          <div className="space-y-2 px-4 py-3">
            <p className="text-[13px] font-medium text-fg">Lifecycle stages it may set</p>
            <p className="text-xs text-muted">None ticked = the assistant never changes the stage.</p>
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
            <p className="text-[13px] font-medium text-fg">Team members it may make a contact's owner</p>
            <p className="text-xs text-muted">None ticked = the assistant never assigns owners. It sees their names, never their emails; say in the instructions who looks after whom.</p>
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
              <div className="grid grid-cols-2 gap-4 pl-12">
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
      </Section>
      <Section
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
          <p className="text-xs text-muted">Only matters for actions that are on. Workflows ask first per workflow, in Automations → Workflows.</p>
        </Card>
      </Section>
      <Section title="Tags" description="Which tags the assistant may apply to contacts.">
        <Field label="Allowed tags" hint="Leave empty to allow any existing tag.">
          <ChipsInput value={value.allowedTags} onChange={(v) => set('allowedTags', v)} suggestions={ctx.tags.map((t) => t.name)} placeholder="Tag names" />
        </Field>
        <Toggle label="Allow creating new tags" description="Otherwise the assistant can only use tags that already exist." checked={value.allowCreateTags} onChange={(v) => set('allowCreateTags', v)} />
      </Section>
      <Section title="Workflows" description="n8n workflows the assistant may trigger (needs the “Trigger workflow” tool).">
        {ctx.workflows === null ? (
          <p className="text-[13px] text-muted">Only admins can manage workflows.</p>
        ) : ctx.workflows.length === 0 ? (
          <Card>
            <EmptyState
              title="No workflows yet"
              description="Connect an n8n workflow to let the assistant update your CRM, send quotes and more."
              action={
                <Link to="/automations?tab=workflows" className="text-[13px] font-medium text-accent-text hover:underline">
                  Add a workflow →
                </Link>
              }
            />
          </Card>
        ) : (
          <Card className="divide-y divide-border">
            {ctx.workflows.map((w) => (
              <div key={w.id} className="px-4 py-3">
                <Checkbox
                  label={
                    <span className="flex items-center gap-2">
                      {w.name} <code className="font-mono text-[11px] text-faint">{w.key}</code>
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
                <div key={k} className="flex items-center justify-between px-4 py-3 text-[13px] text-danger-text">
                  Unknown workflow “{k}”
                  <Button size="xs" variant="ghost" onClick={() => set('workflowKeys', value.workflowKeys.filter((x) => x !== k))}>
                    Remove
                  </Button>
                </div>
              ))}
          </Card>
        )}
      </Section>
    </div>
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
    <Section
      title="Model"
      description="The server configuration chooses the AI provider and model for every bot. Override them here only when this bot needs something different."
    >
      <p className="mb-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[13px] text-muted">
        Server default:{' '}
        <span className="font-mono text-[12.5px] text-fg">
          {server ? `${server.provider} · ${server.model} · ${serverEffort}` : ai.isLoading ? 'loading…' : 'unavailable'}
        </span>
        {server && !server.pricing.model && <span className="block text-xs">No price is configured for this model, so its cost shows as $0.</span>}
      </p>
      <Grid>
        <Field
          label="Model override"
          hint="Leave empty to follow the server's model. Must be a model your configured provider offers."
          error={modelValid ? null : 'Letters, digits and . _ : / @ - only.'}
        >
          <Input
            className="font-mono text-[13px]"
            placeholder={server ? `Server default (${server.model})` : 'Server default'}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        </Field>
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
        <Field label="Max output tokens" hint="Upper bound per reply, 1,024–64,000." error={value.maxOutputTokens < 1024 || value.maxOutputTokens > 64000 ? 'Between 1,024 and 64,000.' : null}>
          <NumberInput min={1024} max={64000} step={256} value={value.maxOutputTokens} onChange={(v) => onChange({ ...value, maxOutputTokens: Math.round(v ?? 0) })} />
        </Field>
      </Grid>
    </Section>
  );
}

// ---------- Knowledge ----------

export function KnowledgeSection({ value, onChange, ctx }: { value: string[]; onChange: (v: string[]) => void; ctx: EditorContext }) {
  return (
    <Section title="Knowledge bases" description="The assistant searches these to answer questions and cites its sources.">
      {ctx.knowledgeBases.length === 0 ? (
        <Card>
          <EmptyState
            title="No knowledge bases"
            description="Create one and add FAQs, web pages or documents."
            action={
              <Link to="/knowledge" className="text-[13px] font-medium text-accent-text hover:underline">
                Go to Knowledge →
              </Link>
            }
          />
        </Card>
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
              <Link to={`/knowledge/${kb.id}`} className="shrink-0 text-xs text-accent-text hover:underline">
                {kb.documentCount} document{kb.documentCount === 1 ? '' : 's'}
              </Link>
            </div>
          ))}
        </Card>
      )}
      {value.length === 0 && ctx.knowledgeBases.length > 0 && (
        <p className="text-[13px] text-warning-text">No knowledge base selected — the assistant will only use the business info and instructions.</p>
      )}
    </Section>
  );
}
