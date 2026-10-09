import { ArrowUpDown, CheckCircle2, Circle, ExternalLink, Info, Plus, Search, ShieldCheck } from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useApprovals } from '../../components/approvals';
import { Button, Card, cx, EmptyState, ErrorBanner, Select, SkeletonRows, Spinner } from '../../components/ui';
import { formatDateTime, formatNumber, TOOL_LABELS } from '../../lib/format';
import { roleAtLeast, useBots, useChannels, useKnowledgeBases, useOrg } from '../../lib/queries';
import { Link, navigate, useRoute, withQuery } from '../../lib/router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { PERSONALITY_TEMPLATES } from '../bots/sections';
import { AgentsDashboard } from './AgentsDashboard';
import { AgentsList, FoldersComingSoon } from './AgentsList';
import { CreateAgentModal, useCreateAgent } from './CreateAgentModal';
import { AGENT_TABS, agentChannels, agentPreset, type AgentTab } from './shared';

const KnowledgePage = lazy(() => import('../knowledge/KnowledgePage').then((m) => ({ default: m.KnowledgePage })));
const ApprovalsPage = lazy(() => import('../approvals/ApprovalsPage').then((m) => ({ default: m.ApprovalsPage })));

/** AI Agents: GHL's tab strip over the page of the tab that's open. */
export function AiAgentsPage({ tab, kbId = null }: { tab: AgentTab; kbId?: string | null }) {
  const waiting = useApprovals({ status: 'pending' }).data?.length ?? 0;
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-surface px-4 sm:px-6">
        <div className="flex items-end gap-6 overflow-x-auto">
          <h1 className="shrink-0 pb-3 pl-1 text-[19px] leading-7 font-medium text-fg">AI Agents</h1>
          <nav aria-label="AI Agents" className="flex gap-1">
            {AGENT_TABS.map((t) => (
              <Link
                key={t.id}
                to={t.to}
                aria-current={t.id === tab ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-1.5 px-2 pt-3 pb-3 text-[15px] whitespace-nowrap transition-colors',
                  t.id === tab ? 'text-accent-text shadow-[inset_0_-2px_0_var(--accent)]' : 'text-fg-2 hover:text-fg',
                )}
              >
                {t.label}
                {t.id === 'logs' && waiting > 0 && (
                  <span className="rounded-full bg-warning-soft px-1.5 text-label font-semibold text-warning-text tabular-nums">
                    <span className="sr-only">, waiting for approval: </span>
                    {waiting}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <Suspense
        fallback={
          <div className="flex justify-center py-24">
            <Spinner />
          </div>
        }
      >
      <div className="flex-1">
        {tab === 'conversation-ai' && <ConversationAi />}
        {tab === 'agent-studio' && <AgentStudio />}
        {tab === 'getting-started' && <GettingStarted />}
        {tab === 'templates' && <Templates />}
        {tab === 'voice-ai' && <ComingSoon title="Voice AI" text="AI phone agents aren't available on your platform yet. Your Conversation AI agents keep working as they are." />}
        {tab === 'content-ai' && <ComingSoon title="Content AI" text="Writing content with AI isn't available on your platform yet." />}
        {tab === 'knowledge-base' && <KnowledgePage kbId={kbId} />}
        {tab === 'logs' && <AgentLogs />}
      </div>
      </Suspense>
    </div>
  );
}

function useCreateOpen() {
  const { role } = useAuth();
  const [open, setOpen] = useState(false);
  return { canCreate: roleAtLeast(role, 'admin'), open, setOpen };
}

function ConversationAi() {
  const route = useRoute();
  const view = route.query.get('view') === 'dashboard' ? 'dashboard' : 'agents';
  const create = useCreateOpen();
  return (
    <section className="space-y-5 px-4 py-7 sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-[28px] leading-9 font-medium tracking-[-0.01em] text-fg">Conversation AI Agents</h2>
          <p className="text-[16px] leading-6 text-fg-2">Create And Manage Multiple Agents For Your Business</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<ExternalLink className="size-4" aria-hidden />} onClick={() => navigate('/knowledge')}>
            Manage Knowledge Base
          </Button>
          {create.canCreate && (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => create.setOpen(true)}>
              Create Agent
            </Button>
          )}
        </div>
      </div>
      <div role="tablist" aria-label="Conversation AI" className="flex gap-9 border-b border-border">
        {(
          [
            ['dashboard', 'Dashboard'],
            ['agents', 'Agents List'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => navigate(withQuery(route, { view: id === 'agents' ? null : id, layout: null }), { replace: true })}
            className={cx('pb-2.5 text-[15px] font-medium transition-colors', view === id ? 'text-accent-text shadow-[inset_0_-2px_0_var(--accent)]' : 'text-fg hover:text-accent-text')}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{view === 'dashboard' ? <AgentsDashboard /> : <AgentsList onCreate={() => create.setOpen(true)} />}</div>
      <CreateAgentModal open={create.open} onClose={() => create.setOpen(false)} />
    </section>
  );
}

type StudioSort = 'updated' | 'created' | 'name';

/** Agent Studio: the agents as GHL's Managed Agents table, with sorting, search and paging. */
function AgentStudio() {
  const bots = useBots();
  const create = useCreateOpen();
  const [folderOpen, setFolderOpen] = useState(false);
  const [sort, setSort] = useState<StudioSort>('updated');
  const [q, setQ] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = (bots.data ?? []).filter((b) => !term || b.name.toLowerCase().includes(term));
    return [...rows].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [bots.data, q, sort]);
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const at = Math.min(page, pages - 1);
  const shown = list.slice(at * pageSize, at * pageSize + pageSize);
  return (
    <section className="space-y-4 px-4 py-7 sm:px-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[23px] leading-8 font-medium text-fg">Managed Agents</h2>
          <p className="mt-1 text-[15px] text-fg-2">Build and manage AI agents for your business</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setFolderOpen(true)}>New Folder</Button>
          {create.canCreate && (
            <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => create.setOpen(true)}>
              Create Managed Agent
            </Button>
          )}
        </div>
      </div>
      <p className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-body-sm text-fg">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden />
        <span>
          <b className="text-accent-text">Managed Agents</b> are prompt-based agents: give them a prompt, knowledge and actions, test them, then deploy them to your website chat.
        </span>
      </p>
      <div className="flex flex-wrap justify-between gap-3">
        <label className="flex items-center gap-2 text-body-sm text-fg-2">
          <ArrowUpDown className="size-4" aria-hidden />
          <span className="sr-only">Sort by</span>
          <Select className="h-8 w-48" value={sort} onChange={(e) => setSort(e.target.value as StudioSort)}>
            <option value="updated">Sort by: Last updated</option>
            <option value="created">Sort by: Created on</option>
            <option value="name">Sort by: Name</option>
          </Select>
        </label>
        <label className="flex h-8 w-56 items-center gap-2 rounded-lg border border-border-strong bg-input-bg px-2.5 text-muted">
          <Search className="size-3.5" aria-hidden />
          <span className="sr-only">Search managed agents</span>
          <input
            type="search"
            placeholder="Search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            className="min-w-0 flex-1 bg-transparent text-body-sm text-fg focus:outline-none"
          />
        </label>
      </div>
      {bots.error ? <ErrorBanner error={bots.error} onRetry={() => void bots.refetch()} /> : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[760px] border-collapse text-left text-body">
          <thead className="text-body-sm text-fg">
            <tr>
              <th scope="col" className="px-3 py-2.5 font-semibold">Name</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Last Updated</th>
              <th scope="col" className="px-3 py-2.5 font-medium">Created On</th>
              <th scope="col" className="px-3 py-2.5 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {bots.isLoading ? (
              <tr>
                <td colSpan={5} className="p-3">
                  <SkeletonRows rows={3} />
                </td>
              </tr>
            ) : shown.length ? (
              shown.map((b) => (
                <tr key={b.id} className="border-t border-border">
                  <td className="px-3 py-3">
                    <Link to={`/bots/${b.id}`} className="font-medium text-fg hover:text-accent-text hover:underline">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <span className={cx('rounded-full px-2.5 py-0.5 text-body-sm', b.isActive ? 'bg-success-soft text-success-text' : 'bg-surface-2 text-fg-2')}>{b.isActive ? 'On' : 'Off'}</span>
                  </td>
                  <td className="px-3 py-3 text-fg-2">{formatDateTime(b.updatedAt)}</td>
                  <td className="px-3 py-3 text-fg-2">{formatDateTime(b.createdAt)}</td>
                  <td className="px-3 py-3 text-right">
                    <Button size="xs" onClick={() => navigate(`/bots/${b.id}`)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="border-t border-border px-3 py-8 text-center">
                  <span className="mx-auto flex size-9 items-center justify-center rounded-full bg-accent-soft font-bold text-accent-text">i</span>
                  <p className="mt-2.5 text-[15px] font-medium text-fg">{q ? 'No Managed Agents match' : 'No Managed Agents yet'}</p>
                  <p className="text-body-sm text-fg-2">{q ? 'Try another name.' : 'Create your first Managed Agent to get started.'}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-caption text-fg-2">
        <span>
          {list.length} Managed Agent{list.length === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-2">
          Rows per page
          <Select
            aria-label="Rows per page"
            className="h-7 w-16"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(0);
            }}
          >
            {[10, 25, 50].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </Select>
          <span className="tabular-nums">
            {list.length ? at * pageSize + 1 : 0} - {Math.min(list.length, (at + 1) * pageSize)} of {list.length}
          </span>
          <Button size="xs" variant="secondary" disabled={at === 0} onClick={() => setPage(at - 1)}>
            Previous
          </Button>
          <span aria-current="page" className="rounded border border-accent px-2 py-0.5 text-fg tabular-nums">
            {at + 1}
          </span>
          <Button size="xs" variant="secondary" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
            Next
          </Button>
        </span>
      </div>
      <FoldersComingSoon open={folderOpen} onClose={() => setFolderOpen(false)} />
      <CreateAgentModal open={create.open} onClose={() => create.setOpen(false)} />
    </section>
  );
}

/** Four steps with what's already done ticked, from the organization's real agents, knowledge and channels. */
function GettingStarted() {
  const bots = useBots();
  const kbs = useKnowledgeBases();
  const channels = useChannels();
  const create = useCreateOpen();
  const list = bots.data ?? [];
  // The steps open the agent worked on last.
  const first = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const built = list.some((b) => b.config.instructions.trim() || b.knowledgeBaseIds.length);
  const deployed = list.some((b) => agentChannels(channels.data, b.id).some((c) => c.status === 'active' && c.channel === 'webchat') && b.isActive);
  // `done: null`: a step there's no record of (testing), shown without a tick either way.
  const steps: Array<{ title: string; text: string; done: boolean | null; action?: ReactNode }> = [
    {
      title: 'Create an agent',
      text: 'General Q&A, appointment booking, a template, or from scratch.',
      done: list.length > 0,
      action: create.canCreate && (
        <Button variant="primary" onClick={() => create.setOpen(true)}>
          Create Agent
        </Button>
      ),
    },
    {
      title: 'Build it',
      text: `Write the prompt, add knowledge${(kbs.data?.length ?? 0) ? '' : ' (add a knowledge base first)'}, set up actions and how it replies.`,
      done: Boolean(built),
      action: first && <Button onClick={() => navigate(`/bots/${first.id}`)}>Open {first.name}</Button>,
    },
    {
      title: 'Test it',
      text: 'Try it in the test panel beside the settings. Nothing there reaches your contacts.',
      done: null,
      action: first && <Button onClick={() => navigate(`/bots/${first.id}`)}>Test</Button>,
    },
    {
      title: 'Deploy it',
      text: 'Connect it to your website chat and switch it On.',
      done: deployed,
      action: first && <Button onClick={() => navigate(`/bots/${first.id}?tab=deploy`)}>Deploy</Button>,
    },
  ];
  return (
    <section className="max-w-3xl space-y-4 px-4 py-7 sm:px-8">
      <div>
        <h2 className="font-display text-[28px] leading-9 font-medium text-fg">Getting Started</h2>
        <p className="text-[16px] text-fg-2">Create an agent, build it, test it and deploy it to a channel.</p>
      </div>
      {bots.isLoading ? (
        <SkeletonRows rows={4} />
      ) : (
        <ol className="space-y-2.5">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4 shadow-card">
              {s.done ? (
                <CheckCircle2 className="size-6 shrink-0 text-success" aria-label="Done" />
              ) : (
                <Circle className="size-6 shrink-0 text-faint" aria-label={s.done === null ? 'Step' : 'Not done yet'} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-fg">
                  {i + 1}. {s.title}
                </span>
                <span className="block text-body-sm text-fg-2">{s.text}</span>
              </span>
              {s.action}
            </li>
          ))}
        </ol>
      )}
      <CreateAgentModal open={create.open} onClose={() => create.setOpen(false)} />
    </section>
  );
}

/** Agent Templates: start an agent with a template's personality and goal filled in. */
function Templates() {
  const kbs = useKnowledgeBases();
  const create = useCreateAgent();
  const { role } = useAuth();
  const canCreate = roleAtLeast(role, 'admin');
  return (
    <section className="space-y-5 px-4 py-7 sm:px-8">
      <div>
        <h2 className="font-display text-[28px] leading-9 font-medium text-fg">Agent Templates</h2>
        <p className="text-[16px] text-fg-2">Start an agent with its personality and goal filled in. You can change everything afterwards.</p>
      </div>
      {create.error ? <ErrorBanner error={create.error} title="We couldn't create the agent." /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PERSONALITY_TEMPLATES.map((t) => (
          <Card key={t.id} className="flex flex-col gap-2 p-5">
            <h3 className="text-[16px] font-semibold text-fg">{t.label}</h3>
            <p className="text-body-sm text-fg-2">{t.description}</p>
            <p className="flex-1 text-caption text-muted">Goal: {t.goal}</p>
            {canCreate && (
              <Button className="self-start" loading={create.isPending && create.variables?.name.startsWith(t.label)} onClick={() => create.mutate(agentPreset(t, (kbs.data ?? []).map((k) => k.id)))}>
                Use template
              </Button>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}

function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <EmptyState
      className="mt-20"
      icon={<Info className="size-5" />}
      title={`${title} is coming soon`}
      description={text}
      action={<Button onClick={() => navigate('/ai-agents/conversation-ai')}>Go to Conversation AI</Button>}
    />
  );
}

interface Performance {
  actions: Array<{ tool: string; calls: number; failed: number; askedTeam: number }>;
  approvals: { approved: number; declined: number; waiting: number; expired: number };
}

/** Agent Logs: the team's approvals, and what the agents did over the last 30 days. */
function AgentLogs() {
  const org = useOrg();
  const perf = useQuery({ queryKey: ['agents-logs-performance'], queryFn: () => get<Performance>('/v1/analytics/performance'), enabled: Boolean(org.data) });
  return (
    <div>
      <ApprovalsPage />
      <section aria-labelledby="ai-actions" className="space-y-3 px-4 pb-10 sm:px-8">
        <h2 id="ai-actions" className="flex items-center gap-2 text-heading font-semibold text-fg">
          <ShieldCheck className="size-4.5 text-accent-text" aria-hidden />
          What the agents did (last 30 days)
        </h2>
        {perf.isLoading ? (
          <SkeletonRows rows={3} />
        ) : perf.error ? (
          <ErrorBanner error={perf.error} onRetry={() => void perf.refetch()} />
        ) : !perf.data?.actions.length ? (
          <p className="text-body-sm text-muted">No actions yet. Saved details, bookings, API calls and handoffs show up here.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[520px] text-left text-body">
              <thead className="bg-surface-2/70 text-body-sm">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Action</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Done</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Failed or refused</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Asked the team</th>
                </tr>
              </thead>
              <tbody>
                {perf.data.actions.map((a) => (
                  <tr key={a.tool} className="border-t border-border">
                    <td className="px-4 py-2.5">{TOOL_LABELS[a.tool]?.label ?? a.tool}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(a.calls - a.failed - a.askedTeam)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(a.failed)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(a.askedTeam)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
