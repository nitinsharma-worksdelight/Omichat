import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  send(event: string, data: unknown): void;
  onClose(fn: () => void): void;
  close(): void;
}

/**
 * Server-Sent Events over a hijacked response. Works with EventSource and with fetch()-based readers
 * (which the widget uses so the session token can travel in a header rather than the URL).
 */
export function openSse(req: FastifyRequest, reply: FastifyReply): SseStream {
  const headers = {
    ...(reply.getHeaders() as Record<string, string>),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
  reply.hijack();
  reply.raw.writeHead(200, headers);
  reply.raw.write(': connected\n\n');
  const closers: Array<() => void> = [];
  let closed = false;
  const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closers) fn();
  };
  req.raw.on('close', finish);
  return {
    send(event, data) {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(fn) {
      closers.push(fn);
    },
    close() {
      finish();
      reply.raw.end();
    },
  };
}
