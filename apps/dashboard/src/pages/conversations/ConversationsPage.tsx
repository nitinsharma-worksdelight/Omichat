import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Hand,
  Handshake,
  Inbox,
  Loader2,
  MessagesSquare,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { TimelineList } from '../../components/activity';
import { ApprovalCard, useApprovals } from '../../components/approvals';
import { useToast } from '../../components/feedback-context';
import { ChannelBadge, ConversationStatusBadge, QualificationBadge, TagChip, TierBadge } from '../../components/status';
import { Badge, Button, Checkbox, cx, DefinitionList, EmptyState, ErrorBanner, Kbd, PageHeader, Select, Spinner, SkeletonRows, type Tone } from '../../components/ui';
import { API_URL, authHeaders, get, post } from '../../lib/api';
import { formatDateTime, formatTime, SUMMARY_TRIGGER, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, usePipelines } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import { useSse } from '../../lib/sse';
import { useAuth } from '../../auth/AuthContext';
import type { ConversationDetail, ConversationListItem, ConversationStatus, Message, SummaryRequest, Timeline } from '../../lib/types';
import { DealDrawer } from '../deals/DealsPage';

const PAGE = 30;

export function ConversationsPage({ conversationId }: { conversationId: string | null }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConversationStatus | ''>('');
  const [includeTest, setIncludeTest] = useState(false);

  const list = useInfiniteQuery({
    queryKey: ['conversations', { status, includeTest }],
    queryFn: ({ pageParam }) => get<ConversationListItem[]>('/v1/conversations', { status: status || undefined, includeTest, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });

  // Org-wide live updates: refresh the list (debounced) when messages or statuses change anywhere.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshList = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void qc.invalidateQueries({ queryKey: ['conversations'] }), 400);
  }, [qc]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const { connected } = useSse(`${API_URL}/v1/stream`, authHeaders, (event) => {
    if (event === 'message' || event === 'conversation.status') refreshList();
  }, { onOpen: refreshList });

  const items = list.data?.pages.flat() ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Conversations"
        description="Every chat with your assistants. Take over any time — the AI pauses while your team replies."
        actions={
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className={cx('size-2 rounded-full', connected ? 'bg-success' : 'bg-faint')} aria-hidden />
            {connected ? 'Live' : 'Connecting…'}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
            <Select aria-label="Status" className="flex-1" value={status} onChange={(e) => setStatus(e.target.value as ConversationStatus | '')}>
              <option value="">All statuses</option>
              <option value="ai_active">AI handling</option>
              <option value="human_active">Needs a human</option>
              <option value="closed">Closed</option>
            </Select>
            <Checkbox label="Include tests" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} className="shrink-0 text-xs" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.isLoading ? (
              <SkeletonRows rows={8} />
            ) : list.error ? (
              <ErrorBanner error={list.error} className="m-3" onRetry={() => void list.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<Inbox className="size-5" />}
                title="No conversations"
                description={includeTest ? 'Nothing matches these filters.' : 'Chats from your website show up here. Tick “Include tests” to see playground chats.'}
              />
            ) : (
              <ul>
                {items.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`/conversations/${c.id}`}
                      aria-current={c.id === conversationId ? 'true' : undefined}
                      className={cx('block border-b border-border px-3 py-3 transition-colors', c.id === conversationId ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-fg">{c.contact.name || c.contact.email || c.contact.phone || 'Anonymous visitor'}</span>
                        <span className="shrink-0 text-[11px] text-muted">{timeAgo(c.lastMessageAt ?? c.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">
                        {c.lastMessage ? (
                          <>
                            {c.lastMessage.senderType === 'ai' ? 'AI: ' : c.lastMessage.senderType === 'human' ? 'Team: ' : ''}
                            {c.lastMessage.content}
                          </>
                        ) : (
                          'No messages yet'
                        )}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <ConversationStatusBadge status={c.status} />
                        <ChannelBadge channel={c.channel} />
                        {c.contact.leadTier && <TierBadge tier={c.contact.leadTier} />}
                        {c.isTest && <Badge tone="blue">Test</Badge>}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="p-3">
                <Button size="sm" className="w-full" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {conversationId ? (
            <Thread key={conversationId} conversationId={conversationId} />
          ) : (
            <EmptyState className="h-full" icon={<MessagesSquare className="size-5" />} title="Select a conversation" description="Pick a chat on the left to read it, see what the AI did, or reply." />
          )}
        </div>
      </div>
    </div>
  );
}

function mergeMessages(current: Message[] | undefined, incoming: Message[]): Message[] {
  const byId = new Map((current ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function Thread({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const canReply = roleAtLeast(role, 'agent');
  const [showDetails, setShowDetails] = useState(() => window.innerWidth >= 1360);
  const [streamText, setStreamText] = useState('');
  const [activity, setActivity] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [reply, setReply] = useState('');
  const [dealOpen, setDealOpen] = useState(false);
  const pipelines = usePipelines();
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversation = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => get<ConversationDetail>(`/v1/conversations/${conversationId}`) });
  const messages = useQuery({ queryKey: ['messages', conversationId], queryFn: () => get<Message[]>(`/v1/conversations/${conversationId}/messages`, { limit: 200 }) });
  const timeline = useQuery({ queryKey: ['timeline', conversationId], queryFn: () => get<Timeline>(`/v1/conversations/${conversationId}/timeline`) });
  const approvals = useApprovals({ status: 'pending', conversationId });

  const fillGaps = useCallback(async () => {
    const current = qc.getQueryData<Message[]>(['messages', conversationId]);
    const last = current?.[current.length - 1];
    if (!last) return void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    try {
      const newer = await get<Message[]>(`/v1/conversations/${conversationId}/messages`, { after: last.id, limit: 200 });
      if (newer.length) qc.setQueryData<Message[]>(['messages', conversationId], (m) => mergeMessages(m, newer));
    } catch {
      // next reconnect retries
    }
  }, [qc, conversationId]);

  const { connected } = useSse(
    `${API_URL}/v1/stream?conversationId=${encodeURIComponent(conversationId)}`,
    authHeaders,
    (event, raw) => {
      const data = (raw ?? {}) as { message?: Message; text?: string; label?: string };
      switch (event) {
        case 'message':
          if (data.message) {
            const m = data.message;
            qc.setQueryData<Message[]>(['messages', conversationId], (list) => mergeMessages(list, [m]));
            if (m.senderType === 'ai') {
              setStreamText('');
              setTyping(false);
            }
          }
          break;
        case 'ai.typing':
          setTyping(true);
          setStreamText('');
          break;
        case 'ai.delta':
          if (data.text) setStreamText((t) => t + data.text);
          setActivity(null);
          break;
        case 'ai.activity':
          if (data.label) setActivity(data.label);
          break;
        case 'ai.done':
          setTyping(false);
          setActivity(null);
          setStreamText('');
          void qc.invalidateQueries({ queryKey: ['timeline', conversationId] });
          void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
          // The reply may have asked the team to approve something.
          void qc.invalidateQueries({ queryKey: ['approvals'] });
          break;
        case 'conversation.status':
        case 'conversation.summary':
          void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
          void qc.invalidateQueries({ queryKey: ['timeline', conversationId] });
          break;
      }
    },
    { onOpen: () => void fillGaps() },
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.data, streamText, activity, typing]);

  const setStatus = useAction((action: 'takeover' | 'resume' | 'close') => post<unknown>(`/v1/conversations/${conversationId}/status`, { action }), {
    invalidate: [['conversation', conversationId], ['conversations'], ['timeline', conversationId]],
    success: (_d, action) => (action === 'takeover' ? 'You took over — the AI is paused' : action === 'resume' ? 'AI resumed' : 'Conversation closed'),
  });

  const sendReply = useAction((content: string) => post<Message>(`/v1/conversations/${conversationId}/messages`, { content }), {
    onSuccess: (m) => {
      qc.setQueryData<Message[]>(['messages', conversationId], (list) => mergeMessages(list, [m]));
      setReply('');
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const submitReply = (e?: FormEvent) => {
    e?.preventDefault();
    const content = reply.trim();
    if (content && !sendReply.isPending) sendReply.mutate(content);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitReply();
    }
  };

  if (conversation.isLoading) return <SkeletonRows rows={8} />;
  if (conversation.error || !conversation.data) {
    return (
      <div className="p-6">
        <ErrorBanner error={conversation.error} onRetry={() => void conversation.refetch()} />
        <Button className="mt-3" variant="ghost" onClick={() => navigate('/conversations')}>
          Back to inbox
        </Button>
      </div>
    );
  }
  const conv = conversation.data;
  const contact = conv.contact;
  // A website visitor's address as the server saw it at their latest chat session (staff only; not for test chats).
  const visitorIp = typeof conv.metadata.visitorIp === 'string' ? conv.metadata.visitorIp : null;
  const visitorIpAt = typeof conv.metadata.visitorIpAt === 'string' ? conv.metadata.visitorIpAt : null;
  const contactName = contact.name || contact.email || contact.phone || 'Anonymous visitor';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-surface px-5 py-2.5">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-fg">
              {contactName}
              <ConversationStatusBadge status={conv.status} />
              <ChannelBadge channel={conv.channel} />
              {conv.isTest && <Badge tone="blue">Test</Badge>}
              <span className={cx('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-faint')} title={connected ? 'Live' : 'Connecting…'} />
            </p>
            <p className="truncate text-xs text-muted">
              Started {formatDateTime(conv.createdAt)} · {conv.messageCount} messages
              {conv.status === 'human_active' && conv.handoffReason ? ` · Handoff: ${conv.handoffReason}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {canReply && conv.status === 'ai_active' && (
              <Button size="sm" icon={<Hand className="size-3.5" />} loading={setStatus.isPending && setStatus.variables === 'takeover'} onClick={() => setStatus.mutate('takeover')}>
                Take over
              </Button>
            )}
            {canReply && conv.status === 'human_active' && (
              <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={setStatus.isPending && setStatus.variables === 'resume'} onClick={() => setStatus.mutate('resume')}>
                Resume AI
              </Button>
            )}
            {canReply && conv.status !== 'closed' && (
              <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} loading={setStatus.isPending && setStatus.variables === 'close'} onClick={() => setStatus.mutate('close')}>
                Close
              </Button>
            )}
            {canReply && (
              <Button size="sm" variant="ghost" icon={<Handshake className="size-3.5" />} disabled={!pipelines.data} onClick={() => setDealOpen(true)}>
                Create deal
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={showDetails}
              icon={showDetails ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
              onClick={() => setShowDetails((s) => !s)}
            >
              Details
            </Button>
          </div>
        </div>
        <SummaryBar conv={conv} messages={messages.data} canRefresh={canReply} />
        {approvals.data?.length ? (
          <div className="space-y-2 border-b border-border bg-surface px-5 py-3">
            {approvals.data.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-bg px-6 py-5" aria-live="polite">
          {messages.isLoading ? (
            <SkeletonRows rows={6} />
          ) : messages.error ? (
            <ErrorBanner error={messages.error} />
          ) : (
            <>
              {(messages.data ?? []).map((m) => (
                <MessageBubble key={m.id} message={m} contactName={contactName} />
              ))}
              {streamText && <MessageBubble message={{ senderType: 'ai', direction: 'outbound', content: streamText, citations: [], createdAt: '' }} contactName={contactName} streaming />}
              {activity && (
                <p className="flex items-center justify-end gap-1.5 text-xs text-muted">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  {activity}
                </p>
              )}
              {typing && !streamText && !activity && (
                <div className="flex justify-end gap-1 pr-1" aria-label="AI is typing">
                  <span className="typing-dot size-1.5 rounded-full bg-faint" />
                  <span className="typing-dot size-1.5 rounded-full bg-faint" />
                  <span className="typing-dot size-1.5 rounded-full bg-faint" />
                </div>
              )}
              {messages.data?.length === 0 && <p className="py-8 text-center text-[13px] text-muted">No messages yet.</p>}
            </>
          )}
        </div>

        {canReply && conv.status !== 'closed' ? (
          <form onSubmit={submitReply} className="border-t border-border bg-surface p-3">
            <label htmlFor="staff-reply" className="sr-only">
              Reply
            </label>
            <textarea
              id="staff-reply"
              rows={3}
              className="control resize-none"
              placeholder={conv.status === 'ai_active' ? 'Reply as your team — sending takes over from the AI' : 'Write a reply…'}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={4000}
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xs text-muted">
                <Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to send
              </p>
              <Button type="submit" variant="primary" size="sm" icon={<Send className="size-3.5" />} loading={sendReply.isPending} disabled={!reply.trim()}>
                Send
              </Button>
            </div>
          </form>
        ) : conv.status === 'closed' ? (
          <p className="border-t border-border bg-surface px-4 py-3 text-center text-[13px] text-muted">This conversation is closed. A new message from the visitor starts a new conversation.</p>
        ) : null}
      </div>

      {dealOpen && pipelines.data && (
        <DealDrawer
          deal={null}
          pipelines={pipelines.data}
          preset={{
            contact: { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone },
            conversationId: conv.id,
            title: (conv.summaryDetails?.intent ?? '').slice(0, 200),
          }}
          onClose={() => setDealOpen(false)}
        />
      )}
      {showDetails && (
        <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface" aria-label="Conversation details">
          <div className="space-y-3 border-b border-border p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">Contact</h3>
              <Link to={`/contacts/${contact.id}`} className="inline-flex items-center gap-1 text-xs text-accent-text hover:underline">
                Open <ExternalLink className="size-3" />
              </Link>
            </div>
            <DefinitionList
              items={[
                ['Name', contact.name || '—'],
                ['Email', contact.email || '—'],
                ['Phone', contact.phone || '—'],
                ['Company', contact.company || '—'],
                ['Stage', contact.lifecycleStage],
                ['Lead', <span key="t" className="flex items-center gap-1.5"><TierBadge tier={contact.leadTier} /> <span className="text-muted">score {contact.leadScore}</span></span>],
                ['Qualification', <QualificationBadge key="q" status={contact.qualificationStatus} />],
                ...(visitorIp
                  ? [
                      [
                        'IP address',
                        <span key="ip" className="font-mono text-[12.5px]" title={visitorIpAt ? `Last seen ${formatDateTime(visitorIpAt)}` : undefined}>
                          {visitorIp}
                        </span>,
                      ] as [string, ReactNode],
                    ]
                  : []),
              ]}
            />
            {contact.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {contact.tags.map((t) => (
                  <TagChip key={t.id} name={t.name} color={t.color} />
                ))}
              </div>
            )}
          </div>
          <div className="p-4">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-fg">Timeline</h3>
              {timeline.isFetching && <Spinner />}
            </div>
            {timeline.error ? <ErrorBanner error={timeline.error} /> : <TimelineList timeline={timeline.data} emptyText="No AI actions or events yet." />}
          </div>
        </aside>
      )}
    </div>
  );
}

const SUMMARY_BLOCKED: Record<string, string> = {
  nothing_new: 'The summary is already up to date.',
  too_short: 'Nothing to summarize yet: the customer has sent only one message.',
  ai_off: 'The AI is turned off for your organization, so no summary can be written.',
  budget: "This month's AI budget is spent, so no summary can be written.",
};

const MOOD: Record<string, { label: string; tone: Tone }> = {
  positive: { label: 'Positive', tone: 'green' },
  neutral: { label: 'Neutral', tone: 'slate' },
  negative: { label: 'Negative', tone: 'red' },
};

/** The conversation's summary at a glance (what the customer wants, the next step), opening to the rest. */
function SummaryBar({ conv, messages, canRefresh }: { conv: ConversationDetail; messages: Message[] | undefined; canRefresh: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const d = conv.summaryDetails;
  const version = d?.at ?? conv.summary ?? '';
  // A new summary arrived (the live event refetched the conversation), or it's taking too long: stop waiting.
  useEffect(() => setWaiting(false), [version]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaiting(false), 30_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  const refresh = useAction(() => post<SummaryRequest>(`/v1/conversations/${conv.id}/summary`, {}), {
    onSuccess: (r) => {
      if (r.queued) {
        setWaiting(true);
        toast.info('Updating the summary…');
      } else {
        toast.info(SUMMARY_BLOCKED[r.reason] ?? 'The summary can’t be updated right now.');
      }
    },
  });
  if (!conv.summary && (!canRefresh || conv.status === 'closed')) return null;

  // Messages after the recap, among those loaded in the thread.
  const at = d && messages ? messages.findIndex((m) => m.id === d.throughMessageId) : -1;
  const since = d && messages && at >= 0 ? messages.slice(at + 1).filter((m) => m.senderType !== 'system').length : null;
  const mood = d?.sentiment ? MOOD[d.sentiment] : null;
  const headline = d?.intent ? (
    <>
      <span className="font-medium text-fg">Wants:</span> {d.intent}
      {d.nextStep && (
        <>
          <span className="text-faint"> · </span>
          <span className="font-medium text-fg">Next:</span> {d.nextStep}
        </>
      )}
    </>
  ) : conv.summary ? (
    <>
      <span className="font-medium text-fg">Summary:</span> {conv.summary}
    </>
  ) : (
    <span className="text-muted">No summary yet</span>
  );

  return (
    <div className="border-b border-border bg-surface-2/60 px-5 py-1.5" aria-label="Conversation summary">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left text-xs text-fg-2 disabled:cursor-default"
          aria-expanded={open}
          disabled={!conv.summary}
          onClick={() => setOpen((o) => !o)}
        >
          <ScrollText className="size-3.5 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{headline}</span>
          {mood?.tone === 'red' && !open && <Badge tone="red">{mood.label}</Badge>}
          {since ? <span className="shrink-0 text-[11px] text-muted">{since} new</span> : null}
          {conv.summary && (open ? <ChevronUp className="size-3.5 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />)}
        </button>
        {canRefresh && conv.status !== 'closed' && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending || waiting} onClick={() => refresh.mutate()}>
            {conv.summary ? 'Refresh' : 'Summarize'}
          </Button>
        )}
      </div>
      {open && conv.summary && (
        <div className="space-y-2 pt-1.5 pb-1.5 pl-[22px]">
          {d && (
            <DefinitionList
              className="text-xs"
              items={[
                ['Wants', d.intent ?? '—'],
                ['Outcome', d.outcome ?? '—'],
                ['Next step', d.nextStep ?? 'Nothing open'],
                ['Mood', mood ? <Badge key="m" tone={mood.tone}>{mood.label}</Badge> : '—'],
              ]}
            />
          )}
          <p className="text-xs leading-relaxed whitespace-pre-wrap text-fg-2">{conv.summary}</p>
          <p className="text-[11px] text-muted">
            {d
              ? `Updated ${timeAgo(d.at)}${SUMMARY_TRIGGER[d.trigger] ? ` ${SUMMARY_TRIGGER[d.trigger]}` : ''} · ${
                  since === null ? 'the conversation up to then' : since === 0 ? 'covers the whole conversation' : `${since} new message${since === 1 ? '' : 's'} since`
                }`
              : 'Covers the earlier part of this conversation'}
          </p>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, contactName: name, streaming }: { message: Pick<Message, 'senderType' | 'direction' | 'content' | 'citations' | 'createdAt'>; contactName: string; streaming?: boolean }) {
  const citations = message.citations.filter((c, i, all) => all.findIndex((x) => x.title === c.title && (x.url ?? null) === (c.url ?? null)) === i);
  if (message.senderType === 'system') {
    return <p className="text-center text-xs text-muted">{message.content}</p>;
  }
  const fromContact = message.direction === 'inbound';
  const label = fromContact ? name : message.senderType === 'human' ? 'Team' : 'AI';
  return (
    <div className={cx('flex flex-col', fromContact ? 'items-start' : 'items-end')}>
      <span className="mb-0.5 flex items-center gap-1.5 px-1 text-[11px] text-muted">
        {!fromContact && <Badge tone={message.senderType === 'human' ? 'amber' : 'indigo'}>{label}</Badge>}
        {fromContact && label}
        {message.createdAt && <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>}
      </span>
      <div
        className={cx(
          'max-w-[75%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap',
          fromContact ? 'rounded-bl-md border border-border bg-surface text-fg' : message.senderType === 'human' ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-br-md bg-accent-soft text-fg',
        )}
      >
        {message.content}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle opacity-60" aria-hidden />}
      </div>
      {citations.length > 0 && (
        <div className="mt-1 flex max-w-[75%] flex-wrap justify-end gap-x-2 gap-y-0.5 px-1">
          <span className="text-[11px] text-faint">Sources:</span>
          {citations.map((c, i) =>
            c.url ? (
              <a key={i} href={c.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent-text hover:underline">
                {c.title}
              </a>
            ) : (
              <span key={i} className="text-[11px] text-muted">
                {c.title}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}
