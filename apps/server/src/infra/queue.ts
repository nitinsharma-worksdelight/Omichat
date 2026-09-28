import { Queue, Worker, type Job } from 'bullmq';
import type { Logger } from '../lib/logger';

export type QueueName =
  | 'ai-reply'
  | 'ingest'
  | 'summary'
  | 'events'
  | 'webhook-delivery'
  | 'notification'
  | 'workflow'
  | 'appointment-email';

export interface JobOptions {
  delayMs?: number;
  /** Deduplication key: while a job with this id exists, adding another is a no-op. No ':' allowed. */
  jobId?: string;
  attempts?: number;
  backoffMs?: number;
}

export interface JobMeta {
  jobId: string;
  attempt: number;
  maxAttempts: number;
}

export type JobHandler<T = unknown> = (data: T, meta: JobMeta) => Promise<void>;

export interface QueueDriver {
  add<T>(queue: QueueName, data: T, opts?: JobOptions): Promise<void>;
  process<T>(queue: QueueName, handler: JobHandler<T>, opts?: { concurrency?: number }): void;
  /** Resolves once every queued/delayed job (including retries) has finished. Inline driver only. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 2_000;

/**
 * In-process queue for local development and tests. Same semantics that matter to callers:
 * delays, jobId dedupe while pending, retries with exponential backoff.
 */
export class InlineQueueDriver implements QueueDriver {
  private readonly handlers = new Map<QueueName, JobHandler<any>>();
  private readonly pendingIds = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly backlog: Array<{ queue: QueueName; data: unknown; opts: JobOptions }> = [];
  private closed = false;
  private seq = 0;

  constructor(
    private readonly logger: Logger,
    private readonly opts: { timeScale?: number } = {},
  ) {}

  async add<T>(queue: QueueName, data: T, opts: JobOptions = {}): Promise<void> {
    if (this.closed) return;
    const id = opts.jobId ? `${queue}/${opts.jobId}` : `${queue}/auto-${++this.seq}`;
    if (this.pendingIds.has(id)) return;
    if (!this.handlers.has(queue)) {
      this.backlog.push({ queue, data, opts });
      return;
    }
    this.pendingIds.add(id);
    this.track(this.run(queue, id, data, opts, 1, opts.delayMs ?? 0));
  }

  process<T>(queue: QueueName, handler: JobHandler<T>): void {
    this.handlers.set(queue, handler as JobHandler<any>);
    const waiting = this.backlog.filter((j) => j.queue === queue);
    for (const job of waiting) {
      this.backlog.splice(this.backlog.indexOf(job), 1);
      void this.add(job.queue, job.data, job.opts);
    }
  }

  private track(p: Promise<void>) {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async run(queue: QueueName, id: string, data: unknown, opts: JobOptions, attempt: number, delayMs: number) {
    const scaled = Math.round(delayMs * (this.opts.timeScale ?? 1));
    await new Promise((r) => setTimeout(r, scaled));
    if (this.closed) return;
    const maxAttempts = opts.attempts ?? DEFAULT_ATTEMPTS;
    // Dedupe applies to waiting/delayed jobs; once running, a new job with the same id may be queued.
    if (attempt === 1) this.pendingIds.delete(id);
    try {
      await this.handlers.get(queue)!(data, { jobId: id, attempt, maxAttempts });
    } catch (err) {
      if (attempt < maxAttempts) {
        const backoff = (opts.backoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** (attempt - 1);
        this.logger.warn({ err, queue, id, attempt }, 'job failed, retrying');
        this.track(this.run(queue, id, data, opts, attempt + 1, backoff));
      } else {
        this.logger.error({ err, queue, id, attempt }, 'job failed permanently');
      }
    }
  }

  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class BullQueueDriver implements QueueDriver {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(
    private readonly redisUrl: string,
    private readonly logger: Logger,
    private readonly prefix = 'omni',
  ) {}

  private connection() {
    return { url: this.redisUrl, maxRetriesPerRequest: null };
  }

  private queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection(), prefix: this.prefix });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T>(queue: QueueName, data: T, opts: JobOptions = {}): Promise<void> {
    await this.queue(queue).add(queue, data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: opts.backoffMs ?? DEFAULT_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: { count: 5_000 },
    });
  }

  process<T>(queue: QueueName, handler: JobHandler<T>, opts: { concurrency?: number } = {}): void {
    const worker = new Worker(
      queue,
      async (job: Job) => {
        await handler(job.data as T, {
          jobId: job.id ?? '',
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
      },
      { connection: this.connection(), prefix: this.prefix, concurrency: opts.concurrency ?? 5 },
    );
    worker.on('failed', (job, err) =>
      this.logger.error({ err, queue, jobId: job?.id, attempt: job?.attemptsMade }, 'job failed'),
    );
    this.workers.push(worker);
  }

  async drain(): Promise<void> {
    // Not meaningful across processes; tests use the inline driver.
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
