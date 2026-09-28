import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, PanelRightClose, PanelRightOpen, Save, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm, useToast } from '../../components/feedback-context';
import { Drawer } from '../../components/overlay';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  CopyButton,
  ErrorBanner,
  Input,
  JsonDisclosure,
  PageHeader,
  Spinner,
  SkeletonRows,
  Tabs,
  Toggle,
  type TabItem,
} from '../../components/ui';
import { ApiError, get, patch, type ErrorDetail } from '../../lib/api';
import { formatNumber, TOOL_LABELS } from '../../lib/format';
import { roleAtLeast, useBots, useCalendars, useCustomFields, useKnowledgeBases, useMembers, useOrg, usePipelines, useTags, useWorkflows } from '../../lib/queries';
import { Link, navigate, useRoute, withQuery } from '../../lib/router';
import type { Bot, BotConfig, BotConfigSection, BotPreview, Effort } from '../../lib/types';
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
  type EditorContext,
  type PersonalityTemplate,
} from './sections';

interface BotDraft {
  name: string;
  isActive: boolean;
  /** '' = follow the server configuration. */
  model: string;
  effort: Effort | '';
  maxOutputTokens: number;
  knowledgeBaseIds: string[];
  config: BotConfig;
}

type TabId = BotConfigSection | 'model' | 'knowledge';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'persona', label: 'Persona' },
  { id: 'goals', label: 'Goals' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'business', label: 'Business info' },
  { id: 'leadCapture', label: 'Lead capture' },
  { id: 'qualification', label: 'Qualification' },
  { id: 'booking', label: 'Booking' },
  { id: 'handoff', label: 'Handoff' },
  { id: 'guardrails', label: 'Guardrails' },
  { id: 'actions', label: 'Actions' },
  { id: 'model', label: 'Model' },
  { id: 'knowledge', label: 'Knowledge' },
];

const CONFIG_SECTIONS: BotConfigSection[] = ['persona', 'goals', 'instructions', 'business', 'leadCapture', 'qualification', 'booking', 'handoff', 'guardrails', 'actions'];

function toDraft(bot: Bot): BotDraft {
  return {
    name: bot.name,
    isActive: bot.isActive,
    model: bot.model ?? '',
    effort: bot.effort ?? '',
    maxOutputTokens: bot.maxOutputTokens,
    knowledgeBaseIds: [...bot.knowledgeBaseIds],
    config: structuredClone(bot.config),
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

function tabOf(section: string): TabId | null {
  if ((CONFIG_SECTIONS as string[]).includes(section)) return section as TabId;
  if (section === 'model' || section === 'effort' || section === 'maxOutputTokens') return 'model';
  if (section === 'knowledgeBaseIds') return 'knowledge';
  if (section === 'customFields' || section === 'unknown custom fields') return 'leadCapture';
  if (section === 'unknown workflow keys') return 'actions';
  return null;
}

/** Which tabs a server validation error points at (paths like `qualification.rules.0.value` or messages like "booking: …"). */
function errorTabs(details: ErrorDetail[]): Set<TabId> {
  const tabs = new Set<TabId>();
  for (const d of details) {
    const path = d.path.startsWith('config.') ? d.path.slice(7) : d.path;
    const fromPath = path && path !== 'config' ? tabOf(path.split('.')[0]!) : null;
    const fromMessage = tabOf(d.message.split(/[:.]/)[0]!.trim());
    const tab = fromPath ?? fromMessage;
    if (tab) tabs.add(tab);
  }
  return tabs;
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
  const [playgroundOpen, setPlaygroundOpen] = useState(() => window.innerWidth >= 1280);

  useEffect(() => {
    if (bot.data && !base) {
      setBase(toDraft(bot.data));
      setDraft(toDraft(bot.data));
    }
  }, [bot.data, base]);

  const tabParam = route.query.get('tab') as TabId | null;
  const tab: TabId = tabParam && TABS.some((t) => t.id === tabParam) ? tabParam : 'persona';
  const setTab = (id: TabId) => navigate(withQuery(route, { tab: id }), { replace: true });

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
  const badTabs = errorTabs(details);
  const dirtyTabs = useMemo(() => {
    const set = new Set<TabId>();
    if (!base || !draft) return set;
    for (const s of CONFIG_SECTIONS) if (!same(draft.config[s], base.config[s])) set.add(s);
    if (draft.model !== base.model || draft.effort !== base.effort || draft.maxOutputTokens !== base.maxOutputTokens) set.add('model');
    if (!same([...draft.knowledgeBaseIds].sort(), [...base.knowledgeBaseIds].sort())) set.add('knowledge');
    return set;
  }, [base, draft]);

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
        <SkeletonRows rows={8} className="px-8" />
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
  const tabs: TabItem<TabId>[] = TABS.map((t) => ({ ...t, dot: badTabs.has(t.id) ? 'error' : dirtyTabs.has(t.id) ? 'dirty' : null }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/bots" className="text-muted hover:text-fg" aria-label="Back to bots">
              <ArrowLeft className="size-4" />
            </Link>
            <label htmlFor="bot-name" className="sr-only">
              Bot name
            </label>
            <input
              id="bot-name"
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="-ml-1 min-w-0 rounded-md bg-transparent px-1 text-lg font-semibold text-fg hover:bg-surface-2 focus:bg-surface focus:shadow-[0_0_0_3px_var(--ring)] focus:outline-none"
            />
            <Badge tone="slate">v{bot.data?.version}</Badge>
          </span>
        }
        description={`${draft.config.persona.assistantName}${draft.config.persona.companyName ? ` · ${draft.config.persona.companyName}` : ''} · ${bot.data?.model ?? draft.model}`}
        actions={
          <>
            <Toggle size="sm" label={<span className="text-[13px]">{draft.isActive ? 'Active' : 'Inactive'}</span>} checked={draft.isActive} onChange={(v) => setDraft({ ...draft, isActive: v })} className="mr-2 items-center" />
            {isAdmin && (
              <Button size="sm" variant="ghost" icon={<Eye className="size-3.5" />} onClick={() => setPreviewOpen(true)}>
                Prompt preview
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={playgroundOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
              onClick={() => setPlaygroundOpen((o) => !o)}
              aria-pressed={playgroundOpen}
            >
              Playground
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Undo2 className="size-3.5" />}
                onClick={() => {
                  setDraft(structuredClone(base));
                  setSaveError(null);
                }}
              >
                Discard
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty || !isAdmin} loading={saving} onClick={() => void save()} title={isAdmin ? undefined : 'Only admins can change bots'}>
              Save changes
            </Button>
          </>
        }
      >
        <Tabs className="px-6" tabs={tabs} value={tab} onChange={setTab} ariaLabel="Bot configuration sections" />
      </PageHeader>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 px-8 py-6">
            {saveError ? <ErrorBanner error={saveError} title={details.length ? 'The configuration was not saved:' : undefined} details={details} /> : null}
            {tab === 'persona' && <PersonaSection value={draft.config.persona} onChange={(v) => setConfig('persona', v)} ctx={ctx} onApplyTemplate={(t) => void applyTemplate(t)} />}
            {tab === 'goals' && <GoalsSection value={draft.config.goals} onChange={(v) => setConfig('goals', v)} ctx={ctx} />}
            {tab === 'instructions' && <InstructionsSection value={draft.config.instructions} onChange={(v) => setConfig('instructions', v)} />}
            {tab === 'business' && <BusinessSection value={draft.config.business} onChange={(v) => setConfig('business', v)} ctx={ctx} />}
            {tab === 'leadCapture' && <LeadCaptureSection value={draft.config.leadCapture} onChange={(v) => setConfig('leadCapture', v)} ctx={ctx} />}
            {tab === 'qualification' && <QualificationSection value={draft.config.qualification} onChange={(v) => setConfig('qualification', v)} ctx={ctx} />}
            {tab === 'booking' && <BookingSection value={draft.config.booking} onChange={(v) => setConfig('booking', v)} ctx={ctx} />}
            {tab === 'handoff' && <HandoffSection value={draft.config.handoff} onChange={(v) => setConfig('handoff', v)} ctx={ctx} />}
            {tab === 'guardrails' && <GuardrailsSection value={draft.config.guardrails} onChange={(v) => setConfig('guardrails', v)} ctx={ctx} />}
            {tab === 'actions' && <ActionsSection value={draft.config.actions} onChange={(v) => setConfig('actions', v)} ctx={ctx} />}
            {tab === 'model' && (
              <ModelSection
                value={{ model: draft.model, effort: draft.effort, maxOutputTokens: draft.maxOutputTokens }}
                onChange={(v) => setDraft({ ...draft, ...v })}
              />
            )}
            {tab === 'knowledge' && <KnowledgeSection value={draft.knowledgeBaseIds} onChange={(v) => setDraft({ ...draft, knowledgeBaseIds: v })} ctx={ctx} />}
            {!isAdmin && <p className="text-[13px] text-muted">You have read-only access. Ask an admin to change this bot.</p>}
          </div>
        </div>
        {playgroundOpen && (
          <aside className="w-[380px] shrink-0 border-l border-border" aria-label="Playground">
            <Playground botId={botId} dirty={dirty} />
          </aside>
        )}
      </div>

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
      {dirty && <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-text">You have unsaved changes. This preview shows the saved version.</p>}
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
              <h3 className="text-sm font-semibold text-fg">
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
              <h3 className="text-sm font-semibold text-fg">
                Tools <span className="font-normal text-muted">· {preview.data.tools.length}</span>
              </h3>
              <Input className="max-w-56" placeholder="Filter tools" aria-label="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Card className="divide-y divide-border">
              {tools.map((t) => (
                <div key={t.name} className="space-y-1.5 px-4 py-3">
                  <p className="text-[13px] font-medium text-fg">
                    {TOOL_LABELS[t.name]?.label ?? t.name} <code className="ml-1 font-mono text-xs text-muted">{t.name}</code>
                  </p>
                  <p className="text-xs whitespace-pre-wrap text-muted">{t.description}</p>
                  <JsonDisclosure label="Input schema" value={t.inputSchema} />
                </div>
              ))}
              {tools.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-muted">No tools match.</p>}
            </Card>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
