const TRANSIENT_CODES = new Set([
  // Network
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  // Postgres: connection trouble, shutdown or restart, deadlock, serialization failure, out of connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '40001',
  '40P01',
  '53300',
  '53400',
  '57P01',
  '57P02',
  '57P03',
]);
const TRANSIENT_MESSAGE = /connection terminated|connection timeout|timeout exceeded when trying to connect|client has encountered a connection error|too many clients/i;

/** A failure that a retry may well get past (the database or network blinked), not one the same input will repeat. */
export function isTransientError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    if (e instanceof Error && TRANSIENT_MESSAGE.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
