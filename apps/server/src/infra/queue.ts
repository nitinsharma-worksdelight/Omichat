import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
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
  /**
   * Deduplication key: while a job with this id exists — waiting, delayed, retrying, running, or kept after its last
   * attempt failed — adding another is a no-op (BullMQ's rule). No ':' allowed.
   */
  jobId?: string;
  attempts?: number;
  backoffMs?: number;
  /** Forget the job id when its last attempt fails, so the same id can be queued again. */
  removeOnFail?: boolean;
  /**
   * A nudge that only needs "run once more soon" (requires `jobId`): adds merge while one is waiting, and an add while
   * one is running queues the next run. Never blocked by an earlier failure.
   */
  coalesce?: boolean;
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
/** Failed jobs BullMQ keeps per queue (their ids stay taken). */
const KEEP_FAILED = 5_000;

/**
 * In-process queue for local development and tests, with BullMQ's semantics where callers depend on them: delays,
 * retries with exponential backoff, and job ids that stay taken while a job waits, retries or runs, and after its last
 * attempt fails (unless `removeOnFail`). Coalesced nudges merge only while waiting.
 */
export class InlineQueueDriver implements QueueDriver {
  private readonly handlers = new Map<QueueName, JobHandler<any>>();
  /** Job ids currently taken: queued, retrying, running, or kept after failing. */
  private readonly takenIds = new Set<string>();
  /** Failed job ids in the order they failed, to forget the oldest past KEEP_FAILED. */
  private readonly failedIds: string[] = [];
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
    if (opts.coalesce && !opts.jobId) throw new Error('A coalesced job needs a jobId');
    const id = opts.jobId ? `${queue}/${opts.jobId}` : `${queue}/auto-${++this.seq}`;
    if (this.takenIds.has(id)) return;
    if (!this.handlers.has(queue)) {
      this.backlog.push({ queue, data, opts });
      return;
    }
    this.takenIds.add(id);
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
    // A coalesced nudge frees its id as it starts, so a nudge during the run queues the next one.
    if (opts.coalesce && attempt === 1) this.takenIds.delete(id);
    try {
      await this.handlers.get(queue)!(data, { jobId: id, attempt, maxAttempts });
      if (!opts.coalesce) this.takenIds.delete(id);
    } catch (err) {
      if (attempt < maxAttempts) {
        const backoff = (opts.backoffMs ?? DEFAULT_BACKOFF_MS) * 2 ** (attempt - 1);
        this.logger.warn({ err, queue, id, attempt }, 'job failed, retrying');
        this.track(this.run(queue, id, data, opts, attempt + 1, backoff));
      } else {
        this.logger.error({ err, queue, id, attempt }, 'job failed permanently');
        if (!opts.coalesce && !opts.removeOnFail) this.keepFailed(id);
        else if (!opts.coalesce) this.takenIds.delete(id);
      }
    }
  }

  /** Like BullMQ, a failed job is kept (its id stays taken) until KEEP_FAILED newer failures push it out. */
  private keepFailed(id: string) {
    this.failedIds.push(id);
    while (this.failedIds.length > KEEP_FAILED) this.takenIds.delete(this.failedIds.shift()!);
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

/** Job names of coalesced nudges: the prefix, then their base job id. */
const COALESCED = 'coalesced/';

export class BullQueueDriver implements QueueDriver {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private redis?: Redis;

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

  /** Holds the generation number of a coalesced nudge (job ids can't contain ':', so no job key looks like this). */
  private generationKey(queue: QueueName, jobId: string) {
    return `${this.prefix}:${queue}:coalesce:${jobId}`;
  }

  private client(): Redis {
    this.redis ??= new Redis(this.redisUrl, { maxRetriesPerRequest: 3 });
    return this.redis;
  }

  async add<T>(queue: QueueName, data: T, opts: JobOptions = {}): Promise<void> {
    let jobId = opts.jobId;
    let name: string = queue;
    if (opts.coalesce) {
      if (!opts.jobId) throw new Error('A coalesced job needs a jobId');
      // Each run bumps the generation before it starts, so an add during a run gets a new id and queues the next run.
      // An add that read the old generation just before the bump came before the run read anything.
      const generation = (await this.client().get(this.generationKey(queue, opts.jobId))) ?? '0';
      jobId = `${opts.jobId}-g${generation}`;
      name = `${COALESCED}${opts.jobId}`;
    }
    await this.queue(queue).add(name, data, {
      jobId,
      delay: opts.delayMs,
      attempts: opts.attempts ?? DEFAULT_ATTEMPTS,
      backoff: { type: 'exponential', delay: opts.backoffMs ?? DEFAULT_BACKOFF_MS },
      removeOnComplete: true,
      // A kept failed job keeps its id taken, so jobs that must be re-queued after failing are removed instead.
      removeOnFail: opts.coalesce || opts.removeOnFail ? true : { count: KEEP_FAILED },
    });
  }

  process<T>(queue: QueueName, handler: JobHandler<T>, opts: { concurrency?: number } = {}): void {
    const worker = new Worker(
      queue,
      async (job: Job) => {
        if (job.name.startsWith(COALESCED) && job.attemptsMade === 0) {
          await this.client().incr(this.generationKey(queue, job.name.slice(COALESCED.length)));
        }
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
    await this.redis?.quit();
  }
}
