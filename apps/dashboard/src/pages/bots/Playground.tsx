import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ChevronDown, FileText, Loader2, RotateCcw, UserRound } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { TimelineList } from '../../components/activity';
import { useToast } from '../../components/feedback-context';
import { ConversationStatusBadge } from '../../components/status';
import { Button, cx, ErrorBanner, Spinner } from '../../components/ui';
import { api, API_URL, get, post, type RequestOptions } from '../../lib/api';
import { formatTime, initialsOf } from '../../lib/format';
import { useSse } from '../../lib/sse';
import { Link } from '../../lib/router';
import type { ConversationStatus, OfferedStarter, PlaygroundSession, PublicMessage, Timeline, WidgetMessagesResponse } from '../../lib/types';

function mergeMessages(current: PublicMessage[], incoming: PublicMessage[]): PublicMessage[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

interface PlaygroundProps {
  botId: string;
  /** The editor has unsaved changes: the test chat still talks to the saved version. */
  dirty: boolean;
  /** What the website chat is called (the business's name); the assistant's name when absent. */
  title?: string;
}

/**
 * A live test chat with a bot, using the same /widget/v1 endpoints as the website widget and drawn like it.
 * Streaming text is shown as it arrives and replaced by the stored message when it lands.
 */
export function Playground({ botId, dirty, title }: PlaygroundProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [session, setSession] = useState<PlaygroundSession | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConversationStatus | null>(null);
  const [streamText, setStreamText] = useState('');
  const [activity, setActivity] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const debugId = useId();
  const generation = useRef(0);
  const messagesRef = useRef<PublicMessage[]>([]);
  messagesRef.current = messages;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Set at once (state updates later), so a double click or a quick second Enter sends nothing more. */
  const busy = useRef(false);
  /** Each starter's message id for its latest attempt: a retry after an unclear failure can't send it twice. */
  const starterAttempts = useRef(new Map<string, string>());

  const start = useCallback(async () => {
    const gen = ++generation.current;
    starterAttempts.current.clear();
    setSession(null);
    setStartError(null);
    setMessages([]);
    setConversationId(null);
    setStatus(null);
    setStreamText('');
    setActivity(null);
    setWaiting(false);
    try {
      const s = await post<PlaygroundSession>(`/v1/bots/${botId}/playground`);
      if (gen === generation.current) setSession(s);
    } catch (err) {
      if (gen === generation.current) setStartError(err);
    }
  }, [botId]);

  useEffect(() => {
    void start();
  }, [start]);

  const widget = useCallback(
    <T,>(path: string, opts: RequestOptions = {}) => {
      if (!session) throw new Error('No playground session');
      return api<T>(path, { ...opts, auth: false, headers: { authorization: `Bearer ${session.token}` } });
    },
    [session],
  );

  const timeline = useQuery({
    queryKey: ['timeline', conversationId],
    queryFn: () => get<Timeline>(`/v1/conversations/${conversationId}/timeline`),
    enabled: Boolean(conversationId),
  });
  const refreshTimeline = useCallback(() => {
    if (conversationId) void qc.invalidateQueries({ queryKey: ['timeline', conversationId] });
  }, [qc, conversationId]);

  /** Fetch anything newer than what we have — after (re)connecting the stream. */
  const fillGaps = useCallback(async () => {
    if (!session) return;
    const gen = generation.current;
    try {
      const last = messagesRef.current[messagesRef.current.length - 1];
      const res = await widget<WidgetMessagesResponse>('/widget/v1/messages', { query: { after: last?.id } });
      if (gen !== generation.current) return;
      setMessages((m) => mergeMessages(m, res.messages));
      if (res.status) setStatus(res.status);
      if (res.messages.some((m) => m.role !== 'user')) {
        setWaiting(false);
        setStreamText('');
      }
    } catch {
      // the stream reconnect will try again
    }
  }, [session, widget]);

  const streamUrl = session && conversationId ? `${API_URL}/widget/v1/stream?conversationId=${encodeURIComponent(conversationId)}` : null;
  const { connected } = useSse(
    streamUrl,
    (): Record<string, string> => (session ? { authorization: `Bearer ${session.token}` } : {}),
    (event, raw) => {
      const data = (raw ?? {}) as { message?: PublicMessage; text?: string; label?: string; status?: ConversationStatus; messageId?: string | null };
      switch (event) {
        case 'message':
          if (data.message) {
            const m = data.message;
            setMessages((list) => mergeMessages(list, [m]));
            if (m.role !== 'user') {
              setStreamText('');
              setWaiting(false);
            }
          }
          break;
        case 'ai.typing':
          setWaiting(true);
          setStreamText('');
          setActivity(null);
          break;
        case 'ai.delta':
          if (data.text) setStreamText((t) => t + data.text);
          setActivity(null);
          break;
        case 'ai.activity':
          if (data.label) setActivity(data.label);
          break;
        case 'ai.done':
          setWaiting(false);
          setActivity(null);
          setStreamText('');
          if (data.messageId && !messagesRef.current.some((m) => m.id === data.messageId)) void fillGaps();
          refreshTimeline();
          break;
        case 'conversation.status':
          if (data.status) setStatus(data.status);
          refreshTimeline();
          break;
      }
    },
    { kind: 'widget', onOpen: () => void fillGaps() },
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, activity, waiting]);

  /** Sends one visitor message; true once the server has it. */
  const deliver = async (content: string, clientMessageId: string, starterId?: string) => {
    if (!session || busy.current) return false;
    busy.current = true;
    const gen = generation.current;
    setSending(true);
    try {
      const res = await widget<{ conversationId: string; message: PublicMessage }>('/widget/v1/messages', {
        method: 'POST',
        body: { content, clientMessageId, ...(starterId ? { starterId } : {}) },
      });
      if (gen !== generation.current) return true;
      setMessages((m) => mergeMessages(m, [res.message]));
      setConversationId(res.conversationId);
      if (status !== 'human_active') setWaiting(true);
      refreshTimeline();
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const content = input.trim();
    if (!content || !session || busy.current) return;
    setInput('');
    if (!(await deliver(content, crypto.randomUUID()))) setInput(content);
  };

  const sendStarter = async (starter: OfferedStarter) => {
    if (busy.current) return;
    // The same id on a retry: if the first try did arrive after all, the server keeps one message.
    const clientMessageId = starterAttempts.current.get(starter.id) ?? crypto.randomUUID();
    starterAttempts.current.set(starter.id, clientMessageId);
    await deliver(starter.message, clientMessageId, starter.id);
  };

  // Like the website chat: the starters show under the greeting until the visitor has written.
  const starters = session?.starters ?? [];
  const showStarters = starters.length > 0 && !messages.some((m) => m.role === 'user');
  const botName = session?.botName ?? '';
  const chatName = title?.trim() || botName;
  // The greeting is as old as the test session.
  const sessionStart = useMemo(() => (session ? new Date() : null), [session]);
  // Dots until the reply's words arrive; its own row takes over from them.
  const thinking = !streamText && (waiting || Boolean(activity));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-body-sm font-semibold text-fg">
            Test chat
            {status && <ConversationStatusBadge status={status} />}
            {streamUrl && <span className={cx('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-faint')} title={connected ? 'Live' : 'Connecting…'} />}
          </p>
          <p className="truncate text-caption text-muted">{dirty ? 'Uses the saved version — save to test your changes.' : 'Test chats are marked as test data.'}</p>
        </div>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void start()}>
          Reset
        </Button>
      </div>

      {/* The chat keeps a usable height whatever the window: when there's not room for it and "What the AI did", this scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* The chat as visitors see it on the website. */}
        <section
          aria-label={chatName ? `Chat with ${chatName}` : 'Chat'}
          className="flex min-h-[22rem] flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_10px_30px_-14px_rgb(15_23_42/0.22)]"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span className="relative shrink-0">
              <ChatFace name={chatName} className="size-9 text-caption" />
              <span aria-hidden className="absolute -right-px -bottom-px size-3 rounded-full border-2 border-surface bg-success" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body leading-5 font-semibold text-fg">{chatName || 'Test chat'}</p>
              <p className="flex min-w-0 items-center gap-1.5 text-caption leading-4 text-fg-2">
                <span className="shrink-0 rounded-full bg-ai-soft px-1.5 text-[10px] leading-4 font-bold tracking-wider text-ai-text">AI</span>
                <span className="truncate">{botName ? `${botName} · usually replies instantly` : 'Usually replies instantly'}</span>
              </p>
            </div>
          </div>

          <div ref={scrollRef} role="log" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pt-4 pb-3">
            {startError ? (
              <ErrorBanner error={startError} onRetry={() => void start()} />
            ) : !session ? (
              <div className="flex flex-1 items-center justify-center py-8">
                <Spinner label="Starting a test session" />
              </div>
            ) : (
              <>
                {session.greeting && <ChatRow role="assistant" face={chatName} name={botName} time={formatTime(sessionStart)} content={session.greeting} />}
                {showStarters && (
                  <div role="group" aria-label="Suggested questions" className="flex flex-col items-end gap-2 pl-9">
                    {starters.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        disabled={sending}
                        onClick={() => void sendStarter(s)}
                        className="max-w-full rounded-[18px] border border-accent/35 bg-surface px-3.5 py-1.5 text-right text-body-sm leading-5 font-medium text-accent-text [overflow-wrap:anywhere] transition-colors hover:border-accent hover:bg-accent-soft disabled:cursor-default disabled:opacity-55 disabled:hover:border-accent/35 disabled:hover:bg-surface"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
                {messages.map((m) => (
                  <ChatRow key={m.id} role={m.role} face={chatName} name={botName} time={formatTime(m.createdAt)} content={m.content} sources={m.sources} />
                ))}
                {streamText && <ChatRow role="assistant" face={chatName} name={botName} time="" content={streamText} streaming />}
                {(thinking || activity) && (
                  <div className="flex min-w-0 items-center gap-2">
                    <ChatFace name={chatName} className="size-7 text-[10px]" />
                    {thinking && (
                      <span className="flex h-9 shrink-0 items-center gap-1 rounded-[18px] rounded-bl-md bg-surface-2 px-3.5" aria-hidden>
                        <span className="typing-dot size-1.5 rounded-full bg-muted" />
                        <span className="typing-dot size-1.5 rounded-full bg-muted" />
                        <span className="typing-dot size-1.5 rounded-full bg-muted" />
                      </span>
                    )}
                    {activity ? <span className="min-w-0 truncate text-caption text-muted">{activity}</span> : <span className="sr-only">{botName} is typing</span>}
                  </div>
                )}
                {status === 'human_active' && (
                  <div className="space-y-1 py-1 text-center">
                    <p className="flex items-center gap-2.5 text-caption font-medium text-fg-2 before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                      <UserRound className="size-3.5 shrink-0" aria-hidden />
                      Handed to a human
                    </p>
                    <p className="text-caption text-muted">The AI won't reply until the conversation is resumed.</p>
                  </div>
                )}
              </>
            )}
          </div>

          <form onSubmit={send} className="px-3">
            <div className="flex items-end gap-2 rounded-xl border border-border-strong bg-surface py-1 pr-1 pl-3 transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ring)]">
              <label htmlFor="playground-input" className="sr-only">
                Message
              </label>
              <textarea
                id="playground-input"
                rows={1}
                className="max-h-32 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-body leading-5 text-fg field-sizing-content outline-none placeholder:text-faint disabled:cursor-not-allowed"
                placeholder={session ? 'Write a message…' : 'Starting…'}
                value={input}
                disabled={!session}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter)"
                disabled={!session || !input.trim() || sending}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-4" strokeWidth={2.5} aria-hidden />}
              </button>
            </div>
          </form>
          <p className="px-3 pt-2 pb-2.5 text-center text-[10.5px] leading-4 text-muted">
            Chats are recorded so our team can assist you.
            <br />
            Powered by <span className="font-semibold text-fg-2">LeadsMagnet AI</span>
          </p>
        </section>

        {/* What happened behind each reply: tool calls, captured details and events. Open, it never takes more than 40%, so the chat keeps its message box. */}
        <section className={cx('flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface', debugOpen && 'max-h-[min(40%,18rem)] min-h-0')}>
          <button
            type="button"
            aria-expanded={debugOpen}
            aria-controls={debugOpen ? debugId : undefined}
            onClick={() => setDebugOpen((o) => !o)}
            className={cx(
              // The card clips what's outside it, so the focus ring is drawn inside.
              'flex w-full shrink-0 items-center gap-2 px-3.5 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-offset-[-2px]',
              debugOpen ? 'rounded-t-[11px]' : 'rounded-[11px]',
            )}
          >
            <span className="shrink-0 text-body-sm font-semibold text-fg">What the AI did</span>
            <span className="min-w-0 flex-1 truncate text-right text-caption text-muted">
              {!conversationId
                ? 'Send a message to see it'
                : timeline.data && `${plural(timeline.data.tools.length, 'tool call')} · ${plural(timeline.data.events.length, 'event')}`}
            </span>
            <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform', debugOpen && 'rotate-180')} aria-hidden />
          </button>
          {debugOpen && (
            <div id={debugId} className="min-h-0 flex-1 overflow-y-auto border-t border-border px-3.5 pt-2 pb-3">
              {!conversationId ? (
                <p className="py-3 text-center text-caption text-muted">Send a message to see tool calls, captured details and events here.</p>
              ) : timeline.isLoading ? (
                <Spinner />
              ) : (
                <>
                  <TimelineList timeline={timeline.data} newestFirst emptyText="No tool calls yet." />
                  <Link to={`/conversations/${conversationId}`} className="mt-2 inline-block text-caption text-accent-text hover:underline">
                    Open in Conversations →
                  </Link>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The chat's picture: the business's initials, as the website chat shows them without a logo. */
function ChatFace({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cx('flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-text', className)}>
      {initialsOf(name)}
    </span>
  );
}

/**
 * One message as the website chat draws it: the assistant's and the team's on the left with a picture, the visitor's
 * on the right, each with its time underneath (and the assistant's name).
 */
function ChatRow({
  role,
  face,
  name,
  time,
  content,
  sources,
  streaming,
}: {
  role: PublicMessage['role'];
  /** The name the chat's picture is made from. */
  face: string;
  /** The assistant's name. */
  name: string;
  /** When it was sent, formatted; empty while it's being written. */
  time: string;
  content: string;
  sources?: PublicMessage['sources'];
  streaming?: boolean;
}) {
  const mine = role === 'user';
  const meta = role === 'assistant' ? [name, time].filter(Boolean).join(' · ') : time;
  return (
    <div className={cx('flex items-end gap-2', mine && 'justify-end')}>
      {role === 'assistant' && <ChatFace name={face} className={cx('size-7 text-[10px]', meta && 'mb-5')} />}
      {role === 'agent' && (
        <span aria-hidden className={cx('flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-2', meta && 'mb-5')}>
          <UserRound className="size-3.5" />
        </span>
      )}
      <div className={cx('flex max-w-[85%] min-w-0 flex-col gap-1', mine ? 'items-end' : 'items-start')}>
        {role === 'agent' && <span className="px-1 text-caption font-semibold text-fg-2">Team member</span>}
        <div
          className={cx(
            'max-w-full rounded-[18px] px-3.5 py-2 text-body leading-[21px] whitespace-pre-wrap [overflow-wrap:anywhere]',
            mine ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md text-fg',
            role === 'assistant' && 'bg-surface-2',
            role === 'agent' && 'border border-border bg-surface',
          )}
        >
          {content}
          {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle opacity-60" aria-hidden />}
        </div>
        {sources && sources.length > 0 && (
          <div className="flex max-w-full flex-wrap gap-1.5">
            {sources.map((s, i) => (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title || s.url}
                className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-caption font-medium text-fg-2 hover:border-border-strong hover:text-fg"
              >
                <FileText className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{s.title.split(' › ').pop() || s.url}</span>
              </a>
            ))}
          </div>
        )}
        {meta && <span className="px-1 text-label leading-4 text-muted">{meta}</span>}
      </div>
    </div>
  );
}
