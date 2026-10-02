import { Bot as BotIcon, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/feedback-context';
import { Modal } from '../../components/overlay';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, IconButton, Input, PageHeader, SkeletonRows } from '../../components/ui';
import { del, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useAiConfig, useBots, useCalendars, useChannels } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import type { Bot } from '../../lib/types';
import { botWarnings } from './warnings';

export function BotsPage() {
  const bots = useBots();
  const aiConfig = useAiConfig().data;
  const channels = useChannels();
  const calendars = useCalendars();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const remove = useAction((id: string) => del(`/v1/bots/${id}`), { invalidate: [['bots'], ['channels']], success: 'Bot deleted' });

  return (
    <div>
      <PageHeader
        title="Bots"
        description="Your AI assistants. Each one has its own persona, knowledge and rules."
        actions={
          isAdmin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New bot
            </Button>
          )
        }
      />
      <div className="px-4 sm:px-8 py-6">
        {bots.isLoading ? (
          <SkeletonRows rows={4} />
        ) : bots.error ? (
          <ErrorBanner error={bots.error} onRetry={() => void bots.refetch()} />
        ) : !bots.data?.length ? (
          <Card>
            <EmptyState
              icon={<BotIcon className="size-5" />}
              title="No bots yet"
              description="Create an assistant, give it your business info and knowledge, then add it to your website."
              action={isAdmin && <Button variant="primary" onClick={() => setCreating(true)}>Create your first bot</Button>}
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {bots.data.map((bot) => {
              const usedBy = (channels.data ?? []).filter((c) => c.botId === bot.id && c.channel === 'webchat');
              const warnings = botWarnings(bot.config, calendars.data ?? []);
              return (
                <Card key={bot.id} className="flex flex-col p-5 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-raise">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/bots/${bot.id}`} className="group flex min-w-0 items-center gap-3">
                      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-ai-soft font-display text-[17px] font-bold text-ai-text ring-1 ring-ai/30">
                        {(bot.config.persona.assistantName.trim() || bot.name.trim() || '?').charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-display text-heading font-semibold tracking-[-0.01em] text-fg group-hover:text-accent-text">{bot.name}</p>
                        <p className="truncate text-caption text-muted">
                          {bot.config.persona.assistantName}
                          {bot.config.persona.companyName && ` · ${bot.config.persona.companyName}`}
                        </p>
                      </div>
                    </Link>
                    <Badge tone={bot.isActive ? 'green' : 'slate'} dot>
                      {bot.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <div className="mt-3 mb-4 flex flex-wrap gap-1.5">
                    <FeatureBadge on={bot.config.leadCapture.enabled} label="Lead capture" />
                    <FeatureBadge on={bot.config.qualification.enabled} label="Qualification" />
                    <FeatureBadge on={bot.config.booking.enabled} label="Booking" />
                    <FeatureBadge on={bot.config.handoff.enabled} label="Handoff" />
                    <FeatureBadge on={bot.knowledgeBaseIds.length > 0} label={`${bot.knowledgeBaseIds.length} knowledge base${bot.knowledgeBaseIds.length === 1 ? '' : 's'}`} />
                    {warnings.length > 0 && (
                      <span title={warnings.map((w) => w.message).join('\n\n')}>
                        <Badge tone="amber">{warnings.length} to check</Badge>
                      </span>
                    )}
                  </div>
                  <div className="mt-auto flex items-end justify-between gap-2 border-t border-border pt-3.5 text-caption text-muted">
                    <span className="min-w-0">
                      <span className="block">
                        {bot.model ?? aiConfig?.model ?? 'server default'}
                        {bot.model ? ' (override)' : ''}
                        {bot.effort ? ` · ${bot.effort} effort` : ''} · v{bot.version}
                      </span>
                      <span className="block">
                        Updated {timeAgo(bot.updatedAt)}
                        {usedBy.length > 0 && ` · on ${usedBy.map((c) => c.name).join(', ')}`}
                      </span>
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="xs" onClick={() => navigate(`/bots/${bot.id}`)}>
                        Configure
                      </Button>
                      {isAdmin && (
                        <IconButton
                          label={`Delete ${bot.name}`}
                          size="sm"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete “${bot.name}”?`,
                              message: 'Channels using this bot stop replying until you pick another bot. Past conversations are kept.',
                              confirmLabel: 'Delete bot',
                              danger: true,
                            });
                            if (ok) remove.mutate(bot.id);
                          }}
                        >
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      <CreateBotModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function FeatureBadge({ on, label }: { on: boolean; label: string }) {
  return <Badge tone={on ? 'indigo' : 'slate'} className={on ? '' : 'opacity-60 line-through decoration-1'}>{label}</Badge>;
}

function CreateBotModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const create = useAction((body: { name: string }) => post<Bot>('/v1/bots', body), {
    invalidate: [['bots']],
    success: 'Bot created',
    onSuccess: (bot) => {
      onClose();
      setName('');
      navigate(`/bots/${bot.id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim() });
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New bot"
      description="Starts with sensible defaults — you can tailor everything next."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-bot" loading={create.isPending} disabled={!name.trim()}>
            Create bot
          </Button>
        </>
      }
    >
      <form id="create-bot" onSubmit={submit}>
        <Field label="Name" hint="Internal name, e.g. “Website assistant” or “After-hours bot”.">
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
