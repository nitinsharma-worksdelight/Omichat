import path from 'node:path';
import type { Database } from './client';

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle');
}

export async function runMigrations(database: Database, dir = defaultMigrationsDir()): Promise<void> {
  await database.migrate(dir);
}
