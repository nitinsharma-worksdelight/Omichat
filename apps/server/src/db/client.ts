import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
/** A database or transaction handle. Drizzle transactions are PgDatabase instances too. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface Database {
  db: Db;
  kind: 'pg' | 'pglite';
  migrate(migrationsFolder: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  poolMax?: number;
}

/**
 * `postgres://…` → node-postgres pool (Supabase: use the pooler URL in transaction mode).
 * `pglite://<dir>` → embedded Postgres (WASM) persisted in <dir>; `pglite://memory` → in-memory.
 */
export async function createDatabase(url: string, opts: DatabaseOptions = {}): Promise<Database> {
  if (url.startsWith('pglite://')) {
    const location = url.slice('pglite://'.length);
    const inMemory = location === '' || location === 'memory';
    const dataDir = inMemory ? undefined : path.resolve(location);
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      acquirePgliteLock(dataDir);
    }
    // Loaded lazily so production (real Postgres) never pulls in the WASM build.
    const [{ PGlite }, { btree_gist }, { vector }, { drizzle: drizzlePglite }, { migrate: migratePglite }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/contrib/btree_gist'),
      import('@electric-sql/pglite-pgvector'),
      import('drizzle-orm/pglite'),
      import('drizzle-orm/pglite/migrator'),
    ]);
    const client = await PGlite.create({ dataDir, extensions: { vector, btree_gist } });
    const db = drizzlePglite({ client, schema, casing: 'snake_case' }) as unknown as Db;
    return {
      db,
      kind: 'pglite',
      migrate: (migrationsFolder) => migratePglite(db as never, { migrationsFolder }),
      close: async () => {
        await client.close();
        if (dataDir) releasePgliteLock(dataDir);
      },
    };
  }
  const pool = new pg.Pool({ connectionString: url, max: opts.poolMax ?? 10 });
  const db = drizzlePg({ client: pool, schema, casing: 'snake_case' }) as unknown as Db;
  return {
    db,
    kind: 'pg',
    migrate: (migrationsFolder) => migratePg(db as never, { migrationsFolder }),
    close: () => pool.end(),
  };
}

/**
 * PGlite is a single-process database: two processes on one data directory silently overwrite each
 * other's pages. Refuse to open a directory another live process holds.
 */
function acquirePgliteLock(dataDir: string): void {
  const lockFile = path.join(dataDir, '.omni.lock');
  try {
    const holder = Number(readFileSync(lockFile, 'utf8'));
    if (holder && holder !== process.pid) {
      let alive = true;
      try {
        process.kill(holder, 0);
      } catch {
        alive = false;
      }
      if (alive) {
        throw new Error(
          `The local database ${dataDir} is already open in process ${holder}. Stop that process, or give this one its own DATABASE_URL (e.g. pglite://.data/other).`,
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  writeFileSync(lockFile, String(process.pid));
  process.once('exit', () => releasePgliteLock(dataDir));
}

function releasePgliteLock(dataDir: string): void {
  try {
    const lockFile = path.join(dataDir, '.omni.lock');
    if (Number(readFileSync(lockFile, 'utf8')) === process.pid) rmSync(lockFile);
  } catch {
    // already gone
  }
}

/** Rows from `db.execute()`, which returns driver-specific result objects that both expose `.rows`. */
export function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export { schema };
