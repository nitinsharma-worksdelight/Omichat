import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { API_URL, authHeaders } from "./api";
import { useSse } from "./sse";

type Listener = (event: string, data: unknown) => void;

interface LiveStream {
  connected: boolean;
  subscribe(listener: Listener): () => void;
  /** Called every time the stream (re)connects, so a page can catch up on what it missed. */
  onOpen(fn: () => void): () => void;
}

const LiveStreamContext = createContext<LiveStream | null>(null);

/**
 * One org-wide live connection for the whole dashboard: inbox events, and this member's notifications (org-wide and
 * their own). Pages listen through `useLiveEvents` instead of opening their own, since a browser allows only a few
 * connections per site.
 */
export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const openers = useRef(new Set<() => void>());
  const { connected } = useSse(
    `${API_URL}/v1/stream`,
    authHeaders,
    (event, data) => listeners.current.forEach((l) => l(event, data)),
    { onOpen: () => openers.current.forEach((fn) => fn()) },
  );
  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);
  const onOpen = useCallback((fn: () => void) => {
    openers.current.add(fn);
    return () => void openers.current.delete(fn);
  }, []);
  const value = useMemo(
    () => ({ connected, subscribe, onOpen }),
    [connected, subscribe, onOpen],
  );
  return (
    <LiveStreamContext.Provider value={value}>
      {children}
    </LiveStreamContext.Provider>
  );
}

/** Listens to the dashboard's live stream while mounted; `onOpen` runs on every (re)connect. */
export function useLiveEvents(
  handler: Listener,
  onOpen?: () => void,
): { connected: boolean } {
  const live = useContext(LiveStreamContext);
  if (!live) throw new Error("useLiveEvents outside LiveStreamProvider");
  const handlerRef = useRef(handler);
  const openRef = useRef(onOpen);
  handlerRef.current = handler;
  openRef.current = onOpen;
  useEffect(() => live.subscribe((e, d) => handlerRef.current(e, d)), [live]);
  useEffect(() => live.onOpen(() => openRef.current?.()), [live]);
  return { connected: live.connected };
}
