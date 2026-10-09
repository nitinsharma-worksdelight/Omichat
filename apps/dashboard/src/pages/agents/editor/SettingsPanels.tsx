import { BookOpen, ChevronDown, ChevronRight, ClipboardList, Clock, MessageSquare, MessagesSquare, Plus, Search, Zap } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Drawer } from '../../../components/overlay';
import { Badge, Button, cx, Field, Input, NumberInput, Select, Textarea, Toggle } from '../../../components/ui';
import { Link } from '../../../lib/router';
import type { BotConfig, BotConfigSection, CustomApi } from '../../../lib/types';
import { askedFor, type BotDraft } from '../../bots/editorNav';
import { BusinessSection, GoalsSection, GuardrailsSection, PersonaSection, StartersSection, type EditorContext, type PersonalityTemplate } from '../../bots/sections';
import { bookingAbilities } from '../../bots/warnings';
import { BookingModal, ComingSoonActionModal, ContactInfoModal, HandoverModal, QualificationModal, ToolsModal, WorkflowModal } from './ActionModals';
import { CustomApiModal } from './CustomApiModal';

export type PanelId = 'actions' | 'kb' | 'mode' | 'timing' | 'behavior' | 'summary';
export type ActionId = 'api' | 'booking' | 'workflow' | 'contact' | 'stop' | 'handover' | 'transfer' | 'followup' | 'qualification' | 'tools';

/** GHL's "Setup Your Actions" menu, then the platform's other abilities under "More". */
const ACTION_MENU: Array<{ id: ActionId; label: string; more?: boolean; hidden?: boolean }> = [
  { id: 'api', label: 'API Call' },
  { id: 'booking', label: 'Appointment Booking' },
  { id: 'workflow', label: 'Trigger a Workflow' },
  { id: 'contact', label: 'Contact Info' },
  { id: 'stop', label: 'Stop Bot', hidden: true },
  { id: 'handover', label: 'Human Handover' },
  { id: 'transfer', label: 'Transfer Bot', hidden: true },
  { id: 'followup', label: 'Auto Followup', hidden: true },
  { id: 'qualification', label: 'Lead Qualification', more: true },
  { id: 'tools', label: 'Tools, CRM & approvals', more: true },
];
/** Not on the platform yet: hidden from the menu on request (2026-10-10), kept so they can be switched back on. */
const SOON = new Set<ActionId>(['stop', 'transfer', 'followup']);

type Sub = 'persona' | 'goals' | 'business' | 'guardrails' | 'starters';

interface Props {
  draft: BotDraft;
  setDraft: (d: BotDraft) => void;
  ctx: EditorContext;
  botId: string;
  readOnly: boolean;
  open: PanelId | null;
  onToggle: (id: PanelId) => void;
  /** An action to open straight away (a new Appointment booking agent opens its setup). */
  startAction: ActionId | null;
  onStartActionDone: () => void;
  /** The agent replies on a website chat or another channel. */
  live: boolean;
  onDeploy: () => void;
  onApplyTemplate: (t: PersonalityTemplate) => void;
}

export function SettingsPanels({ draft, setDraft, ctx, botId, readOnly, open, onToggle, startAction, onStartActionDone, live, onDeploy, onApplyTemplate }: Props) {
  const [action, setAction] = useState<ActionId | null>(null);
  /** The custom API being edited: its index, or 'new'. */
  const [apiAt, setApiAt] = useState<number | 'new'>('new');
  const [sub, setSub] = useState<Sub | null>(null);
  const config = draft.config;
  const setConfig = <K extends BotConfigSection>(key: K, value: BotConfig[K]) => setDraft({ ...draft, config: { ...draft.config, [key]: value } });

  useEffect(() => {
    if (!startAction) return;
    setAction(startAction);
    onStartActionDone();
  }, [startAction, onStartActionDone]);

  const openAction = (id: ActionId, at: number | 'new' = 'new') => {
    setApiAt(at);
    setAction(id);
  };
  const close = () => setAction(null);
  const apis = config.actions.customApis;

  const configured = useMemo(() => {
    const rows: Array<{ key: string; label: string; summary: string; open: () => void; off?: boolean }> = [];
    apis.forEach((a, i) => {
      let host = a.url;
      try {
        host = new URL(a.url.replace(/\{\{[^}]*\}\}/g, 'x')).host;
      } catch {
        // shown as typed
      }
      rows.push({ key: `api-${a.id ?? i}`, label: `API Call: ${a.name}`, summary: `${a.method} ${host}${a.askFirst ? ' · asks the team first' : ''}`, open: () => openAction('api', i), off: !a.enabled });
    });
    if (config.booking.enabled) {
      const cal = ctx.calendars.find((c) => c.id === config.booking.calendarId);
      rows.push({
        key: 'booking',
        label: 'Appointment Booking',
        summary: `${cal ? cal.name : 'No calendar'}${config.actions.askFirst.includes('book_appointment') ? ' · asks the team first' : ''}`,
        open: () => openAction('booking'),
      });
    }
    if (config.actions.workflowKeys.length) rows.push({ key: 'workflow', label: 'Trigger a Workflow', summary: config.actions.workflowKeys.join(', '), open: () => openAction('workflow') });
    if (config.leadCapture.enabled) rows.push({ key: 'contact', label: 'Contact Info', summary: askedFor(config.leadCapture, ctx.customFields) ?? 'Saves details when shared.', open: () => openAction('contact') });
    if (config.handoff.enabled) rows.push({ key: 'handover', label: 'Human Handover', summary: `On request${config.handoff.notifyTeam ? ' · notifies the team' : ''}`, open: () => openAction('handover') });
    if (config.qualification.enabled) rows.push({ key: 'qualification', label: 'Lead Qualification', summary: `${config.qualification.questions.length} question${config.qualification.questions.length === 1 ? '' : 's'}`, open: () => openAction('qualification') });
    const a = config.actions;
    const crm = [a.lifecycleStages.length && 'stages', a.owners.length && 'owners', a.removeTags && 'tags', a.deals.enabled && 'deals', a.askFirst.length && 'approvals', a.disabledTools.length && `${a.disabledTools.length} tools off`].filter(Boolean);
    if (crm.length) rows.push({ key: 'tools', label: 'Tools, CRM & approvals', summary: crm.join(', '), open: () => openAction('tools') });
    return rows;
  }, [apis, config, ctx.calendars, ctx.customFields]);

  const applyApi = (api: CustomApi) => {
    const list = apiAt === 'new' ? [...apis, api] : apis.map((x, i) => (i === apiAt ? api : x));
    setConfig('actions', { ...config.actions, customApis: list });
    close();
  };

  return (
    <section aria-label="Agent settings" className="min-h-0 bg-surface xl:rounded-t-lg">
      <Panel id="actions" open={open} onToggle={onToggle} icon={<Zap className="size-4.5" />} title="Actions" sub="Configure actions your bot can perform">
        <ActionsMenu disabled={readOnly} onPick={(id) => openAction(id)} />
        {configured.length === 0 ? (
          <p className="text-caption text-fg-2">No actions configured yet</p>
        ) : (
          <ul className="space-y-2">
            {configured.map((row) => (
              <li key={row.key}>
                <button type="button" onClick={row.open} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:border-border-strong hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-body-sm font-medium text-fg">
                      <span className="truncate">{row.label}</span>
                      {row.off && <Badge tone="slate">Off</Badge>}
                    </span>
                    <span className="block truncate text-caption text-muted">{row.summary}</span>
                  </span>
                  <span className="text-caption font-medium text-accent-text">Edit</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="kb" open={open} onToggle={onToggle} icon={<BookOpen className="size-4.5" />} title="Knowledge Base Triggers" sub="Connect knowledge sources for your bot">
        {ctx.knowledgeBases.length === 0 ? (
          <p className="text-body-sm text-fg-2">
            No knowledge bases yet.{' '}
            <Link to="/knowledge" className="font-medium text-accent-text hover:underline">
              Create one →
            </Link>
          </p>
        ) : (
          <div className="space-y-2">
            {ctx.knowledgeBases.map((kb) => (
              <label key={kb.id} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={draft.knowledgeBaseIds.includes(kb.id)}
                  onChange={(e) => setDraft({ ...draft, knowledgeBaseIds: e.target.checked ? [...draft.knowledgeBaseIds, kb.id] : draft.knowledgeBaseIds.filter((id) => id !== kb.id) })}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body-sm font-medium text-fg">{kb.name}</span>
                  <span className="block text-caption text-muted">
                    {kb.documentCount} document{kb.documentCount === 1 ? '' : 's'}
                    {kb.description ? ` · ${kb.description}` : ''}
                  </span>
                </span>
              </label>
            ))}
            {draft.knowledgeBaseIds.length === 0 && <p className="text-caption text-warning-text">None selected: the agent only uses its prompt and business details.</p>}
          </div>
        )}
        <Link to="/knowledge" className="inline-block text-body-sm font-medium text-accent-text hover:underline">
          Manage Knowledge Base ↗
        </Link>
      </Panel>

      <Panel id="mode" open={open} onToggle={onToggle} icon={<MessageSquare className="size-4.5" />} title="Mode" sub="How the bot operates">
        <fieldset className="space-y-2">
          <legend className="sr-only">Mode</legend>
          {(
            [
              [false, 'Off', "The bot doesn't reply. Your team answers."],
              [true, 'Auto-Pilot', 'The bot replies to customers by itself.'],
            ] as const
          ).map(([on, label, text]) => (
            <label key={label} className={cx('flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5', draft.isActive === on ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}>
              <input type="radio" name="agent-mode" disabled={readOnly} checked={draft.isActive === on} onChange={() => setDraft({ ...draft, isActive: on })} className="mt-0.5 size-4 accent-accent" />
              <span>
                <span className="block text-body-sm font-medium text-fg">{label}</span>
                <span className="block text-caption text-muted">{text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {draft.isActive && !live && (
          <p className="text-caption text-warning-text">
            Not live yet: no website chat uses this agent.{' '}
            <button type="button" onClick={onDeploy} className="font-medium underline">
              Deploy it
            </button>
          </p>
        )}
      </Panel>

      <Panel id="timing" open={open} onToggle={onToggle} icon={<Clock className="size-4.5" />} title="Timing & Pacing" sub="When the bot replies, and when it stops">
        <Field label="Max AI replies per conversation" hint="After this, the conversation waits for your team.">
          <NumberInput
            min={1}
            max={500}
            value={config.guardrails.maxAiRepliesPerConversation}
            onChange={(v) => setConfig('guardrails', { ...config.guardrails, maxAiRepliesPerConversation: Math.round(v ?? 1) })}
          />
        </Field>
        {config.handoff.enabled ? (
          <>
            <Field label="If nobody answers a handoff (minutes)" hint="Alert the team again after this long. 0 means never.">
              <NumberInput min={0} max={1440} value={config.handoff.waitMinutes} onChange={(v) => setConfig('handoff', { ...config.handoff, waitMinutes: Math.round(v ?? 0) })} />
            </Field>
            <Field label="Then">
              <Select value={config.handoff.fallback} disabled={config.handoff.waitMinutes === 0} onChange={(e) => setConfig('handoff', { ...config.handoff, fallback: e.target.value as BotConfig['handoff']['fallback'] })}>
                <option value="keep_waiting">Keep waiting (just alert the team)</option>
                <option value="resume_ai">Tell the customer and let the agent keep helping</option>
                <option value="ask_contact_details">Ask for email or phone and let the agent keep helping</option>
              </Select>
            </Field>
            <Toggle
              label="Away message outside team hours"
              description="Team hours are set in Settings → Organization."
              checked={config.handoff.respectTeamHours}
              onChange={(v) => setConfig('handoff', { ...config.handoff, respectTeamHours: v })}
            />
          </>
        ) : (
          <p className="text-caption text-muted">Turn on Human Handover (Actions) to set what happens when the team doesn't answer in time.</p>
        )}
      </Panel>

      <Panel id="behavior" open={open} onToggle={onToggle} icon={<MessagesSquare className="size-4.5" />} title="Response Behavior" sub="How the bot replies">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Field label="Agent name">
            <Input value={config.persona.assistantName} maxLength={60} onChange={(e) => setConfig('persona', { ...config.persona, assistantName: e.target.value })} />
          </Field>
          <Field label="Tone">
            <Select value={config.persona.tone} onChange={(e) => setConfig('persona', { ...config.persona, tone: e.target.value as BotConfig['persona']['tone'] })}>
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
              <option value="casual">Casual</option>
              <option value="enthusiastic">Enthusiastic</option>
              <option value="empathetic">Empathetic</option>
            </Select>
          </Field>
          <Field label="Reply length">
            <Select value={config.persona.responseLength} onChange={(e) => setConfig('persona', { ...config.persona, responseLength: e.target.value as BotConfig['persona']['responseLength'] })}>
              <option value="short">Short</option>
              <option value="medium">Medium</option>
              <option value="detailed">Detailed</option>
            </Select>
          </Field>
          <Field label="When it doesn't know">
            <Select value={config.guardrails.unknownAnswer} onChange={(e) => setConfig('guardrails', { ...config.guardrails, unknownAnswer: e.target.value as BotConfig['guardrails']['unknownAnswer'] })}>
              <option value="collect_contact">Take their details</option>
              <option value="offer_handoff">Offer a person</option>
              <option value="say_dont_know">Say it doesn't know</option>
            </Select>
          </Field>
        </div>
        <Field label="Greeting">
          <Textarea rows={2} maxLength={500} value={config.persona.greeting} onChange={(e) => setConfig('persona', { ...config.persona, greeting: e.target.value })} />
        </Field>
        <Toggle label="Use emojis" checked={config.persona.useEmojis} onChange={(v) => setConfig('persona', { ...config.persona, useEmojis: v })} />
        <Toggle label="Stay on topic" checked={config.guardrails.stayOnTopic} onChange={(v) => setConfig('guardrails', { ...config.guardrails, stayOnTopic: v })} />
        <ul className="divide-y divide-border rounded-lg border border-border">
          {(
            [
              ['persona', 'Personality & language', config.persona.personality || `${config.persona.role}, ${config.persona.language === 'auto' ? "replies in the customer's language" : config.persona.language}`],
              ['goals', 'Goals', config.goals.primary || 'No main goal yet'],
              ['business', 'Business details', [config.business.hours && 'hours', config.business.website && 'website', config.business.phone && 'phone', config.business.services && 'services'].filter(Boolean).join(', ') || 'Nothing added yet'],
              ['guardrails', 'Guardrails', config.guardrails.forbiddenTopics.length ? `Avoids ${config.guardrails.forbiddenTopics.length} topic${config.guardrails.forbiddenTopics.length === 1 ? '' : 's'}` : 'Topics and limits'],
              ['starters', 'Conversation starters', `${config.conversationStarters.filter((s) => s.enabled).length} shown in the website chat`],
            ] as const
          ).map(([id, label, summary]) => (
            <li key={id}>
              <button type="button" onClick={() => setSub(id)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-body-sm font-medium text-fg">{label}</span>
                  <span className="block truncate text-caption text-muted">{summary}</span>
                </span>
                <ChevronRight className="size-4 text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel id="summary" open={open} onToggle={onToggle} icon={<ClipboardList className="size-4.5" />} title="Summary Settings" sub="Configure conversation summary and workflows">
        <p className="text-body-sm text-fg-2">
          A short summary is written when a conversation is handed to your team, when it's closed, and after a quiet spell. Your team sees it on the conversation, and the agent reads it when the customer
          comes back.
        </p>
        <p className="text-body-sm text-fg-2">
          To send summaries to another system, add a webhook for “conversation summarized” in{' '}
          <Link to="/automations" className="font-medium text-accent-text hover:underline">
            Automations
          </Link>
          .
        </p>
      </Panel>

      <CustomApiModal
        open={action === 'api'}
        initial={apiAt === 'new' ? null : (apis[apiAt] ?? null)}
        others={apis.filter((_, i) => i !== apiAt)}
        botId={botId}
        onApply={applyApi}
        onRemove={
          apiAt === 'new'
            ? null
            : () => {
                setConfig('actions', { ...config.actions, customApis: apis.filter((_, i) => i !== apiAt) });
                close();
              }
        }
        onClose={close}
      />
      <BookingModal
        open={action === 'booking'}
        booking={config.booking}
        askFirst={config.actions.askFirst}
        qualificationOn={config.qualification.enabled}
        ctx={ctx}
        onApply={(booking, askFirst) => {
          setDraft({ ...draft, config: { ...config, booking, actions: { ...config.actions, askFirst } } });
          close();
        }}
        onClose={close}
      />
      <WorkflowModal
        open={action === 'workflow'}
        keys={config.actions.workflowKeys}
        ctx={ctx}
        onApply={(workflowKeys) => {
          setConfig('actions', { ...config.actions, workflowKeys });
          close();
        }}
        onClose={close}
      />
      <ContactInfoModal
        open={action === 'contact'}
        value={config.leadCapture}
        ctx={ctx}
        onApply={(v) => {
          setConfig('leadCapture', v);
          close();
        }}
        onClose={close}
      />
      <HandoverModal
        open={action === 'handover'}
        value={config.handoff}
        ctx={ctx}
        onApply={(v) => {
          // Starters that hand over only work with handover on: they're switched off with it.
          const starters = v.enabled ? config.conversationStarters : config.conversationStarters.map((s) => (s.action === 'handoff' ? { ...s, enabled: false } : s));
          setDraft({ ...draft, config: { ...config, handoff: v, conversationStarters: starters } });
          close();
        }}
        onClose={close}
      />
      <QualificationModal
        open={action === 'qualification'}
        value={config.qualification}
        ctx={ctx}
        onApply={(v) => {
          setConfig('qualification', v);
          close();
        }}
        onClose={close}
      />
      <ToolsModal
        open={action === 'tools'}
        value={config.actions}
        ctx={ctx}
        onApply={(v) => {
          setConfig('actions', v);
          close();
        }}
        onClose={close}
      />
      <ComingSoonActionModal which={action && SOON.has(action) ? (action as 'stop' | 'transfer' | 'followup') : null} onClose={close} />

      <Drawer
        open={sub !== null}
        onClose={() => setSub(null)}
        title={sub ? { persona: 'Personality & language', goals: 'Goals', business: 'Business details', guardrails: 'Guardrails', starters: 'Conversation starters' }[sub] : ''}
        description="Changes go on the draft: press Save to keep them."
        footer={
          <Button variant="primary" onClick={() => setSub(null)}>
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          {sub === 'persona' && <PersonaSection value={config.persona} onChange={(v) => setConfig('persona', v)} ctx={ctx} onApplyTemplate={onApplyTemplate} />}
          {sub === 'goals' && <GoalsSection value={config.goals} onChange={(v) => setConfig('goals', v)} ctx={ctx} />}
          {sub === 'business' && <BusinessSection value={config.business} onChange={(v) => setConfig('business', v)} ctx={ctx} />}
          {sub === 'guardrails' && <GuardrailsSection value={config.guardrails} onChange={(v) => setConfig('guardrails', v)} ctx={ctx} />}
          {sub === 'starters' && (
            <StartersSection value={config.conversationStarters} onChange={(v) => setConfig('conversationStarters', v)} handoffEnabled={config.handoff.enabled} booking={bookingAbilities(config)} />
          )}
        </div>
      </Drawer>
    </section>
  );
}

function Panel({ id, open, onToggle, icon, title, sub, children }: { id: PanelId; open: PanelId | null; onToggle: (id: PanelId) => void; icon: ReactNode; title: string; sub: string; children: ReactNode }) {
  const expanded = open === id;
  const bodyId = `panel-${id}`;
  return (
    <div className="border-b border-border">
      <h3>
        <button type="button" aria-expanded={expanded} aria-controls={bodyId} onClick={() => onToggle(id)} className="flex w-full items-center gap-3 px-4 py-4 text-left hover:bg-surface-2/60">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2" aria-hidden>
            {icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium text-fg">{title}</span>
            <span className="block text-caption text-muted">{sub}</span>
          </span>
          <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform', expanded && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {expanded && (
        <div id={bodyId} className="space-y-3 px-4 pb-5">
          {children}
        </div>
      )}
    </div>
  );
}

/** "+ Setup Your Actions": a searchable menu of every action. */
function ActionsMenu({ onPick, disabled }: { onPick: (id: ActionId) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = ACTION_MENU.filter((a) => !a.hidden && a.label.toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="relative">
      <Button
        size="sm"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        icon={<Plus className="size-3.5" aria-hidden />}
        className="border-transparent bg-accent-soft text-accent-text shadow-none hover:bg-accent-soft hover:brightness-95"
        onClick={() => {
          setOpen((o) => !o);
          setQ('');
        }}
      >
        Setup Your Actions
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setOpen(false)} />
          <div role="menu" aria-label="Actions" className="absolute top-full left-0 z-20 mt-1.5 w-64 rounded-lg border border-border bg-surface p-1.5 shadow-pop">
            <label className="mb-1 flex h-8 items-center gap-1.5 rounded-md border border-accent px-2 text-muted">
              <Search className="size-3.5" aria-hidden />
              <span className="sr-only">Search actions</span>
              {/* Opening the menu is a request to pick: the search takes the keyboard straight away. */}
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-body-sm text-fg focus:outline-none" />
            </label>
            {list.length === 0 && <p className="px-2 py-1.5 text-caption text-muted">No action matches.</p>}
            {list.map((a, i) => (
              <div key={a.id}>
                {a.more && !list[i - 1]?.more && <p className="mt-1 border-t border-border px-2 pt-1.5 pb-0.5 text-label font-semibold tracking-[0.06em] text-muted uppercase">More</p>}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onPick(a.id);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-body-sm text-fg hover:bg-surface-2"
                >
                  {a.label}
                  {SOON.has(a.id) && <span className="text-label text-muted">Coming soon</span>}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

