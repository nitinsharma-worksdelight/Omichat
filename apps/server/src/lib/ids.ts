import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

/** Time-ordered UUIDs keep B-tree indexes append-mostly. */
export const newId = (): string => uuidv7();

/** URL-safe random token with a readable prefix, e.g. `pk_…`, `sk_…`. */
export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
