import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
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
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { TimelineList } from '../../components/activity';
import { ApprovalCard, useApprovals } from '../../components/approvals';
import { AiAvatar, PersonAvatar } from '../../components/avatar';
import { useToast } from '../../components/feedback-context';
import { ChannelBadge, ConversationStatusBadge, QualificationBadge, TagChip, TierBadge } from '../../components/status';
import { Badge, Button, Checkbox, cx, DefinitionList, EmptyState, ErrorBanner, IconButton, Kbd, PageHeader, Select, Spinner, SkeletonRows, type Tone } from '../../components/ui';
import { API_URL, authHeaders, get, post } from '../../lib/api';
import { formatDateTime, formatTime, SUMMARY_TRIGGER, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useMembers, usePipelines } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import { useLiveEvents } from '../../lib/live';
import { useSse } from '../../lib/sse';
import { useAuth } from '../../auth/AuthContext';
import type { ConversationDetail, ConversationListItem, ConversationStatus, Message, SummaryRequest, Timeline } from '../../lib/types';
import { DealDrawer } from '../deals/DealsPage';

const PAGE = 30;

/** Who looks after the conversation: "Assign to me", a teammate, or nobody. */
function AssigneePicker({ conversationId, assignee, canAssign }: { conversationId: string; assignee: { id: string; name: string } | null; canAssign: boolean }) {
  const { me } = useAuth();
  const members = useMembers();
  const assign = useAction((userId: string | null) => post<unknown>(`/v1/conversations/${conversationId}/assign`, { userId }), {
    invalidate: [['conversation', conversationId], ['conversations'], ['timeline', conversationId]],
    success: (_d, userId) => (userId ? (userId === me?.user.id ? 'Assigned to you' : 'Assigned') : 'Unassigned'),
  });
  if (!canAssign) return assignee ? <span className="text-caption text-muted">Assigned to {assignee.name}</span> : null;
  return (
    <Select
      aria-label="Assigned to"
      className="w-44 [&_select]:h-8 [&_select]:py-1 [&_select]:text-body-sm"
      value={assignee?.id ?? ''}
      disabled={assign.isPending}
      onChange={(e) => assign.mutate(e.target.value || null)}
    >
      <option value="">Unassigned</option>
      {me && <option value={me.user.id}>Me ({me.user.name || me.user.email})</option>}
      {(members.data ?? [])
        .filter((m) => m.userId !== me?.user.id && m.role !== 'viewer')
        .map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name || m.email}
          </option>
        ))}
      {assignee && !members.data?.some((m) => m.userId === assignee.id) && assignee.id !== me?.user.id && <option value={assignee.id}>{assignee.name}</option>}
    </Select>
  );
}

export function ConversationsPage({ conversationId }: { conversationId: string | null }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConversationStatus | ''>('');
  const [includeTest, setIncludeTest] = useState(false);
  const [assignee, setAssignee] = useState<'' | 'me' | 'unassigned'>('');
  const [sort, setSort] = useState<'recent' | 'waiting'>('recent');

  const list = useInfiniteQuery({
    queryKey: ['conversations', { status, includeTest, assignee, sort }],
    queryFn: ({ pageParam }) =>
      get<ConversationListItem[]>('/v1/conversations', { status: status || undefined, assignee: assignee || undefined, sort, includeTest, limit: PAGE, offset: pageParam }),
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
  const { connected } = useLiveEvents((event) => {
    if (event === 'message' || event === 'conversation.status' || event === 'conversation.assigned') refreshList();
  }, refreshList);

  const items = list.data?.pages.flat() ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Conversations"
        description="Every chat with your assistants. Take over any time — the AI pauses while your team replies."
        actions={
          <span className="flex items-center gap-1.5 text-caption text-muted">
            <span className={cx('size-2 rounded-full', connected ? 'bg-success ring-3 ring-success/20' : 'bg-faint')} aria-hidden />
            {connected ? 'Live' : 'Connecting…'}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1">
        {/* Below 1024 px one pane shows at a time: the list, or the open conversation. */}
        <div className={cx('w-full shrink-0 flex-col border-r border-border bg-surface lg:flex lg:w-72 xl:w-80', conversationId ? 'hidden' : 'flex')}>
          <div className="flex items-center gap-3 px-3.5 pt-3 pb-2">
            <Select aria-label="Status" className="flex-1" value={status} onChange={(e) => setStatus(e.target.value as ConversationStatus | '')}>
              <option value="">All statuses</option>
              <option value="ai_active">AI handling</option>
              <option value="human_active">Needs a human</option>
              <option value="closed">Closed</option>
            </Select>
            <Checkbox label="Include tests" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} className="shrink-0 [&_label]:text-caption" />
          </div>
          <div className="flex items-center gap-2 border-b border-border px-3.5 pb-3">
            <Select aria-label="Assigned to" className="flex-1" value={assignee} onChange={(e) => setAssignee(e.target.value as '' | 'me' | 'unassigned')}>
              <option value="">Everyone's</option>
              <option value="me">Mine</option>
              <option value="unassigned">Unassigned</option>
            </Select>
            <Select aria-label="Sort" className="flex-1" value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'waiting')}>
              <option value="recent">Latest first</option>
              <option value="waiting">Waiting longest</option>
            </Select>
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
                      className={cx(
                        'relative flex gap-3 border-b border-border px-3.5 py-3 transition-colors',
                        c.id === conversationId ? 'bg-accent-soft before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-accent' : 'hover:bg-surface-2',
                      )}
                    >
                      <PersonAvatar name={c.contact.name || c.contact.email || c.contact.phone} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-body-sm font-semibold text-fg">{c.contact.name || c.contact.email || c.contact.phone || 'Anonymous visitor'}</span>
                          <span className="shrink-0 text-label text-muted tabular-nums">{timeAgo(c.lastMessageAt ?? c.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-caption text-muted">
                          {c.lastMessage ? (
                            <>
                              {c.lastMessage.senderType === 'ai' ? (
                                <span className="font-semibold text-ai-text">AI: </span>
                              ) : c.lastMessage.senderType === 'human' ? (
                                <span className="font-semibold text-human-text">Team: </span>
                              ) : null}
                              {c.lastMessage.content}
                            </>
                          ) : (
                            'No messages yet'
                          )}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1">
                          <ConversationStatusBadge status={c.status} />
                          {c.overdue && <Badge tone="red">Waiting too long</Badge>}
                          {c.status === 'human_active' && !c.firstStaffReplyAt && c.handedOffAt && !c.overdue && (
                            <span className="text-label text-muted">waiting {timeAgo(c.handedOffAt).replace(/ ago$/, '')}</span>
                          )}
                          <ChannelBadge channel={c.channel} />
                          {c.assignee && <span className="text-label text-muted">· {c.assignee.name}</span>}
                          {c.contact.leadTier && <TierBadge tier={c.contact.leadTier} />}
                          {c.isTest && <Badge tone="blue">Test</Badge>}
                        </div>
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
        <div className={cx('min-w-0 flex-1', !conversationId && 'hidden lg:block')}>
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
        case 'conversation.assigned':
          void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
          void qc.invalidateQueries({ queryKey: ['timeline', conversationId] });
          break;
      }
    },
    { onOpen: () => void fillGaps() },
  );

  // On narrow screens the details are an overlay: Escape closes it.
  useEffect(() => {
    if (!showDetails) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !window.matchMedia('(min-width: 1280px)').matches) setShowDetails(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showDetails]);

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
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <IconButton label="Back to inbox" size="sm" className="-ml-1 lg:hidden" onClick={() => navigate('/conversations')}>
              <ArrowLeft className="size-4" />
            </IconButton>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-[15px] leading-[22px] font-semibold text-fg">
                {contactName}
                <ConversationStatusBadge status={conv.status} />
                <ChannelBadge channel={conv.channel} />
                {conv.isTest && <Badge tone="blue">Test</Badge>}
                <span className={cx('size-2 rounded-full', connected ? 'bg-success' : 'bg-faint')} title={connected ? 'Live' : 'Connecting…'} />
              </p>
              <p className="mt-0.5 truncate text-caption text-muted">
                Started {formatDateTime(conv.createdAt)} · {conv.messageCount} messages
                {conv.status === 'human_active' && conv.handoffReason ? ` · Handoff: ${conv.handoffReason}` : ''}
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {conv.overdue && <Badge tone="red">Waiting too long</Badge>}
            <AssigneePicker conversationId={conv.id} assignee={conv.assignee} canAssign={canReply && conv.status !== 'closed'} />
            {canReply && conv.status === 'ai_active' && (
              <Button size="sm" icon={<Hand className="size-3.5 text-human" />} loading={setStatus.isPending && setStatus.variables === 'takeover'} onClick={() => setStatus.mutate('takeover')}>
                Take over
              </Button>
            )}
            {canReply && conv.status === 'human_active' && (
              <Button size="sm" icon={<Sparkles className="size-3.5 text-ai" />} loading={setStatus.isPending && setStatus.variables === 'resume'} onClick={() => setStatus.mutate('resume')}>
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
              className={showDetails ? 'bg-surface-2 text-fg' : undefined}
              icon={showDetails ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
              onClick={() => setShowDetails((s) => !s)}
            >
              Details
            </Button>
          </div>
        </div>
        <SummaryBar conv={conv} messages={messages.data} canRefresh={canReply} />
        {approvals.data?.length ? (
          <div className="space-y-2 border-b border-border bg-surface px-5 py-3.5">
            {approvals.data.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-bg px-6 py-6" aria-live="polite">
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
                <p className="flex items-center justify-end gap-1.5 pr-10 text-caption text-ai-text">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  {activity}
                </p>
              )}
              {typing && !streamText && !activity && (
                <div className="flex items-center justify-end gap-2" aria-label="AI is typing">
                  <span className="flex gap-1 rounded-2xl rounded-br-md bg-ai-soft px-3.5 py-3">
                    <span className="typing-dot size-1.5 rounded-full bg-ai" />
                    <span className="typing-dot size-1.5 rounded-full bg-ai" />
                    <span className="typing-dot size-1.5 rounded-full bg-ai" />
                  </span>
                  <AiAvatar />
                </div>
              )}
              {messages.data?.length === 0 && <p className="py-8 text-center text-body-sm text-muted">No messages yet.</p>}
            </>
          )}
        </div>

        {canReply && conv.status !== 'closed' ? (
          <form onSubmit={submitReply} className="border-t border-border bg-surface px-5 py-4">
            <div className="rounded-xl border border-border-strong bg-input-bg transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
              <label htmlFor="staff-reply" className="sr-only">
                Reply
              </label>
              <textarea
                id="staff-reply"
                rows={3}
                className="block w-full resize-none bg-transparent px-3.5 pt-3 text-body text-fg outline-none placeholder:text-faint"
                placeholder={conv.status === 'ai_active' ? 'Reply as your team — sending takes over from the AI' : 'Write a reply…'}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={4000}
              />
              <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-2.5">
                <p className="pl-0.5 text-caption text-muted">
                  <Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> to send
                </p>
                <Button type="submit" variant="primary" size="sm" icon={<Send className="size-3.5" />} loading={sendReply.isPending} disabled={!reply.trim()}>
                  Send
                </Button>
              </div>
            </div>
          </form>
        ) : conv.status === 'closed' ? (
          <p className="border-t border-border bg-surface-2/60 px-5 py-4 text-center text-body-sm text-muted">This conversation is closed. A new message from the visitor starts a new conversation.</p>
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
      {showDetails && <div className="fixed inset-0 z-30 bg-overlay xl:hidden" aria-hidden onClick={() => setShowDetails(false)} />}
      {showDetails && (
        // Below 1280 px the details open over the thread instead of squeezing it.
        <aside
          className="fixed inset-y-0 right-0 z-40 w-[min(20rem,100vw)] shrink-0 overflow-y-auto border-l border-border bg-surface shadow-modal xl:static xl:z-auto xl:w-80 xl:shadow-none"
          aria-label="Conversation details"
        >
          <div className="space-y-4 border-b border-border p-5">
            <div className="flex items-center gap-3">
              <PersonAvatar name={contact.name || contact.email || contact.phone} size="lg" />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-body font-semibold text-fg">{contactName}</h3>
                <p className="text-caption text-muted">Contact</p>
              </div>
              <Link to={`/contacts/${contact.id}`} className="inline-flex items-center gap-1 text-caption font-medium text-accent-text hover:underline">
                Open <ExternalLink className="size-3" />
              </Link>
              <IconButton label="Close details" size="sm" className="xl:hidden" onClick={() => setShowDetails(false)}>
                <X className="size-4" />
              </IconButton>
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
                        <span key="ip" className="font-mono text-caption" title={visitorIpAt ? `Last seen ${formatDateTime(visitorIpAt)}` : undefined}>
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
          <div className="p-5">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-body font-semibold text-fg">Timeline</h3>
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
    <div className="border-b border-border bg-surface-2/60 px-5 py-2" aria-label="Conversation summary">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 py-0.5 text-left text-body-sm text-fg-2 disabled:cursor-default"
          aria-expanded={open}
          disabled={!conv.summary}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-ai-soft text-ai" aria-hidden>
            <Sparkles className="size-3" />
          </span>
          <span className="min-w-0 flex-1 truncate">{headline}</span>
          {mood?.tone === 'red' && !open && <Badge tone="red">{mood.label}</Badge>}
          {since ? <span className="shrink-0 text-label text-muted">{since} new</span> : null}
          {conv.summary && (open ? <ChevronUp className="size-3.5 shrink-0 text-muted" aria-hidden /> : <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />)}
        </button>
        {canRefresh && conv.status !== 'closed' && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={refresh.isPending || waiting} onClick={() => refresh.mutate()}>
            {conv.summary ? 'Refresh' : 'Summarize'}
          </Button>
        )}
      </div>
      {open && conv.summary && (
        <div className="space-y-2 pt-2 pb-2 pl-8">
          {d && (
            <DefinitionList
              className="text-caption"
              items={[
                ['Wants', d.intent ?? '—'],
                ['Outcome', d.outcome ?? '—'],
                ['Next step', d.nextStep ?? 'Nothing open'],
                ['Mood', mood ? <Badge key="m" tone={mood.tone}>{mood.label}</Badge> : '—'],
              ]}
            />
          )}
          <p className="text-caption leading-relaxed whitespace-pre-wrap text-fg-2">{conv.summary}</p>
          <p className="text-label text-muted">
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
    return (
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <p className="max-w-[70%] rounded-full border border-border bg-surface px-3 py-1 text-center text-caption text-muted">{message.content}</p>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
    );
  }
  const fromContact = message.direction === 'inbound';
  const team = !fromContact && message.senderType === 'human';
  const label = fromContact ? name : team ? 'Team' : 'AI';
  // Three voices: the visitor (neutral, left), the AI (iris, right) and your team (apricot, right).
  return (
    <div className={cx('flex items-end gap-2.5', fromContact ? 'flex-row' : 'flex-row-reverse')}>
      {fromContact ? <PersonAvatar name={name === 'Anonymous visitor' ? null : name} /> : team ? <PersonAvatar name="Team" tone="human" /> : <AiAvatar />}
      <div className={cx('flex max-w-[75%] min-w-0 flex-col', fromContact ? 'items-start' : 'items-end')}>
        <span className={cx('mb-1 flex items-center gap-1.5 px-1 text-label', fromContact ? 'text-muted' : team ? 'font-semibold text-human-text' : 'font-semibold text-ai-text')}>
          {label}
          {message.createdAt && (
            <time dateTime={message.createdAt} className="font-normal text-muted">
              {formatTime(message.createdAt)}
            </time>
          )}
        </span>
        <div
          className={cx(
            'rounded-2xl px-3.5 py-2.5 text-body break-words whitespace-pre-wrap',
            fromContact
              ? 'rounded-bl-md border border-border bg-surface text-fg'
              : team
                ? 'rounded-br-md border border-human/25 bg-human-soft text-fg'
                : 'rounded-br-md border border-ai/25 bg-ai-soft text-fg',
          )}
        >
          {message.content}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ai align-middle opacity-70" aria-hidden />}
        </div>
        {citations.length > 0 && (
          <div className={cx('mt-1.5 flex flex-wrap items-center gap-1 px-1', fromContact ? 'justify-start' : 'justify-end')}>
            <span className="text-label text-muted">Sources:</span>
            {citations.map((c, i) =>
              c.url ? (
                <a
                  key={i}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  title={c.title}
                  className="max-w-64 truncate rounded-md border border-border bg-surface px-1.5 py-0.5 text-label text-accent-text hover:border-border-strong hover:underline"
                >
                  {c.title}
                </a>
              ) : (
                <span key={i} title={c.title} className="max-w-64 truncate rounded-md border border-border bg-surface px-1.5 py-0.5 text-label text-fg-2">
                  {c.title}
                </span>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
