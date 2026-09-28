import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import type { Logger } from '../lib/logger';

export type Unsubscribe = () => void;

/** Fan-out of realtime events (AI token deltas, new messages) from workers to API processes holding SSE connections. */
export interface PubSub {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): Unsubscribe;
  close(): Promise<void>;
}

export class MemoryPubSub implements PubSub {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  async publish(channel: string, message: unknown): Promise<void> {
    this.emitter.emit(channel, message);
  }

  subscribe(channel: string, handler: (message: unknown) => void): Unsubscribe {
    this.emitter.on(channel, handler);
    return () => this.emitter.off(channel, handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

export class RedisPubSub implements PubSub {
  private readonly local = new EventEmitter().setMaxListeners(0);
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly logger: Logger,
  ) {
    this.subscriber.on('message', (channel: string, raw: string) => {
      try {
        this.local.emit(channel, JSON.parse(raw));
      } catch (err) {
        this.logger.warn({ err, channel }, 'dropping malformed pubsub message');
      }
    });
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }

  subscribe(channel: string, handler: (message: unknown) => void): Unsubscribe {
    this.local.on(channel, handler);
    const n = (this.counts.get(channel) ?? 0) + 1;
    this.counts.set(channel, n);
    if (n === 1) void this.subscriber.subscribe(channel);
    return () => {
      this.local.off(channel, handler);
      const left = (this.counts.get(channel) ?? 1) - 1;
      if (left <= 0) {
        this.counts.delete(channel);
        void this.subscriber.unsubscribe(channel);
      } else {
        this.counts.set(channel, left);
      }
    };
  }

  async close(): Promise<void> {
    this.local.removeAllListeners();
    await Promise.allSettled([this.subscriber.quit(), this.publisher.quit()]);
  }
}
