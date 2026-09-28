import { describe, expect, it } from 'vitest';
import { LockTimeoutError, RedisLockService } from '../src/infra/lock';

/** The few Redis commands the lock uses, in memory and with real expiry times. */
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(key: string, value: string, _px: 'PX', ttlMs: number, _nx: 'NX') {
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  /** Stands in for the lock's two Lua scripts: extend (pexpire) and release (del), both only for the holder. */
  async eval(script: string, _numKeys: number, key: string, token: string, ttlMs?: string) {
    const entry = this.live(key);
    if (!entry || entry.value !== token) return 0;
    if (script.includes('pexpire')) {
      entry.expiresAt = Date.now() + Number(ttlMs);
      return 1;
    }
    this.store.delete(key);
    return 1;
  }

  /** Another process takes the key, as if our lock had expired. */
  steal(key: string) {
    this.store.set(key, { value: 'someone-else', expiresAt: Date.now() + 60_000 });
  }

  has(key: string) {
    return Boolean(this.live(key));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Redis conversation lock', () => {
  it('renews itself while the work runs, so nobody else gets in, and releases at the end', async () => {
    const redis = new FakeRedis();
    const locks = new RedisLockService(redis as never);
    const work = locks.withLock('conv_1', { ttlMs: 90, waitMs: 1_000 }, async () => {
      await sleep(300);
      return 'done';
    });
    await sleep(150); // well past the 90 ms TTL
    await expect(locks.withLock('conv_1', { ttlMs: 90, waitMs: 50 }, async () => 'second')).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(work).resolves.toBe('done');
    expect(redis.has('omni:lock:conv_1')).toBe(false);
  });

  it('tells the work when the lock is lost', async () => {
    const redis = new FakeRedis();
    const locks = new RedisLockService(redis as never);
    const work = locks.withLock('conv_2', { ttlMs: 90, waitMs: 1_000 }, async (signal) => {
      await sleep(200);
      return signal.aborted;
    });
    await sleep(10);
    redis.steal('omni:lock:conv_2');
    await expect(work).resolves.toBe(true);
    // Releasing never deletes a lock someone else now holds.
    expect(redis.has('omni:lock:conv_2')).toBe(true);
  });
});
