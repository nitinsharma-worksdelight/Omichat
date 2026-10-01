import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Eye, PanelRightClose, PanelRightOpen, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm, useToast } from '../../components/feedback-context';
import { Drawer } from '../../components/overlay';
import { Badge, Button, Card, CodeBlock, CopyButton, cx, ErrorBanner, Input, JsonDisclosure, PageHeader, Spinner, SkeletonRows } from '../../components/ui';
import { ApiError, get, patch } from '../../lib/api';
import { formatNumber, TOOL_LABELS } from '../../lib/format';
import { roleAtLeast, useBots, useCalendars, useCustomFields, useKnowledgeBases, useMembers, useOrg, usePipelines, useTags, useWorkflows } from '../../lib/queries';
import { Link, navigate, useRoute, withQuery } from '../../lib/router';
import type { Bot, BotConfig, BotConfigSection, BotPreview } from '../../lib/types';
import { EditorOverview, SaveBar, SaveErrors, SectionHeader, SettingsMenu, SettingsSearch, type SettingsTarget } from './editor';
import { CONFIG_SECTIONS, essentials, isEditorView, sectionOfError, SECTIONS, type BotDraft, type EditorView, type SectionId } from './editorNav';
import { Playground } from './Playground';
import {
  ActionsSection,
  BookingSection,
  BusinessSection,
  GoalsSection,
  GuardrailsSection,
  HandoffSection,
  InstructionsSection,
  KnowledgeSection,
  LeadCaptureSection,
  ModelSection,
  PersonaSection,
  QualificationSection,
  StartersSection,
  type EditorContext,
  type PersonalityTemplate,
} from './sections';

function toDraft(bot: Bot): BotDraft {
  return {
    name: bot.name,
    isActive: bot.isActive,
    model: bot.model ?? '',
    effort: bot.effort ?? '',
    maxOutputTokens: bot.maxOutputTokens,
    knowledgeBaseIds: [...bot.knowledgeBaseIds],
    // A server from before conversation starters has none to send.
    config: structuredClone({ ...bot.config, conversationStarters: bot.config.conversationStarters ?? [] }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only what changed: top-level fields plus whole config sections (the server replaces a section wholesale). */
function buildPatch(base: BotDraft, draft: BotDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== base.name) body.name = draft.name.trim();
  if (draft.isActive !== base.isActive) body.isActive = draft.isActive;
  if (draft.model.trim() !== base.model) body.model = draft.model.trim() || null;
  if (draft.effort !== base.effort) body.effort = draft.effort || null;
  if (draft.maxOutputTokens !== base.maxOutputTokens) body.maxOutputTokens = draft.maxOutputTokens;
  if (!same([...draft.knowledgeBaseIds].sort(), [...base.knowledgeBaseIds].sort())) body.knowledgeBaseIds = draft.knowledgeBaseIds;
  const config: Partial<Record<BotConfigSection, unknown>> = {};
  for (const s of CONFIG_SECTIONS) if (!same(draft.config[s], base.config[s])) config[s] = draft.config[s];
  if (Object.keys(config).length) body.config = config;
  return body;
}

export function BotEditorPage({ botId }: { botId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const route = useRoute();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const bot = useQuery({ queryKey: ['bot', botId], queryFn: () => get<Bot>(`/v1/bots/${botId}`) });
  const allBots = useBots();
  const customFields = useCustomFields();
  const calendars = useCalendars();
  const workflows = useWorkflows(isAdmin);
  const tags = useTags();
  const org = useOrg();
  const members = useMembers();
  const pipelines = usePipelines();
  const kbs = useKnowledgeBases();

  const [base, setBase] = useState<BotDraft | null>(null);
  const [draft, setDraft] = useState<BotDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [testChatOpen, setTestChatOpen] = useState(() => window.innerWidth >= 1280);
  // On narrow screens the test chat is an overlay: Escape closes it.
  useEffect(() => {
    if (!testChatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !window.matchMedia('(min-width: 1280px)').matches) setTestChatOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [testChatOpen]);
  const [searchOpen, setSearchOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bot.data && !base) {
      setBase(toDraft(bot.data));
      setDraft(toDraft(bot.data));
    }
  }, [bot.data, base]);

  // `?tab=` names the open section, as it always has, so older links still land in the right place; none = the overview.
  const tabParam = route.query.get('tab');
  const view: EditorView = isEditorView(tabParam) ? tabParam : 'overview';
  const setView = (next: EditorView) => navigate(withQuery(route, { tab: next === 'overview' ? null : next }), { replace: true });

  // A different section starts at its top.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [view]);

  // A search result for one setting: once its section shows, bring the setting into view, put the cursor in it and
  // highlight it for a moment.
  const [jumpTo, setJumpTo] = useState<SettingsTarget | null>(null);
  useEffect(() => {
    if (!jumpTo?.setting || jumpTo.view !== view) return;
    setJumpTo(null);
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(jumpTo.setting)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const control =
      el.querySelector<HTMLElement>('input[type=radio]:checked') ??
      el.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
    control?.focus({ preventScroll: true });
    el.setAttribute('data-flash', '');
    const done = (e: AnimationEvent) => {
      if (e.target !== el) return;
      el.removeAttribute('data-flash');
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }, [jumpTo, view]);

  // Cmd/Ctrl+K finds a setting (not while another dialog is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      if (document.querySelector('[data-dialog-panel]')) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const changes = useMemo(() => (base && draft ? buildPatch(base, draft) : {}), [base, draft]);
  const dirty = Object.keys(changes).length > 0;

  // Errors from a failed save no longer apply once the draft is back to the saved version.
  useEffect(() => {
    if (!dirty) setSaveError(null);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const details = saveError instanceof ApiError ? saveError.details : [];
  const badSections = new Set(details.map(sectionOfError).filter((s): s is SectionId => s !== null));
  const dirtySections = useMemo(() => {
    const set = new Set<SectionId>();
    if (!base || !draft) return set;
    for (const s of CONFIG_SECTIONS) if (!same(draft.config[s], base.config[s])) set.add(s);
    if (draft.model !== base.model || draft.effort !== base.effort || draft.maxOutputTokens !== base.maxOutputTokens) set.add('model');
    if (!same([...draft.knowledgeBaseIds].sort(), [...base.knowledgeBaseIds].sort())) set.add('knowledge');
    return set;
  }, [base, draft]);
  /** What the save bar lists as changed. */
  const changedNames = useMemo(() => {
    if (!base || !draft) return [];
    const names = SECTIONS.filter((s) => dirtySections.has(s.id)).map((s) => s.label);
    if (draft.name.trim() !== base.name) names.unshift('Name');
    if (draft.isActive !== base.isActive) names.unshift('Status');
    return names.length ? names : ['Settings'];
  }, [base, draft, dirtySections]);

  const save = async () => {
    if (!dirty || !draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await patch<Bot>(`/v1/bots/${botId}`, changes);
      qc.setQueryData(['bot', botId], updated);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['bot-preview', botId] });
      setBase(toDraft(updated));
      setDraft(toDraft(updated));
      toast.success(`Saved — version ${updated.version}`);
    } catch (err) {
      setSaveError(err);
      if (!(err instanceof ApiError) || !err.details.length) toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (bot.isLoading || (!draft && !bot.error)) {
    return (
      <div>
        <PageHeader title="Loading bot…" />
        <SkeletonRows rows={8} className="px-4 sm:px-8" />
      </div>
    );
  }
  if (bot.error || !draft || !base) {
    return (
      <div>
        <PageHeader title="Bot" actions={<Button onClick={() => navigate('/bots')}>Back to bots</Button>} />
        <ErrorBanner className="m-8" error={bot.error} onRetry={() => void bot.refetch()} />
      </div>
    );
  }

  const ctx: EditorContext = {
    customFields: customFields.data ?? [],
    calendars: calendars.data ?? [],
    workflows: isAdmin ? (workflows.data ?? []) : null,
    tags: tags.data ?? [],
    lifecycleStages: org.data?.settings.lifecycleStages ?? [],
    knowledgeBases: kbs.data ?? [],
    otherBots: (allBots.data ?? []).filter((b) => b.id !== botId).map((b) => ({ name: b.name, questions: b.config.qualification.questions })),
    organizationName: org.data?.name ?? '',
    assistantName: draft.config.persona.assistantName.trim() || 'your assistant',
    members: members.data ?? [],
    pipelines: pipelines.data ?? [],
  };
  const setConfig = <K extends BotConfigSection>(key: K, value: BotConfig[K]) => setDraft((d) => (d ? { ...d, config: { ...d.config, [key]: value } } : d));
  /** Fills the persona and the main goal from a template; asks first if the business already wrote its own. */
  const applyTemplate = async (template: PersonalityTemplate) => {
    const current = draft?.config;
    if (!current) return;
    if (
      (current.persona.personality.trim() || current.goals.primary.trim()) &&
      !(await confirm({
        title: `Use the ${template.label} template?`,
        message: 'It replaces the role, tone, reply length, personality and main goal. Nothing is saved until you press Save.',
        confirmLabel: 'Use template',
      }))
    ) {
      return;
    }
    setDraft((d) =>
      d ? { ...d, config: { ...d.config, persona: { ...d.config.persona, ...template.persona }, goals: { ...d.config.goals, primary: template.goal } } } : d,
    );
    toast.success(`${template.label} template applied: review it, then save`);
  };

  const persona = draft.config.persona;
  const assistantName = persona.assistantName.trim() || 'your assistant';
  // Booking counts as an essential only with a calendar, so the count waits for the calendars.
  const calendarsKnown = !calendars.isLoading;
  const essentialList = calendarsKnown ? essentials(draft, ctx) : null;
  const progress = essentialList ? `${essentialList.filter((e) => e.done).length}/${essentialList.length}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-3 sm:px-5">
        <Link
          to="/bots"
          aria-label="Back to bots"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Link>
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-ai-soft font-display text-[17px] font-bold text-ai-text ring-1 ring-ai/30">
          {(persona.assistantName.trim() || draft.name.trim() || '?').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <label htmlFor="bot-name" className="sr-only">
              Bot name
            </label>
            <input
              id="bot-name"
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="-ml-1 w-[20ch] max-w-[300px] min-w-[6ch] rounded-md bg-transparent px-1 font-display text-[18px] leading-6 font-semibold tracking-[-0.02em] text-fg field-sizing-content hover:bg-surface-2 focus:bg-surface focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none supports-[field-sizing:content]:w-auto"
            />
            <Badge tone="slate">v{bot.data?.version}</Badge>
          </div>
          <p className="truncate text-caption text-muted">
            {persona.assistantName}
            {(persona.companyName || ctx.organizationName) && ` · ${persona.companyName || ctx.organizationName}`}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.isActive}
          onClick={() => setDraft({ ...draft, isActive: !draft.isActive })}
          title={draft.isActive ? 'Replying to visitors. Click to pause, then save.' : "Paused: it doesn't reply. Click to turn it on, then save."}
          className={cx(
            'ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-caption font-semibold transition-colors',
            draft.isActive ? 'border-success/30 bg-success-soft text-success-text hover:border-success/50' : 'border-border bg-surface-2 text-muted hover:text-fg-2',
          )}
        >
          <span className={cx('size-2 rounded-full', draft.isActive ? 'bg-success' : 'bg-faint')} aria-hidden />
          {draft.isActive ? 'Active' : 'Paused'}
        </button>
        <div className="flex-1" />
        <p aria-live="polite" className="hidden items-center gap-1.5 text-body-sm whitespace-nowrap text-muted xl:flex">
          {saving ? (
            'Saving…'
          ) : dirty ? (
            <>
              <span className="size-2 rounded-full bg-warning" aria-hidden />
              Unsaved changes
            </>
          ) : (
            <>
              <Check className="size-3.5" aria-hidden />
              All changes saved
            </>
          )}
        </p>
        {isAdmin && (
          <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" aria-hidden />} aria-label="Prompt preview" title="Prompt preview" onClick={() => setPreviewOpen(true)}>
            <span className="hidden xl:inline">Prompt preview</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={testChatOpen ? <PanelRightClose className="size-3.5" aria-hidden /> : <PanelRightOpen className="size-3.5" aria-hidden />}
          onClick={() => setTestChatOpen((o) => !o)}
          aria-pressed={testChatOpen}
          className={testChatOpen ? 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text' : undefined}
        >
          Test chat
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Save className="size-3.5" aria-hidden />}
          disabled={!dirty || !isAdmin}
          loading={saving}
          onClick={() => void save()}
          title={isAdmin ? undefined : 'Only admins can change bots'}
        >
          Save changes
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <SettingsMenu
          view={view}
          onSelect={setView}
          onSearch={() => setSearchOpen(true)}
          draft={draft}
          assistantName={assistantName}
          progress={progress}
          dirty={dirtySections}
          errors={badSections}
        />
        <div className="relative min-w-0 flex-1">
          <div ref={contentRef} className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-4 px-4 pt-6 pb-28 sm:px-6 xl:px-8">
              {saveError ? (
                details.length ? (
                  <SaveErrors details={details} view={view} onOpen={setView} />
                ) : (
                  <ErrorBanner error={saveError} />
                )
              ) : null}
              {view === 'overview' &&
                (essentialList ? (
                  <EditorOverview draft={draft} ctx={ctx} onOpen={setView} onTestChat={testChatOpen ? null : () => setTestChatOpen(true)} />
                ) : (
                  <SkeletonRows rows={6} />
                ))}
              {view !== 'overview' && <SectionHeader section={view} assistantName={assistantName} />}
              {view === 'persona' && <PersonaSection value={draft.config.persona} onChange={(v) => setConfig('persona', v)} ctx={ctx} onApplyTemplate={(t) => void applyTemplate(t)} />}
              {view === 'conversationStarters' && (
                <StartersSection
                  value={draft.config.conversationStarters}
                  onChange={(v) => setConfig('conversationStarters', v)}
                  handoffEnabled={draft.config.handoff.enabled}
                />
              )}
              {view === 'goals' && <GoalsSection value={draft.config.goals} onChange={(v) => setConfig('goals', v)} ctx={ctx} />}
              {view === 'instructions' && <InstructionsSection value={draft.config.instructions} onChange={(v) => setConfig('instructions', v)} />}
              {view === 'business' && <BusinessSection value={draft.config.business} onChange={(v) => setConfig('business', v)} ctx={ctx} />}
              {view === 'leadCapture' && <LeadCaptureSection value={draft.config.leadCapture} onChange={(v) => setConfig('leadCapture', v)} ctx={ctx} />}
              {view === 'qualification' && <QualificationSection value={draft.config.qualification} onChange={(v) => setConfig('qualification', v)} ctx={ctx} />}
              {view === 'booking' && <BookingSection value={draft.config.booking} onChange={(v) => setConfig('booking', v)} ctx={ctx} />}
              {view === 'handoff' && <HandoffSection value={draft.config.handoff} onChange={(v) => setConfig('handoff', v)} ctx={ctx} />}
              {view === 'guardrails' && <GuardrailsSection value={draft.config.guardrails} onChange={(v) => setConfig('guardrails', v)} ctx={ctx} />}
              {view === 'actions' && <ActionsSection value={draft.config.actions} onChange={(v) => setConfig('actions', v)} ctx={ctx} />}
              {view === 'model' && (
                <ModelSection
                  value={{ model: draft.model, effort: draft.effort, maxOutputTokens: draft.maxOutputTokens }}
                  onChange={(v) => setDraft({ ...draft, ...v })}
                />
              )}
              {view === 'knowledge' && <KnowledgeSection value={draft.knowledgeBaseIds} onChange={(v) => setDraft({ ...draft, knowledgeBaseIds: v })} ctx={ctx} />}
              {!isAdmin && <p className="text-body-sm text-muted">You have read-only access. Ask an admin to change this bot.</p>}
            </div>
          </div>
          {dirty && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4 sm:px-6 xl:px-8">
              <SaveBar
                changes={changedNames}
                saving={saving}
                canSave={isAdmin}
                onDiscard={() => {
                  setDraft(structuredClone(base));
                  setSaveError(null);
                }}
                onSave={() => void save()}
              />
            </div>
          )}
        </div>
        {testChatOpen && <div className="fixed inset-0 z-30 bg-overlay xl:hidden" aria-hidden onClick={() => setTestChatOpen(false)} />}
        {testChatOpen && (
          // Below 1280 px the test chat opens over the settings instead of squeezing them.
          <aside
            className="fixed inset-y-0 right-0 z-40 w-[min(380px,100vw)] shrink-0 border-l border-border bg-surface shadow-modal xl:static xl:z-auto xl:w-[380px] xl:shadow-none"
            aria-label="Test chat"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 justify-end border-b border-border px-3 py-1.5 xl:hidden">
                <Button size="xs" variant="ghost" icon={<X className="size-3.5" aria-hidden />} onClick={() => setTestChatOpen(false)}>
                  Close test chat
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                {/* Named like the website chat, from the saved bot: that's the version the test chat talks to. */}
                <Playground botId={botId} dirty={dirty} title={bot.data?.config.persona.companyName || ctx.organizationName} />
              </div>
            </div>
          </aside>
        )}
      </div>

      <SettingsSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(target) => {
          setView(target.view);
          if (target.setting) setJumpTo(target);
        }}
        assistantName={assistantName}
      />
      <PromptPreviewDrawer botId={botId} open={previewOpen} onClose={() => setPreviewOpen(false)} dirty={dirty} />
    </div>
  );
}

function PromptPreviewDrawer({ botId, open, onClose, dirty }: { botId: string; open: boolean; onClose: () => void; dirty: boolean }) {
  const preview = useQuery({
    queryKey: ['bot-preview', botId],
    queryFn: () => get<BotPreview>(`/v1/bots/${botId}/preview`),
    enabled: open,
    staleTime: 0,
  });
  const [filter, setFilter] = useState('');
  const tools = (preview.data?.tools ?? []).filter((t) => !filter || t.name.includes(filter.toLowerCase()));
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Prompt preview"
      description="The exact system prompt and tools the model receives for this bot."
      width="max-w-3xl"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {dirty && <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-body-sm text-warning-text">You have unsaved changes. This preview shows the saved version.</p>}
      {preview.isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : preview.error ? (
        <ErrorBanner error={preview.error} onRetry={() => void preview.refetch()} />
      ) : preview.data ? (
        <div className="space-y-6">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-body font-semibold text-fg">
                System prompt{' '}
                <span className="font-normal text-muted">
                  · {formatNumber(preview.data.system.length)} characters (~{formatNumber(Math.round(preview.data.system.length / 4))} tokens)
                </span>
              </h3>
              <CopyButton text={preview.data.system} />
            </div>
            <CodeBlock className="max-h-[50vh] overflow-y-auto">{preview.data.system}</CodeBlock>
          </section>
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-4">
              <h3 className="text-body font-semibold text-fg">
                Tools <span className="font-normal text-muted">· {preview.data.tools.length}</span>
              </h3>
              <Input className="max-w-56" placeholder="Filter tools" aria-label="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Card className="divide-y divide-border">
              {tools.map((t) => (
                <div key={t.name} className="space-y-1.5 px-4 py-3">
                  <p className="text-body-sm font-medium text-fg">
                    {TOOL_LABELS[t.name]?.label ?? t.name} <code className="ml-1 font-mono text-caption text-muted">{t.name}</code>
                  </p>
                  <p className="text-caption whitespace-pre-wrap text-muted">{t.description}</p>
                  <JsonDisclosure label="Input schema" value={t.inputSchema} />
                </div>
              ))}
              {tools.length === 0 && <p className="px-4 py-6 text-center text-body-sm text-muted">No tools match.</p>}
            </Card>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
