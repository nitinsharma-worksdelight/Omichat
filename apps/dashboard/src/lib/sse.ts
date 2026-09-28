import { useEffect, useRef, useState } from 'react';
import { ApiError, handleUnauthorized } from './api';

export type SseHandler = (event: string, data: unknown) => void;

/**
 * Reads a Server-Sent Events stream with fetch() so an Authorization header can be sent
 * (EventSource can't). Resolves when the server closes the stream; rejects on HTTP errors
 * or network failure. `onOpen` fires once the response headers arrive.
 */
export async function streamSse(
  url: string,
  headers: Record<string, string>,
  onEvent: SseHandler,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal, cache: 'no-store' });
  if (!res.ok || !res.body) {
    let message = `Stream failed (HTTP ${res.status})`;
    let code = 'stream_error';
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      message = body.error?.message ?? message;
      code = body.error?.code ?? code;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, code, message);
  }
  onOpen?.();

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // Normalise line endings, but keep a trailing "\r" until we know whether "\n" follows.
      buffer = buffer.replace(/\r\n|\r(?!$)/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchFrame(frame, onEvent);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatchFrame(frame: string, onEvent: SseHandler): void {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comments / heartbeats
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return;
  const raw = data.join('\n');
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // plain-text payload
  }
  onEvent(event, parsed);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export interface UseSseOptions {
  /** Called for each (re)connection — use it to fetch anything missed while disconnected. */
  onOpen?: () => void;
  /** 'dashboard' logs the user out on 401; 'widget' just stops. */
  kind?: 'dashboard' | 'widget';
}

/**
 * Keeps an SSE stream open while `url` is set, reconnecting with backoff.
 * Handlers are read from refs, so passing new closures does not reconnect.
 */
export function useSse(url: string | null, getHeaders: () => Record<string, string>, onEvent: SseHandler, opts: UseSseOptions = {}) {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  const headersRef = useRef(getHeaders);
  const openRef = useRef(opts.onOpen);
  handlerRef.current = onEvent;
  headersRef.current = getHeaders;
  openRef.current = opts.onOpen;
  const kind = opts.kind ?? 'dashboard';

  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    let attempt = 0;
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          await streamSse(
            url,
            headersRef.current(),
            (e, d) => handlerRef.current(e, d),
            ctrl.signal,
            () => {
              attempt = 0;
              setConnected(true);
              openRef.current?.();
            },
          );
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            setConnected(false);
            if (err.status === 401 && kind === 'dashboard') handleUnauthorized();
            return; // not retryable
          }
        }
        setConnected(false);
        if (ctrl.signal.aborted) return;
        const delay = Math.min(1000 * 2 ** attempt, 15_000);
        attempt += 1;
        await sleep(delay, ctrl.signal);
      }
    })();
    return () => {
      ctrl.abort();
      setConnected(false);
    };
  }, [url, kind]);

  return { connected };
}
