import { loadEnv } from '../config/env';
import { createLogger } from '../lib/logger';
import { createDatabase } from './client';
import { runMigrations } from './migrate';

const env = loadEnv();
const logger = createLogger(env);
const database = await createDatabase(env.DATABASE_URL, { poolMax: 1 });
try {
  await runMigrations(database);
  logger.info('migrations applied');
} finally {
  await database.close();
}
