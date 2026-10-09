import { useQueryClient } from '@tanstack/react-query';
import { Bot as BotIcon, ChevronLeft, ChevronRight, FolderPlus, LayoutGrid, List, MoreVertical, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm, useToast } from '../../components/feedback-context';
import { MenuItem, Modal, Popover } from '../../components/overlay';
import { Badge, Button, Card, cx, EmptyState, ErrorBanner, Select, SkeletonRows } from '../../components/ui';
import { del, post } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useBots, useChannels } from '../../lib/queries';
import { Link, navigate, useRoute, withQuery } from '../../lib/router';
import type { Bot } from '../../lib/types';
import { agentChannels, channelsSummary } from './shared';

const PAGE_SIZES = [10, 25, 50];

function StatusPill({ on }: { on: boolean }) {
  return (
    <span className={cx('inline-flex rounded-full px-2.5 py-0.5 text-body-sm', on ? 'bg-success-soft text-success-text' : 'bg-surface-2 text-fg-2')}>
      {on ? 'On' : 'Off'}
    </span>
  );
}

/** Conversation AI → Agents List: every agent, searchable, as a table or cards. */
export function AgentsList({ onCreate }: { onCreate: () => void }) {
  const route = useRoute();
  const bots = useBots();
  const channels = useChannels();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const query = route.query.get('q') ?? '';
  const layout = route.query.get('layout') === 'grid' ? 'grid' : 'list';
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folderOpen, setFolderOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const setParam = (changes: Record<string, string | null>) => navigate(withQuery(route, changes), { replace: true });
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (bots.data ?? []).filter((b) => !q || b.name.toLowerCase().includes(q) || b.config.persona.assistantName.toLowerCase().includes(q));
  }, [bots.data, query]);
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  // A search or a deletion can leave the page past the end.
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);
  const shown = matches.slice(page * pageSize, page * pageSize + pageSize);
  const allShownSelected = shown.length > 0 && shown.every((b) => selected.has(b.id));

  const duplicate = useAction((bot: Bot) => post<Bot>(`/v1/bots/${bot.id}/duplicate`), {
    invalidate: [['bots']],
    success: (copy) => `Duplicated as “${copy.name}” (Off)`,
  });
  const remove = useAction((bot: Bot) => del(`/v1/bots/${bot.id}`), { invalidate: [['bots'], ['channels']], success: 'Agent deleted' });
  const askDelete = async (bot: Bot) => {
    const ok = await confirm({
      title: `Delete “${bot.name}”?`,
      message: 'Channels using this agent stop replying until you pick another one. Past conversations are kept.',
      confirmLabel: 'Delete agent',
      danger: true,
    });
    if (ok) remove.mutate(bot);
  };
  const deleteSelected = async () => {
    const list = matches.filter((b) => selected.has(b.id));
    if (!list.length) return;
    const ok = await confirm({
      title: `Delete ${list.length} agent${list.length === 1 ? '' : 's'}?`,
      message: 'Channels using them stop replying until you pick another agent. Past conversations are kept.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    const failed: string[] = [];
    for (const bot of list) await del(`/v1/bots/${bot.id}`).catch(() => failed.push(bot.name));
    setDeleting(false);
    setSelected(new Set());
    await Promise.all([qc.invalidateQueries({ queryKey: ['bots'] }), qc.invalidateQueries({ queryKey: ['channels'] })]);
    if (failed.length) toast.error(`Couldn't delete ${failed.join(', ')}`);
    else toast.success(`${list.length} agent${list.length === 1 ? '' : 's'} deleted`);
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const actions = (bot: Bot) => (
    <Popover
      portal
      label={`Actions for ${bot.name}`}
      className="w-44"
      trigger={({ open, toggle: t, id }) => (
        <button
          type="button"
          aria-label={`More actions for ${bot.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={t}
          className="flex size-8 items-center justify-center rounded-lg text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          <MoreVertical className="size-4" aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            onClick={() => {
              close();
              navigate(`/bots/${bot.id}`);
            }}
          >
            Edit
          </MenuItem>
          {isAdmin && (
            <MenuItem
              disabled={duplicate.isPending}
              onClick={() => {
                close();
                duplicate.mutate(bot);
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
                void askDelete(bot);
              }}
            >
              Delete
            </MenuItem>
          )}
        </>
      )}
    </Popover>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {selected.size > 0 && isAdmin && (
          <Button variant="danger-ghost" icon={<Trash2 className="size-4" aria-hidden />} loading={deleting} onClick={() => void deleteSelected()} className="mr-auto">
            Delete {selected.size} selected
          </Button>
        )}
        <div role="group" aria-label="View" className="flex gap-0.5 rounded-lg border border-border-strong bg-surface-2 p-0.5">
          {(
            [
              ['list', 'List view', List],
              ['grid', 'Grid view', LayoutGrid],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={layout === id}
              onClick={() => setParam({ layout: id === 'list' ? null : id })}
              className={cx('flex size-8 items-center justify-center rounded-md text-fg-2', layout === id ? 'bg-surface text-fg shadow-card' : 'hover:text-fg')}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
        </div>
        <label className="flex h-9 w-80 max-w-full items-center gap-2 rounded-lg border border-border-strong bg-input-bg px-3 text-muted focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="sr-only">Search agents and folders</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setPage(0);
              setParam({ q: e.target.value || null });
            }}
            placeholder="Search agents and folders"
            className="min-w-0 flex-1 bg-transparent text-body text-fg placeholder:text-faint focus:outline-none"
          />
        </label>
        <Button icon={<FolderPlus className="size-4" aria-hidden />} onClick={() => setFolderOpen(true)}>
          Create folder
        </Button>
      </div>

      {bots.isLoading ? (
        <SkeletonRows rows={4} />
      ) : bots.error ? (
        <ErrorBanner error={bots.error} onRetry={() => void bots.refetch()} />
      ) : !bots.data?.length ? (
        <Card>
          <EmptyState
            icon={<BotIcon className="size-5" />}
            title="No agents yet"
            description="Create an agent, give it your business info and knowledge, then add it to your website."
            action={isAdmin && <Button variant="primary" onClick={onCreate}>Create Agent</Button>}
          />
        </Card>
      ) : !matches.length ? (
        <Card>
          <EmptyState icon={<Search className="size-5" />} title="No agents match" description={`Nothing is called “${query}”.`} action={<Button onClick={() => setParam({ q: null })}>Clear search</Button>} />
        </Card>
      ) : layout === 'list' ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[860px] border-collapse text-left text-body">
            <thead className="bg-surface-2/70 text-body-sm font-semibold text-fg">
              <tr>
                <th scope="col" className="w-12 border-r border-border px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all agents on this page"
                    checked={allShownSelected}
                    onChange={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        for (const b of shown) (allShownSelected ? next.delete(b.id) : next.add(b.id));
                        return next;
                      })
                    }
                    className="size-4 accent-accent"
                  />
                </th>
                <th scope="col" className="border-r border-border px-3 py-3">Agent Name</th>
                <th scope="col" className="border-r border-border px-3 py-3">Status</th>
                <th scope="col" className="border-r border-border px-3 py-3">Type</th>
                <th scope="col" className="border-r border-border px-3 py-3">
                  Assigned channels <span className="font-normal text-muted" title="Where the agent replies to customers">ⓘ</span>
                </th>
                <th scope="col" className="border-r border-border px-3 py-3">Last Updated</th>
                <th scope="col" className="w-16 px-3 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((bot) => (
                <tr key={bot.id} className="border-t border-border hover:bg-surface-2/50">
                  <td className="px-3 py-3.5">
                    <input type="checkbox" aria-label={`Select ${bot.name}`} checked={selected.has(bot.id)} onChange={() => toggle(bot.id)} className="size-4 accent-accent" />
                  </td>
                  <td className="px-3 py-3.5">
                    <Link to={`/bots/${bot.id}`} className="font-medium text-fg hover:text-accent-text hover:underline">
                      {bot.name}
                    </Link>
                  </td>
                  <td className="px-3 py-3.5">
                    <StatusPill on={bot.isActive} />
                  </td>
                  <td className="px-3 py-3.5 text-fg-2">Prompt based</td>
                  <td className="px-3 py-3.5 text-fg-2">{channels.isLoading ? '…' : channelsSummary(agentChannels(channels.data, bot.id))}</td>
                  <td className="px-3 py-3.5 whitespace-nowrap text-fg-2">{formatDateTime(bot.updatedAt)}</td>
                  <td className="px-3 py-3.5 text-center">{actions(bot)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((bot) => (
            <Card key={bot.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-start justify-between gap-2">
                <label className="flex min-w-0 items-center gap-2.5">
                  <input type="checkbox" aria-label={`Select ${bot.name}`} checked={selected.has(bot.id)} onChange={() => toggle(bot.id)} className="size-4 shrink-0 accent-accent" />
                  <Link to={`/bots/${bot.id}`} className="truncate font-semibold text-fg hover:text-accent-text hover:underline">
                    {bot.name}
                  </Link>
                </label>
                {actions(bot)}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill on={bot.isActive} />
                <Badge tone="slate">Prompt based</Badge>
              </div>
              <p className="text-body-sm text-fg-2">{channelsSummary(agentChannels(channels.data, bot.id))}</p>
              <p className="mt-auto text-caption text-muted">Updated {formatDateTime(bot.updatedAt)}</p>
            </Card>
          ))}
        </div>
      )}

      {matches.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 text-body-sm text-fg-2">
          <label className="flex items-center gap-2">
            Rows per page
            <Select
              className="h-8 w-20"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <span className="tabular-nums">
            {page * pageSize + 1} - {Math.min(matches.length, (page + 1) * pageSize)} of {matches.length}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)} icon={<ChevronLeft className="size-4" aria-hidden />} />
            <span aria-current="page" className="flex size-8 items-center justify-center rounded-lg border border-accent font-medium text-fg tabular-nums">
              {page + 1}
            </span>
            <Button size="sm" variant="ghost" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} icon={<ChevronRight className="size-4" aria-hidden />} />
          </div>
        </div>
      )}

      <FoldersComingSoon open={folderOpen} onClose={() => setFolderOpen(false)} />
    </div>
  );
}

/** Folders aren't part of the platform yet: the button says so instead of doing nothing. */
export function FoldersComingSoon({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Folders are coming soon"
      footer={
        <Button variant="primary" onClick={onClose}>
          Got it
        </Button>
      }
    >
      <p className="text-body text-fg-2">Grouping agents into folders isn't available yet. Your agents stay in one list, and search finds any of them by name.</p>
    </Modal>
  );
}
