import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Hammer, MessageSquareText, MoreHorizontal, Pencil, Rocket, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { useConfirm, useToast } from '../../../components/feedback-context';
import { MenuItem, Popover } from '../../../components/overlay';
import { Button, cx, ErrorBanner, SkeletonRows } from '../../../components/ui';
import { ApiError, del, get, patch, post } from '../../../lib/api';
import { roleAtLeast, useBots, useCalendars, useChannels, useCustomFields, useKnowledgeBases, useMembers, useOrg, usePipelines, useTags, useWorkflows } from '../../../lib/queries';
import { currentPath, navigate, useRoute, withQuery } from '../../../lib/router';
import type { Bot, KbDocument } from '../../../lib/types';
import { PromptPreviewDrawer } from '../../bots/BotEditorPage';
import { buildPatch, toDraft } from '../../bots/draft';
import { businessProblems, errorText, type BotDraft } from '../../bots/editorNav';
import { Playground } from '../../bots/Playground';
import type { EditorContext, PersonalityTemplate } from '../../bots/sections';
import { bookingCalendar, botWarnings } from '../../bots/warnings';
import { agentChannels } from '../shared';
import { DeployPanel } from './DeployPanel';
import { PromptPanel } from './PromptPanel';
import { SettingsPanels, type ActionId, type PanelId } from './SettingsPanels';

const LIST = '/ai-agents/conversation-ai';

/**
 * The GHL-style agent editor: Build (prompt, settings, test chat side by side) and Deploy (channels). Edits stay on
 * a draft until Save; the full settings editor stays one click away for anything grouped out of sight here.
 */
export function AgentEditorPage({ botId }: { botId: string }) {
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
  const channels = useChannels();
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
  const [renaming, setRenaming] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const setup = route.query.get('setup');
  const [panel, setPanel] = useState<PanelId | null>(setup === 'kb' ? 'kb' : 'actions');
  const [startAction, setStartAction] = useState<ActionId | null>(setup === 'booking' ? 'booking' : null);
  const tab = route.query.get('tab') === 'deploy' ? 'deploy' : 'build';
  const documents = useQueries({
    queries: (draft?.knowledgeBaseIds ?? []).map((id) => ({ queryKey: ['documents', id], queryFn: () => get<KbDocument[]>(`/v1/knowledge-bases/${id}/documents`) })),
  }).flatMap((q) => q.data ?? []);

  useEffect(() => {
    if (bot.data && !base) {
      setBase(toDraft(bot.data));
      setDraft(toDraft(bot.data));
    }
  }, [bot.data, base]);
  // `?setup=` is for the first opening only: drop it so a reload doesn't open the setup again.
  useEffect(() => {
    if (setup) navigate(withQuery(route, { setup: null }), { replace: true });
  }, [setup, route]);

  const changes = useMemo(() => (base && draft ? buildPatch(base, draft) : {}), [base, draft]);
  const dirty = Object.keys(changes).length > 0;
  useEffect(() => {
    if (!dirty) setSaveError(null);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // A link elsewhere in the dashboard (the menu, a "Manage Knowledge Base" link, a modal's link) asks first too.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href^="#/"]');
      if (!link || link.getAttribute('target') === '_blank') return;
      const to = link.getAttribute('href')!.slice(1);
      if (to.split('?')[0] === currentPath()) return;
      e.preventDefault();
      void leave(to);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  });

  const leave = async (to: string) => {
    if (dirty && !(await confirm({ title: 'Leave without saving?', message: 'Your unsaved changes to this agent will be lost.', confirmLabel: 'Leave', danger: true }))) return;
    navigate(to);
  };
  const setTab = (next: 'build' | 'deploy') => navigate(withQuery(route, { tab: next === 'build' ? null : next }), { replace: true });
  const onStartActionDone = useCallback(() => setStartAction(null), []);
  // Below 1280 px the test panel opens over the page: Escape closes it.
  useEffect(() => {
    if (!testOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-dialog-panel]')) setTestOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [testOpen]);

  const save = async () => {
    if (!dirty || !draft) return;
    if (!draft.name.trim()) {
      setSaveError(new ApiError(400, 'validation_error', 'Give the agent a name.', [{ path: 'name', message: 'Give the agent a name.' }]));
      return;
    }
    const problems = businessProblems(draft.config.business, base?.config.business);
    if (problems.length) {
      setSaveError(new ApiError(400, 'validation_error', 'Request validation failed', problems));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await patch<Bot>(`/v1/bots/${botId}`, changes);
      qc.setQueryData(['bot', botId], updated);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['bot-preview', botId] });
      setBase(toDraft(updated));
      setDraft(toDraft(updated));
      toast.success('Agent saved');
    } catch (err) {
      setSaveError(err);
      if (!(err instanceof ApiError) || !err.details.length) toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    try {
      const copy = await post<Bot>(`/v1/bots/${botId}/duplicate`);
      await qc.invalidateQueries({ queryKey: ['bots'] });
      toast.success(`Duplicated as “${copy.name}” (Off)`);
      void leave(`/bots/${copy.id}`);
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${base?.name}”?`,
      message: 'Channels using this agent stop replying until you pick another one. Past conversations are kept.',
      confirmLabel: 'Delete agent',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/v1/bots/${botId}`);
      await Promise.all([qc.invalidateQueries({ queryKey: ['bots'] }), qc.invalidateQueries({ queryKey: ['channels'] })]);
      toast.success('Agent deleted');
      navigate(LIST);
    } catch (err) {
      toast.error(err);
    }
  };

  if (bot.isLoading || (!draft && !bot.error)) {
    return (
      <div className="p-6">
        <SkeletonRows rows={8} />
      </div>
    );
  }
  if (bot.error || !draft || !base) {
    return (
      <div className="space-y-4 p-8">
        <ErrorBanner error={bot.error} title="We couldn't load this agent." onRetry={() => void bot.refetch()} />
        <Button onClick={() => navigate(LIST)}>Back to agents</Button>
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
    warnings: botWarnings(draft.config, calendars.data ?? [], documents),
    bookingCalendar: bookingCalendar(draft.config, calendars.data ?? []),
  };
  const live = agentChannels(channels.data, botId).some((c) => c.status === 'active');
  const applyTemplate = async (template: PersonalityTemplate) => {
    const current = draft.config;
    if (
      (current.persona.personality.trim() || current.goals.primary.trim()) &&
      !(await confirm({ title: `Use the ${template.label} template?`, message: 'It replaces the role, tone, reply length, personality and main goal. Nothing is saved until you press Save.', confirmLabel: 'Use template' }))
    ) {
      return;
    }
    setDraft((d) => (d ? { ...d, config: { ...d.config, persona: { ...d.config.persona, ...template.persona }, goals: { ...d.config.goals, primary: template.goal } } } : d));
  };
  const details = saveError instanceof ApiError ? saveError.details : [];
  const testTitle = bot.data?.config.persona.companyName || ctx.organizationName;

  return (
    // Side by side from 1024 px, each column scrolling on its own; narrower, the columns stack and the page scrolls.
    <div className="flex min-h-full flex-col bg-surface-2 lg:h-full lg:min-h-0">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-[1_1_280px] items-center gap-2">
          <button type="button" aria-label="Back to agents" onClick={() => void leave(LIST)} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg hover:bg-surface-3">
            <ArrowLeft className="size-5" aria-hidden />
          </button>
          {renaming ? (
            <NameInput
              value={draft.name}
              onDone={(name) => {
                setRenaming(false);
                if (name !== null) setDraft({ ...draft, name });
              }}
            />
          ) : (
            <>
              <h1 className="truncate text-[19px] leading-7 font-medium text-fg">{draft.name || 'Untitled agent'}</h1>
              {isAdmin && (
                <button type="button" aria-label="Rename agent" title="Rename" onClick={() => setRenaming(true)} className="flex size-7 shrink-0 items-center justify-center rounded text-fg-2 hover:bg-surface-3 hover:text-fg">
                  <Pencil className="size-4" aria-hidden />
                </button>
              )}
            </>
          )}
        </div>
        <div role="tablist" aria-label="Build or deploy" className="flex gap-0.5 rounded-lg bg-surface-3 p-0.5">
          {(
            [
              ['build', 'Build', Hammer],
              ['deploy', 'Deploy', Rocket],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cx('flex h-8 items-center gap-1.5 rounded-md px-5 text-[15px]', tab === id ? 'bg-surface text-accent-text shadow-card' : 'text-fg-2 hover:text-fg')}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-[1_1_280px] items-center justify-end gap-2">
          <p aria-live="polite" className="hidden items-center gap-1.5 text-body-sm whitespace-nowrap text-muted sm:flex">
            {saving ? (
              'Saving…'
            ) : dirty ? (
              <span className="flex items-center gap-1.5 text-warning-text">
                <span className="size-2 rounded-full bg-warning" aria-hidden />
                Unsaved changes
              </span>
            ) : (
              <>
                <Check className="size-3.5" aria-hidden />
                All changes saved
              </>
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="xl:hidden"
            icon={<MessageSquareText className="size-4" aria-hidden />}
            aria-pressed={testOpen}
            onClick={() => setTestOpen((o) => !o)}
          >
            Test
          </Button>
          <Popover
            label="More"
            className="w-56"
            trigger={({ open, toggle, id }) => (
              <button
                type="button"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onClick={toggle}
                className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-surface-3 hover:text-fg"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    void leave(`/bots/${botId}/advanced`);
                  }}
                >
                  All settings (full editor)
                </MenuItem>
                {isAdmin && (
                  <MenuItem
                    onClick={() => {
                      close();
                      setPreviewOpen(true);
                    }}
                  >
                    Prompt preview
                  </MenuItem>
                )}
                {isAdmin && (
                  <MenuItem
                    onClick={() => {
                      close();
                      void duplicate();
                    }}
                  >
                    Duplicate
                  </MenuItem>
                )}
                {isAdmin && (
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      void remove();
                    }}
                  >
                    Delete
                  </MenuItem>
                )}
              </>
            )}
          </Popover>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(structuredClone(base));
                setSaveError(null);
              }}
            >
              Discard
            </Button>
          )}
          <Button variant="primary" className="w-28" disabled={!dirty || !isAdmin} loading={saving} onClick={() => void save()} title={isAdmin ? undefined : 'Only admins can change agents'}>
            Save
          </Button>
        </div>
      </header>

      {saveError ? (
        <div className="px-4 pb-2">
          <ErrorBanner error={saveError} details={details.length ? details.map((d) => ({ ...d, message: errorText(d) })) : undefined} title="The agent wasn't saved." />
        </div>
      ) : null}

      {tab === 'deploy' ? (
        <DeployPanel botId={botId} botName={draft.name} isActive={bot.data?.isActive ?? false} canEdit={isAdmin} />
      ) : (
        <div className="grid flex-1 gap-3 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_360px_380px]">
          <div className="flex flex-col lg:min-h-0 lg:overflow-y-auto">
            <PromptPanel draft={draft} setDraft={setDraft} organizationName={ctx.organizationName} readOnly={!isAdmin} />
          </div>
          <div className="bg-surface lg:min-h-0 lg:overflow-y-auto lg:rounded-t-lg">
            {ctx.warnings.length > 0 && (
              <div role="note" className="m-3 space-y-1 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5">
                {ctx.warnings.map((w) => (
                  <p key={w.id} className="text-caption text-warning-text">
                    {w.message}
                  </p>
                ))}
              </div>
            )}
            <SettingsPanels
              draft={draft}
              setDraft={setDraft}
              ctx={ctx}
              botId={botId}
              readOnly={!isAdmin}
              open={panel}
              onToggle={(id) => setPanel((p) => (p === id ? null : id))}
              startAction={startAction}
              onStartActionDone={onStartActionDone}
              live={live}
              onDeploy={() => setTab('deploy')}
              onApplyTemplate={(t) => void applyTemplate(t)}
            />
            {!isAdmin && <p className="p-4 text-body-sm text-muted">You have read-only access. Ask an admin to change this agent.</p>}
          </div>
          {testOpen && <div className="fixed inset-0 z-30 bg-overlay xl:hidden" aria-hidden onClick={() => setTestOpen(false)} />}
          <aside
            aria-label="Test your agent"
            className={cx(
              'flex min-h-0 flex-col overflow-hidden bg-surface xl:static xl:z-auto xl:flex xl:rounded-tl-lg xl:shadow-none',
              testOpen ? 'fixed inset-y-0 right-0 z-40 w-[min(400px,100vw)] shadow-modal' : 'hidden',
            )}
          >
            <div className="flex shrink-0 items-center gap-2.5 bg-gradient-to-r from-[#6172f3] via-[#9e77ed] to-[#c77dff] px-4 py-3 text-white">
              <MessageSquareText className="size-4.5" aria-hidden />
              <h2 className="flex-1 text-[17px] font-medium">Test your agent</h2>
              <button type="button" aria-label="Close test panel" onClick={() => setTestOpen(false)} className="flex size-7 items-center justify-center rounded text-white/90 hover:bg-white/15 xl:hidden">
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <Playground botId={botId} dirty={dirty} title={testTitle} />
            </div>
          </aside>
        </div>
      )}
      <PromptPreviewDrawer botId={botId} open={previewOpen} onClose={() => setPreviewOpen(false)} dirty={dirty} />
    </div>
  );
}

/** Rename in place: Enter or leaving the field keeps it, Escape puts the old name back. */
function NameInput({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  // Enter or Escape decides; the blur that may follow as the field goes away mustn't decide again.
  const decided = useRef(false);
  const finish = (result: string | null) => {
    if (decided.current) return;
    decided.current = true;
    onDone(result);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <>
      <label htmlFor="agent-name" className="sr-only">
        Agent name
      </label>
      <input
        id="agent-name"
        ref={ref}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => finish(name.trim() ? name : null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(name.trim() ? name : null);
          if (e.key === 'Escape') {
            // Not the page's Escape (closing a panel): only the rename.
            e.stopPropagation();
            finish(null);
          }
        }}
        className="control h-9 w-[min(360px,60vw)] text-[17px] font-medium"
      />
    </>
  );
}
