import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Handshake, Plus, Search, Settings2, Trash2, Trophy, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/feedback-context';
import { PersonAvatar } from '../../components/avatar';
import { Drawer, Modal } from '../../components/overlay';
import { Badge, Button, Checkbox, EmptyState, ErrorBanner, Field, IconButton, Input, NumberInput, PageHeader, Select, SkeletonRows, Spinner, Textarea } from '../../components/ui';
import { del, fieldErrors, get, patch, post } from '../../lib/api';
import { formatDate, formatMoney, timeAgo } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useMembers, useOrg, usePipelines } from '../../lib/queries';
import { Link } from '../../lib/router';
import type { Contact, ContactList, Deal, DealStageSummary, DealStatus, Pipeline } from '../../lib/types';

const PAGE = 50;
const STATUS_LABEL: Record<DealStatus, string> = { open: 'Open', won: 'Won', lost: 'Lost' };

export { usePipelines };

/** "$3,500" or "$3,500 + €200" for a stage's deals in more than one currency. */
function totalsLine(totals: DealStageSummary['totals']): string {
  return totals.map((t) => formatMoney(t.value, t.currency)).join(' + ');
}

export function DealsPage() {
  const { role } = useAuth();
  const canEdit = roleAtLeast(role, 'agent');
  const isAdmin = roleAtLeast(role, 'admin');
  const pipelines = usePipelines();
  const members = useMembers();
  const [pipelineId, setPipelineId] = useState('');
  const [status, setStatus] = useState<DealStatus>('open');
  const [ownerUserId, setOwnerUserId] = useState('');
  // Deals from Test chats (playground contacts) are left out unless asked for, as on Leads and Conversations.
  const [includeTest, setIncludeTest] = useState(false);
  const [editing, setEditing] = useState<Deal | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<Pipeline | 'new' | null>(null);

  useEffect(() => {
    const list = pipelines.data ?? [];
    if (list.length && !list.some((p) => p.id === pipelineId)) setPipelineId(list[0]!.id);
  }, [pipelines.data, pipelineId]);
  const pipeline = pipelines.data?.find((p) => p.id === pipelineId) ?? null;

  const summary = useQuery({
    queryKey: ['deal-summary', { pipelineId, status, ownerUserId, includeTest }],
    queryFn: () => get<DealStageSummary[]>('/v1/deals/summary', { pipelineId, status, ownerUserId: ownerUserId || undefined, includeTest }),
    enabled: Boolean(pipelineId),
  });
  const memberName = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m.name || m.email])), [members.data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Deals"
        description="Opportunities by stage. Open a deal to move it, change it, or mark it won or lost."
        actions={
          <>
            {isAdmin && pipeline && (
              <Button icon={<Settings2 className="size-4" />} onClick={() => setEditingPipeline(pipeline)}>
                Edit pipeline
              </Button>
            )}
            {canEdit && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!pipeline}>
                New deal
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-8 pb-4">
          {(pipelines.data?.length ?? 0) > 1 && (
            <Select aria-label="Pipeline" className="w-48" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
              {pipelines.data!.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label="Status" className="w-32" value={status} onChange={(e) => setStatus(e.target.value as DealStatus)}>
            {(Object.keys(STATUS_LABEL) as DealStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select aria-label="Owner" className="w-48" value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
            <option value="">Any owner</option>
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
          </Select>
          <Checkbox label="Include tests" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} className="shrink-0" />
          {isAdmin && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setEditingPipeline('new')}>
              New pipeline
            </Button>
          )}
        </div>
      </PageHeader>

      {pipelines.isLoading ? (
        <SkeletonRows rows={6} />
      ) : pipelines.error ? (
        <ErrorBanner error={pipelines.error} className="m-6" onRetry={() => void pipelines.refetch()} />
      ) : pipeline ? (
        <div className="flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto px-4 py-6 sm:px-8" aria-label={`${pipeline.name} pipeline`}>
          {pipeline.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              pipelineId={pipeline.id}
              stage={stage}
              status={status}
              ownerUserId={ownerUserId}
              includeTest={includeTest}
              summary={summary.data?.find((s) => s.stageId === stage.id)}
              memberName={memberName}
              onOpen={setEditing}
            />
          ))}
        </div>
      ) : null}

      {(creating || editing) && pipelines.data && (
        <DealDrawer
          deal={editing}
          pipelines={pipelines.data}
          defaultPipelineId={pipelineId}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      {editingPipeline && <PipelineEditor pipeline={editingPipeline === 'new' ? null : editingPipeline} onClose={() => setEditingPipeline(null)} onCreated={setPipelineId} />}
    </div>
  );
}

function StageColumn({
  pipelineId,
  stage,
  status,
  ownerUserId,
  includeTest,
  summary,
  memberName,
  onOpen,
}: {
  pipelineId: string;
  stage: Pipeline['stages'][number];
  status: DealStatus;
  ownerUserId: string;
  includeTest: boolean;
  summary: DealStageSummary | undefined;
  memberName: Map<string, string>;
  onOpen: (deal: Deal) => void;
}) {
  const deals = useInfiniteQuery({
    queryKey: ['deals', { pipelineId, stageId: stage.id, status, ownerUserId, includeTest }],
    queryFn: ({ pageParam }) => get<Deal[]>('/v1/deals', { pipelineId, stageId: stage.id, status, ownerUserId: ownerUserId || undefined, includeTest, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });
  const items = deals.data?.pages.flat() ?? [];
  return (
    <section className="flex w-72 shrink-0 snap-start scroll-ml-4 flex-col rounded-xl border border-border bg-surface-2/70" aria-label={`Stage ${stage.name}`}>
      <header className="px-3.5 pt-3 pb-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-body-sm font-semibold text-fg">{stage.name}</h2>
          <span className="rounded-full bg-surface px-2 text-label font-semibold text-fg-2 tabular-nums shadow-card">{summary?.count ?? '…'}</span>
        </div>
        <p className="mt-0.5 h-4 text-caption font-medium text-muted tabular-nums">{summary?.totals.length ? totalsLine(summary.totals) : ''}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {deals.isLoading ? (
          <SkeletonRows rows={2} className="p-0" />
        ) : deals.error ? (
          <ErrorBanner error={deals.error} />
        ) : items.length === 0 ? (
          <p className="mx-1 rounded-lg border border-dashed border-border-strong px-1 py-5 text-center text-caption text-muted">No deals</p>
        ) : (
          items.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onOpen(d)}
              className="block w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-left shadow-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-raise"
            >
              <p className="truncate text-body-sm font-semibold text-fg">{d.title}</p>
              <p className="mt-1 flex items-center gap-1.5 truncate text-caption text-muted">
                <PersonAvatar name={d.contact?.name || d.contact?.email} size="sm" />
                <span className="truncate">{d.contact?.name || d.contact?.email || 'Unnamed contact'}</span>
              </p>
              <div className="mt-2 flex items-center justify-between gap-2 text-caption">
                <span className="font-semibold text-fg tabular-nums">{d.value !== null ? formatMoney(d.value, d.currency) : '—'}</span>
                <span className="truncate text-muted">
                  {d.ownerUserId ? memberName.get(d.ownerUserId) ?? 'Owner' : 'No owner'} · {timeAgo(d.stageChangedAt)}
                </span>
              </div>
            </button>
          ))
        )}
        {deals.hasNextPage && (
          <Button size="xs" variant="ghost" className="w-full" loading={deals.isFetchingNextPage} onClick={() => void deals.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    </section>
  );
}

/** Pick a contact by name, email or phone. */
function ContactPicker({ value, onChange }: { value: Pick<Contact, 'id' | 'name' | 'email' | 'phone'> | null; onChange: (c: Pick<Contact, 'id' | 'name' | 'email' | 'phone'> | null) => void }) {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 250);
  const results = useQuery({
    queryKey: ['contacts', { search: debounced, picker: true }],
    queryFn: () => get<ContactList>('/v1/contacts', { search: debounced, limit: 8 }),
    enabled: debounced.length >= 2 && !value,
  });
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
        <span className="min-w-0 truncate text-body-sm text-fg">
          <span className="font-medium">{value.name || 'Unnamed'}</span>
          <span className="text-muted"> · {[value.email, value.phone].filter(Boolean).join(' · ') || 'no contact details'}</span>
        </span>
        <Button size="xs" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a contact (at least 2 characters)" />
      </div>
      {debounced.length >= 2 && (
        <div className="mt-2 rounded-lg border border-border">
          {results.isLoading ? (
            <div className="p-3">
              <Spinner />
            </div>
          ) : !results.data?.items.length ? (
            <p className="p-3 text-body-sm text-muted">No contacts match “{debounced}”.</p>
          ) : (
            <ul role="listbox" aria-label="Matching contacts" className="max-h-48 overflow-y-auto">
              {results.data.items.map((c) => (
                <li key={c.id}>
                  <button type="button" role="option" aria-selected={false} className="w-full px-3 py-2 text-left text-body-sm hover:bg-surface-2" onClick={() => onChange(c)}>
                    <span className="font-medium text-fg">{c.name || 'Unnamed'}</span>
                    <span className="text-muted"> · {[c.email, c.phone].filter(Boolean).join(' · ') || 'no details'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Create a deal (optionally for a known contact, from a conversation) or edit one: stage, value, owner, close date,
 * won or lost, delete.
 */
export function DealDrawer({
  deal,
  pipelines,
  defaultPipelineId,
  preset,
  onClose,
}: {
  deal: Deal | null;
  pipelines: Pipeline[];
  defaultPipelineId?: string;
  /** New deals: a known contact, the conversation it came from, a suggested title and what the customer wants. */
  preset?: { contact?: Pick<Contact, 'id' | 'name' | 'email' | 'phone'>; conversationId?: string; title?: string; wants?: string };
  onClose: () => void;
}) {
  const { role } = useAuth();
  const canEdit = roleAtLeast(role, 'agent');
  const confirm = useConfirm();
  const org = useOrg();
  const members = useMembers();
  const currency = deal?.currency ?? org.data?.settings.currency ?? 'USD';
  const [title, setTitle] = useState(deal?.title ?? preset?.title ?? '');
  const [contact, setContact] = useState<Pick<Contact, 'id' | 'name' | 'email' | 'phone'> | null>(
    deal?.contact ? { id: deal.contact.id, name: deal.contact.name, email: deal.contact.email, phone: deal.contact.phone } : (preset?.contact ?? null),
  );
  const [pipelineId, setPipelineId] = useState(deal?.pipelineId ?? defaultPipelineId ?? pipelines[0]?.id ?? '');
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  const [stageId, setStageId] = useState(deal?.stageId ?? pipeline?.stages[0]?.id ?? '');
  const [value, setValue] = useState<number | null>(deal?.value ?? null);
  const [ownerUserId, setOwnerUserId] = useState(deal?.ownerUserId ?? '');
  const [expectedCloseOn, setExpectedCloseOn] = useState(deal?.expectedCloseOn ?? '');
  const [losing, setLosing] = useState(false);
  const [lostReason, setLostReason] = useState('');
  const invalidate = [['deals'], ['deal-summary'], ['contact-deals'], ['contact-events']];

  const save = useAction(
    () => {
      const body = { title: title.trim(), pipelineId, stageId, value, ownerUserId: ownerUserId || null, expectedCloseOn: expectedCloseOn || null };
      return deal
        ? patch<Deal>(`/v1/deals/${deal.id}`, body)
        : post<Deal>('/v1/deals', { ...body, contactId: contact!.id, conversationId: preset?.conversationId ?? null });
    },
    { invalidate, success: deal ? 'Deal saved' : 'Deal created', onSuccess: onClose },
  );
  const setStatus = useAction((s: { status: DealStatus; lostReason?: string }) => patch<Deal>(`/v1/deals/${deal!.id}`, s), {
    invalidate,
    success: (d) => (d.status === 'won' ? 'Marked won' : d.status === 'lost' ? 'Marked lost' : 'Deal reopened'),
    onSuccess: onClose,
  });
  const remove = useAction(() => del(`/v1/deals/${deal!.id}`), { invalidate, success: 'Deal deleted', onSuccess: onClose });

  const server = fieldErrors(save.error);
  const valueError = value !== null && value < 0 ? 'Value cannot be negative' : (server.value ?? null);
  const ready = title.trim() && contact && pipelineId && stageId && !(value !== null && value < 0);
  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-lg"
      title={deal ? deal.title : 'New deal'}
      description={
        deal ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={deal.status === 'won' ? 'green' : deal.status === 'lost' ? 'red' : 'blue'}>{STATUS_LABEL[deal.status]}</Badge>
            <span>
              Created {formatDate(deal.createdAt)}
              {deal.createdBy === 'api' ? ' by an integration' : ''}
              {deal.closedAt ? ` · ${deal.status === 'won' ? 'won' : 'lost'} ${formatDate(deal.closedAt)}` : ''}
            </span>
          </span>
        ) : undefined
      }
      footer={
        canEdit ? (
          <>
            {deal && (
              <Button
                variant="danger-ghost"
                className="mr-auto"
                icon={<Trash2 className="size-4" />}
                loading={remove.isPending}
                onClick={async () => {
                  if (await confirm({ title: `Delete “${deal.title}”?`, message: 'The deal and its place in the pipeline are removed. Its activity stays on the contact.', confirmLabel: 'Delete deal', danger: true }))
                    remove.mutate();
                }}
              >
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>
              {deal ? 'Save' : 'Create deal'}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {deal?.status === 'lost' && deal.lostReason && <p className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-body-sm text-danger-text">Lost: {deal.lostReason}</p>}
        <Field label="Title" required error={server.title} hint={!deal && preset?.wants ? `They want: ${preset.wants}` : undefined}>
          <Input value={title} maxLength={200} disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Invisalign for Ana" />
        </Field>
        <Field label="Contact" required>
          {deal ? (
            <Link to={`/contacts/${deal.contactId}`} className="inline-flex items-center gap-1 text-body-sm text-accent-text hover:underline">
              {deal.contact?.name || deal.contact?.email || 'Open contact'} <ExternalLink className="size-3" />
            </Link>
          ) : preset?.contact ? (
            <p className="text-body-sm text-fg">{preset.contact.name || preset.contact.email || 'This conversation’s contact'}</p>
          ) : (
            <ContactPicker value={contact} onChange={setContact} />
          )}
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pipeline">
            <Select
              value={pipelineId}
              disabled={!canEdit}
              onChange={(e) => {
                const next = pipelines.find((p) => p.id === e.target.value);
                setPipelineId(e.target.value);
                setStageId(next?.stages[0]?.id ?? '');
              }}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Stage">
            <Select value={stageId} disabled={!canEdit} onChange={(e) => setStageId(e.target.value)}>
              {(pipeline?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Value (${currency})`} error={valueError}>
            <NumberInput value={value} allowEmpty min={0} step="any" disabled={!canEdit} onChange={setValue} />
          </Field>
          <Field label="Expected close" error={server.expectedCloseOn}>
            <Input type="date" value={expectedCloseOn} disabled={!canEdit} onChange={(e) => setExpectedCloseOn(e.target.value)} />
          </Field>
        </div>
        <Field label="Owner">
          <Select value={ownerUserId} disabled={!canEdit} onChange={(e) => setOwnerUserId(e.target.value)}>
            <option value="">No owner</option>
            {(members.data ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
          </Select>
        </Field>
        {deal?.conversationId && (
          <Link to={`/conversations/${deal.conversationId}`} className="inline-flex items-center gap-1 text-body-sm text-accent-text hover:underline">
            The conversation it came from <ExternalLink className="size-3" />
          </Link>
        )}

        {deal && canEdit && (
          <div className="space-y-3 border-t border-border pt-4">
            {deal.status === 'open' ? (
              losing ? (
                <div className="space-y-2">
                  <Field label="Why was it lost?" hint="Optional. Shown on the deal and sent to integrations.">
                    <Textarea rows={2} maxLength={500} value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
                  </Field>
                  <div className="flex gap-2">
                    <Button variant="danger" loading={setStatus.isPending} onClick={() => setStatus.mutate({ status: 'lost', lostReason: lostReason.trim() || undefined })}>
                      Mark lost
                    </Button>
                    <Button variant="ghost" onClick={() => setLosing(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button icon={<Trophy className="size-4 text-success" />} loading={setStatus.isPending} onClick={() => setStatus.mutate({ status: 'won' })}>
                    Mark won
                  </Button>
                  <Button variant="ghost" icon={<X className="size-4" />} onClick={() => setLosing(true)}>
                    Mark lost
                  </Button>
                </div>
              )
            ) : (
              <Button loading={setStatus.isPending} onClick={() => setStatus.mutate({ status: 'open' })}>
                Reopen
              </Button>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}

/** Rename a pipeline and its stages, reorder, add or remove stages (a stage with deals says where they go). */
function PipelineEditor({ pipeline, onClose, onCreated }: { pipeline: Pipeline | null; onClose: () => void; onCreated: (id: string) => void }) {
  const confirm = useConfirm();
  const pipelines = usePipelines();
  const [name, setName] = useState(pipeline?.name ?? '');
  const [stages, setStages] = useState<Array<{ id?: string; name: string; key: string }>>(
    pipeline ? pipeline.stages.map((s) => ({ id: s.id, name: s.name, key: s.id })) : [{ name: 'New', key: 'new-0' }, { name: 'Qualified', key: 'new-1' }],
  );
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  // Deals of every status count: a stage that goes must say where all of them go.
  const counts = useQuery({
    queryKey: ['deal-summary', { pipelineId: pipeline?.id, all: true, includeTest: true }],
    queryFn: () => get<DealStageSummary[]>('/v1/deals/summary', { pipelineId: pipeline!.id, includeTest: true }),
    enabled: Boolean(pipeline),
  });
  const countOf = (id: string) => counts.data?.find((c) => c.stageId === id)?.count ?? 0;
  const removed = (pipeline?.stages ?? []).filter((s) => !stages.some((k) => k.id === s.id));
  const kept = stages.filter((s) => s.id);
  const missingTarget = removed.some((s) => countOf(s.id) > 0 && !moveTo[s.id]);
  const invalidate = [['pipelines'], ['deals'], ['deal-summary']];

  const save = useAction(
    () =>
      pipeline
        ? patch<Pipeline>(`/v1/pipelines/${pipeline.id}`, {
            name: name.trim(),
            stages: stages.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim() })),
            moveDealsTo: Object.fromEntries(removed.filter((s) => countOf(s.id) > 0).map((s) => [s.id, moveTo[s.id]!])),
          })
        : post<Pipeline>('/v1/pipelines', { name: name.trim(), stages: stages.map((s) => ({ name: s.name.trim() })) }),
    {
      invalidate,
      success: pipeline ? 'Pipeline saved' : 'Pipeline created',
      onSuccess: (p) => {
        if (!pipeline) onCreated(p.id);
        onClose();
      },
    },
  );
  const remove = useAction(() => del(`/v1/pipelines/${pipeline!.id}`), { invalidate, success: 'Pipeline deleted', onSuccess: onClose });
  const move = (i: number, by: number) =>
    setStages((list) => {
      const next = [...list];
      const [item] = next.splice(i, 1);
      next.splice(i + by, 0, item!);
      return next;
    });

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={pipeline ? `Edit “${pipeline.name}”` : 'New pipeline'}
      description="Stages are the steps an open deal goes through. Won and lost aren't stages: mark a deal won or lost from the deal itself."
      footer={
        <>
          {pipeline && (pipelines.data?.length ?? 0) > 1 && (
            <Button
              variant="danger-ghost"
              className="mr-auto"
              loading={remove.isPending}
              onClick={async () => {
                if (await confirm({ title: `Delete “${pipeline.name}”?`, message: 'Only a pipeline without deals can be deleted.', confirmLabel: 'Delete pipeline', danger: true })) remove.mutate();
              }}
            >
              Delete pipeline
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !stages.length || stages.some((s) => !s.name.trim()) || missingTarget} loading={save.isPending} onClick={() => save.mutate()}>
            {pipeline ? 'Save' : 'Create pipeline'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-body-sm font-medium text-fg-2">Stages, in order</legend>
          {stages.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <Input
                aria-label={`Stage ${i + 1}`}
                value={s.name}
                maxLength={60}
                onChange={(e) => setStages((list) => list.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)))}
              />
              {s.id && countOf(s.id) > 0 && <Badge tone="slate">{countOf(s.id)}</Badge>}
              <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="size-4" />
              </IconButton>
              <IconButton label="Move down" size="sm" disabled={i === stages.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown className="size-4" />
              </IconButton>
              <IconButton label="Remove stage" size="sm" disabled={stages.length === 1} onClick={() => setStages((list) => list.filter((x) => x.key !== s.key))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setStages((list) => [...list, { name: '', key: `new-${Date.now()}` }])} disabled={stages.length >= 20}>
            Add stage
          </Button>
        </fieldset>
        {removed.filter((s) => countOf(s.id) > 0).map((s) => (
          <Field key={s.id} label={`Move the ${countOf(s.id)} deal${countOf(s.id) === 1 ? '' : 's'} in “${s.name}” to`} required>
            <Select value={moveTo[s.id] ?? ''} onChange={(e) => setMoveTo((m) => ({ ...m, [s.id]: e.target.value }))}>
              <option value="">Choose a stage</option>
              {kept.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </Select>
          </Field>
        ))}
      </div>
    </Modal>
  );
}

/** A contact's deals (the contact page's Deals tab), with "New deal" for this contact. */
export function ContactDeals({ contact, canEdit }: { contact: Pick<Contact, 'id' | 'name' | 'email' | 'phone'>; canEdit: boolean }) {
  const pipelines = usePipelines();
  const deals = useQuery({ queryKey: ['contact-deals', contact.id], queryFn: () => get<Deal[]>(`/v1/contacts/${contact.id}/deals`) });
  const [open, setOpen] = useState<Deal | 'new' | null>(null);
  const stageName = (d: Deal) => pipelines.data?.find((p) => p.id === d.pipelineId)?.stages.find((s) => s.id === d.stageId)?.name ?? '';
  // One open deal per pipeline: a new one starts in a pipeline where this contact has none.
  const withOpenDeal = new Set((deals.data ?? []).filter((d) => d.status === 'open').map((d) => d.pipelineId));
  const freePipeline = pipelines.data?.find((p) => !withOpenDeal.has(p.id));
  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {pipelines.data && deals.data && !freePipeline && <span className="text-caption text-muted">Already has an open deal. Open it below, or close it to start another.</span>}
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setOpen('new')} disabled={!pipelines.data || !deals.data || !freePipeline}>
            New deal
          </Button>
        </div>
      )}
      {deals.isLoading ? (
        <SkeletonRows rows={2} className="p-0" />
      ) : deals.error ? (
        <ErrorBanner error={deals.error} />
      ) : !deals.data?.length ? (
        <EmptyState icon={<Handshake className="size-5" />} title="No deals" description="Track what this contact might buy: its value, stage and owner." />
      ) : (
        <ul className="divide-y divide-border">
          {deals.data.map((d) => (
            <li key={d.id}>
              <button type="button" className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-surface-2/60" onClick={() => setOpen(d)}>
                <span className="min-w-0">
                  <span className="block truncate text-body-sm font-medium text-fg">{d.title}</span>
                  <span className="block text-caption text-muted">
                    {stageName(d)}
                    {d.value !== null ? ` · ${formatMoney(d.value, d.currency)}` : ''}
                  </span>
                </span>
                <Badge tone={d.status === 'won' ? 'green' : d.status === 'lost' ? 'red' : 'blue'}>{STATUS_LABEL[d.status]}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && pipelines.data && (
        <DealDrawer deal={open === 'new' ? null : open} pipelines={pipelines.data} defaultPipelineId={freePipeline?.id} preset={{ contact }} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
