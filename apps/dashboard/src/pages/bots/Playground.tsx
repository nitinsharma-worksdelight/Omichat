import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, RotateCcw, Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { TimelineList } from '../../components/activity';
import { useToast } from '../../components/feedback-context';
import { ConversationStatusBadge } from '../../components/status';
import { Button, cx, ErrorBanner, Spinner } from '../../components/ui';
import { api, API_URL, get, post, type RequestOptions } from '../../lib/api';
import { useSse } from '../../lib/sse';
import { Link } from '../../lib/router';
import type { ConversationStatus, OfferedStarter, PlaygroundSession, PublicMessage, Timeline, WidgetMessagesResponse } from '../../lib/types';

function mergeMessages(current: PublicMessage[], incoming: PublicMessage[]): PublicMessage[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * A live test chat with a bot, using the same /widget/v1 endpoints as the website widget.
 * Streaming text is shown as it arrives and replaced by the stored message when it lands.
 */
export function Playground({ botId, dirty }: { botId: string; dirty: boolean }) {
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
  const [debugOpen, setDebugOpen] = useState(true);
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            Playground
            {status && <ConversationStatusBadge status={status} />}
            {streamUrl && <span className={cx('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-faint')} title={connected ? 'Live' : 'Connecting…'} />}
          </p>
          <p className="truncate text-xs text-muted">{dirty ? 'Uses the saved version — save to test your changes.' : 'Test chats are marked as test data.'}</p>
        </div>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void start()}>
          Reset
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-bg px-4 py-4" aria-live="polite">
        {startError ? (
          <ErrorBanner error={startError} onRetry={() => void start()} />
        ) : !session ? (
          <div className="flex justify-center py-8">
            <Spinner label="Starting a test session" />
          </div>
        ) : (
          <>
            {session.greeting && <Bubble role="assistant" name={session.botName} content={session.greeting} />}
            {showStarters && (
              <div role="group" aria-label="Quick options" className="flex flex-wrap justify-end gap-2">
                {starters.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    disabled={sending}
                    onClick={() => void sendStarter(s)}
                    className="max-w-full rounded-2xl border border-accent px-3 py-1.5 text-left text-[13px] text-fg [overflow-wrap:anywhere] hover:bg-surface-2 disabled:cursor-default disabled:opacity-55"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} role={m.role} name={m.role === 'agent' ? 'Team' : session.botName} content={m.content} sources={m.sources} />
            ))}
            {streamText && <Bubble role="assistant" name={session.botName} content={streamText} streaming />}
            {activity && (
              <p className="flex items-center gap-1.5 pl-1 text-xs text-muted">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {activity}
              </p>
            )}
            {waiting && !streamText && !activity && (
              <div className="flex items-center gap-1 pl-1" aria-label={`${session.botName} is typing`}>
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
                <span className="typing-dot size-1.5 rounded-full bg-faint" />
              </div>
            )}
            {status === 'human_active' && <p className="text-center text-xs text-warning-text">Handed to a human — the AI won't reply until the conversation is resumed.</p>}
          </>
        )}
      </div>

      <form onSubmit={send} className="flex items-end gap-2 border-t border-border p-3">
        <label htmlFor="playground-input" className="sr-only">
          Message
        </label>
        <textarea
          id="playground-input"
          rows={1}
          className="control max-h-32 min-h-9 resize-none"
          placeholder={session ? 'Type a message… (Enter to send)' : 'Starting…'}
          value={input}
          disabled={!session}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" variant="primary" size="md" aria-label="Send" disabled={!session || !input.trim()} loading={sending} icon={sending ? undefined : <Send className="size-4" />} />
      </form>

      <div className={cx('flex min-h-0 flex-col border-t border-border', debugOpen ? 'h-[40%]' : '')}>
        <button
          type="button"
          aria-expanded={debugOpen}
          onClick={() => setDebugOpen((o) => !o)}
          className="flex items-center justify-between px-4 py-2 text-left text-[13px] font-semibold text-fg hover:bg-surface-2"
        >
          <span>
            What the AI did
            {timeline.data && <span className="ml-2 text-xs font-normal text-muted">{timeline.data.tools.length} tool calls · {timeline.data.events.length} events</span>}
          </span>
          <ChevronDown className={cx('size-4 text-muted transition-transform', !debugOpen && '-rotate-90')} aria-hidden />
        </button>
        {debugOpen && (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            {!conversationId ? (
              <p className="py-4 text-center text-xs text-muted">Send a message to see tool calls, captured details and events here.</p>
            ) : timeline.isLoading ? (
              <Spinner />
            ) : (
              <>
                <TimelineList timeline={timeline.data} newestFirst emptyText="No tool calls yet." />
                <Link to={`/conversations/${conversationId}`} className="mt-2 inline-block text-xs text-accent-text hover:underline">
                  Open in Conversations →
                </Link>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ role, name, content, sources, streaming }: { role: PublicMessage['role']; name: string; content: string; sources?: PublicMessage['sources']; streaming?: boolean }) {
  const mine = role === 'user';
  return (
    <div className={cx('flex flex-col', mine ? 'items-end' : 'items-start')}>
      {!mine && <span className="mb-0.5 pl-1 text-[11px] text-muted">{role === 'agent' ? 'Team' : name}</span>}
      <div
        className={cx(
          'max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap',
          mine ? 'rounded-br-md bg-accent text-accent-fg' : role === 'agent' ? 'rounded-bl-md border border-warning/30 bg-warning-soft text-fg' : 'rounded-bl-md border border-border bg-surface text-fg',
        )}
      >
        {content}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-current align-middle opacity-60" aria-hidden />}
      </div>
      {sources && sources.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5 pl-1">
          {sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noreferrer" className="text-[11px] text-accent-text hover:underline">
              {s.title || s.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
