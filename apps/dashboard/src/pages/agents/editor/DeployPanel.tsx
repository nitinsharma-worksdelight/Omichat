import { useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle, MessagesSquare, Phone, Plus, Send } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useConfirm, useToast } from '../../../components/feedback-context';
import { Modal } from '../../../components/overlay';
import { Badge, Button, CodeBlock, CopyButton, cx, EmptyState, ErrorBanner, Field, Input, Spinner } from '../../../components/ui';
import { patch, post } from '../../../lib/api';
import { useBots, useChannels } from '../../../lib/queries';
import { Link } from '../../../lib/router';
import type { Channel } from '../../../lib/types';

/** GHL's channel cards. Only the website chat exists on this platform; the rest say so. */
const CARDS: Array<{ id: string; name: string; text: string; icon: ReactNode; tone: string }> = [
  { id: 'sms', name: 'SMS', text: 'Connect your agent to SMS and let your agent respond to messages from your customers.', icon: <Phone className="size-3.5" />, tone: 'bg-[#12b76a]' },
  { id: 'whatsapp', name: 'WhatsApp', text: 'Connect your agent to WhatsApp and let your agent respond to messages from your customers.', icon: <MessageCircle className="size-3.5" />, tone: 'bg-[#25d366]' },
  { id: 'instagram', name: 'Instagram', text: 'Connect your agent to Instagram and let your agent respond to messages from your customers.', icon: <span className="text-[11px] font-bold">IG</span>, tone: 'bg-[#e1306c]' },
  { id: 'facebook', name: 'Facebook', text: 'Connect your agent to Facebook and let your agent respond to messages from your customers.', icon: <span className="text-[12px] font-bold">f</span>, tone: 'bg-[#1877f2]' },
  { id: 'tiktok', name: 'TikTok', text: 'Connect your agent to your TikTok account(s) and let it respond to direct messages from your customers.', icon: <span className="text-[11px] font-bold">T</span>, tone: 'bg-[#101828]' },
  { id: 'live', name: 'Live chat', text: 'Connect your agent to live chat and let your agent respond to messages from your customers.', icon: <MessagesSquare className="size-3.5" />, tone: 'bg-[#344054]' },
  { id: 'widget', name: 'Chat widget', text: 'Connect your agent to chat widget and let your agent respond to messages from your customers.', icon: <Send className="size-3.5" />, tone: 'bg-accent' },
  { id: 'email', name: 'Email', text: 'Connect your agent to Email and let your agent respond to messages from your customers.', icon: <Mail className="size-3.5" />, tone: 'bg-[#344054]' },
];

/** Deploy: where the agent replies. The website chat connects here; changes apply at once (not on Save). */
export function DeployPanel({ botId, botName, isActive, canEdit }: { botId: string; botName: string; isActive: boolean; canEdit: boolean }) {
  const channels = useChannels();
  const [widgetOpen, setWidgetOpen] = useState(false);
  const webchats = (channels.data ?? []).filter((c) => c.channel === 'webchat');
  const connected = webchats.filter((c) => c.botId === botId);
  const live = connected.some((c) => c.status === 'active');
  return (
    <div className="flex-1 bg-surface px-4 py-7 sm:px-6">
      {!isActive && live && (
        <p className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-4 py-2.5 text-body-sm text-warning-text">
          {botName} is connected but its Mode is Off, so it doesn't reply yet. Switch it to Auto-Pilot on the Build tab and save.
        </p>
      )}
      {channels.error ? <ErrorBanner className="mb-4" error={channels.error} onRetry={() => void channels.refetch()} /> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CARDS.map((card) => {
          const widget = card.id === 'widget';
          return (
            <div key={card.id} className="flex min-h-56 flex-col overflow-hidden rounded border border-border-strong">
              <div className="flex items-center gap-2.5 bg-surface-2 px-4 py-2.5">
                <span className={cx('flex size-5 items-center justify-center rounded text-white', card.tone)} aria-hidden>
                  {card.icon}
                </span>
                <span className="font-medium text-fg">{card.name}</span>
                {widget ? (
                  channels.isLoading ? (
                    <Spinner className="ml-auto size-4" />
                  ) : live ? (
                    <Badge tone="green" className="ml-auto">
                      Connected
                    </Badge>
                  ) : null
                ) : (
                  <Badge tone="slate" className="ml-auto">
                    Coming soon
                  </Badge>
                )}
              </div>
              <p className="flex-1 px-4 pt-10 text-[16px] leading-6 text-fg-2">{card.text}</p>
              {widget && connected.length > 0 && <p className="px-4 pt-2 text-caption text-muted">On: {connected.map((c) => c.name + (c.status === 'active' ? '' : ' (disabled)')).join(', ')}</p>}
              <div className="flex justify-end p-4">
                <Button variant={widget ? 'secondary' : 'ghost'} className={widget ? 'border-accent text-accent-text' : undefined} disabled={!widget} onClick={() => setWidgetOpen(true)}>
                  Configure
                </Button>
              </div>
            </div>
          );
        })}
        <div aria-disabled="true" className="flex min-h-56 flex-col items-center justify-center gap-1.5 rounded border border-dashed border-faint text-[17px] text-accent-text opacity-70">
          <Plus className="size-5" aria-hidden />
          Add channels from marketplace
          <span className="text-caption text-muted">Coming soon</span>
        </div>
      </div>
      <WidgetModal open={widgetOpen} onClose={() => setWidgetOpen(false)} botId={botId} botName={botName} webchats={webchats} canEdit={canEdit} />
    </div>
  );
}

/** Which website chats this agent answers on: ticking one points it at this agent, at once. */
function WidgetModal({ open, onClose, botId, botName, webchats, canEdit }: { open: boolean; onClose: () => void; botId: string; botName: string; webchats: Channel[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const bots = useBots();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newName, setNewName] = useState('');
  const nameOf = (id: string | null) => (bots.data ?? []).find((b) => b.id === id)?.name ?? 'another agent';

  const toggle = async (channel: Channel, on: boolean) => {
    if (on && channel.botId && channel.botId !== botId) {
      const ok = await confirm({ title: `Move “${channel.name}” to ${botName}?`, message: `It is answered by ${nameOf(channel.botId)} now. Only one agent answers a website chat.`, confirmLabel: 'Move it' });
      if (!ok) return;
    }
    if (!on) {
      const ok = await confirm({ title: `Disconnect “${channel.name}”?`, message: 'Visitors on that website chat get no AI replies until you connect an agent again.', confirmLabel: 'Disconnect', danger: true });
      if (!ok) return;
    }
    setBusy(channel.id);
    setError(null);
    try {
      await patch(`/v1/channels/${channel.id}`, { botId: on ? botId : null });
      await qc.invalidateQueries({ queryKey: ['channels'] });
      toast.success(on ? `${channel.name} now uses ${botName}` : `${channel.name} disconnected`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!newName.trim()) return;
    setBusy('new');
    setError(null);
    try {
      await post('/v1/channels/webchat', { name: newName.trim(), botId });
      await qc.invalidateQueries({ queryKey: ['channels'] });
      setNewName('');
      toast.success('Website chat created');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Chat widget"
      description="Pick the website chats this agent answers on. This takes effect at once."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorBanner error={error} /> : null}
        {webchats.length === 0 ? (
          <EmptyState title="No website chat yet" description="Create one below, then add its code to your website." />
        ) : (
          <ul className="space-y-3">
            {webchats.map((c) => {
              const mine = c.botId === botId;
              return (
                <li key={c.id} className="space-y-2 rounded-lg border border-border p-3">
                  <label className="flex items-center gap-2.5">
                    <input type="checkbox" className="size-4 accent-accent" checked={mine} disabled={!canEdit || busy !== null} onChange={(e) => void toggle(c, e.target.checked)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-fg">{c.name}</span>
                      <span className="block text-caption text-muted">
                        {mine ? `Answered by ${botName}` : c.botId ? `Answered by ${nameOf(c.botId)}` : 'No agent: no AI replies'}
                        {c.status === 'disabled' && ' · disabled in Settings'}
                      </span>
                    </span>
                    {busy === c.id && <Spinner className="size-4" />}
                  </label>
                  {mine && c.embedSnippet && (
                    <details className="text-body-sm">
                      <summary className="cursor-pointer font-medium text-accent-text">Get the code</summary>
                      <p className="mt-2 text-caption text-muted">Paste it before &lt;/body&gt; on every page of your website.</p>
                      <div className="mt-2 flex justify-end">
                        <CopyButton text={c.embedSnippet} label="Copy code" />
                      </div>
                      <CodeBlock className="mt-2 max-h-40 overflow-auto">{c.embedSnippet}</CodeBlock>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <Field label="New website chat" className="min-w-56 flex-1">
              <Input value={newName} maxLength={120} placeholder="e.g. Main website" onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Button loading={busy === 'new'} disabled={!newName.trim() || (busy !== null && busy !== 'new')} onClick={() => void create()}>
              Create and connect
            </Button>
          </div>
        )}
        <p className="text-caption text-muted">
          Colours, greeting, allowed websites and keys are in{' '}
          <Link to="/settings?tab=channels" className="text-accent-text hover:underline">
            Settings → Channels
          </Link>
          .
        </p>
      </div>
    </Modal>
  );
}
