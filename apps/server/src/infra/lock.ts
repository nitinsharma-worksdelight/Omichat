import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sleep } from '../lib/async';

export interface LockOptions {
  /** How long the lock is held before it expires on its own (crash safety). */
  ttlMs: number;
  /** How long to wait for the lock before giving up. */
  waitMs: number;
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Could not acquire lock ${key}`);
    this.name = 'LockTimeoutError';
  }
}

export interface LockService {
  /** Runs `fn` while holding the lock. `signal` fires if the lock is lost before `fn` finishes. */
  withLock<T>(key: string, opts: LockOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** In-process locks (development and tests). They can't be lost, so the signal never fires. */
export class MemoryLockService implements LockService {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, opts: LockOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    const acquired = await Promise.race([previous.then(() => true), sleep(opts.waitMs).then(() => false)]);
    if (!acquired) {
      // Keep the chain intact: release our slot as soon as the previous holder finishes.
      void previous.then(release);
      throw new LockTimeoutError(key);
    }
    try {
      return await fn(new AbortController().signal);
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
const EXTEND_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

export class RedisLockService implements LockService {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'omni:lock:',
  ) {}

  /**
   * Holds the lock for as long as `fn` runs: the TTL is renewed every third of itself, so it only lapses when the
   * process dies (and then frees within one TTL). If a renewal fails — Redis unreachable, or the key now belongs
   * to someone else — `signal` fires so the work can stop before acting on a lock it no longer holds.
   */
  async withLock<T>(key: string, opts: LockOptions, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const redisKey = this.prefix + key;
    const token = randomUUID();
    const deadline = Date.now() + opts.waitMs;
    for (;;) {
      const ok = await this.redis.set(redisKey, token, 'PX', opts.ttlMs, 'NX');
      if (ok === 'OK') break;
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await sleep(100);
    }
    const lost = new AbortController();
    const renew = setInterval(() => {
      this.redis.eval(EXTEND_SCRIPT, 1, redisKey, token, String(opts.ttlMs)).then(
        (extended) => {
          if (extended !== 1) loseLock();
        },
        () => loseLock(),
      );
    }, Math.max(10, Math.floor(opts.ttlMs / 3)));
    const loseLock = () => {
      clearInterval(renew);
      if (!lost.signal.aborted) lost.abort(new Error(`Lost lock ${key}`));
    };
    try {
      return await fn(lost.signal);
    } finally {
      clearInterval(renew);
      await this.redis.eval(RELEASE_SCRIPT, 1, redisKey, token);
    }
  }
}
