import { and, eq, gte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { schema } from '../../db/client';
import type { TenantDb } from '../../db/tenant';

/**
 * AI spend (USD) this calendar month in the organization's timezone, from the recorded runs: replies and summaries
 * alike, Test chats included (it's real spend).
 */
export async function monthSpendUsd(tenantDb: TenantDb, orgId: string, timezone: string, now: Date = new Date()): Promise<number> {
  const monthStart = DateTime.fromJSDate(now, { zone: timezone }).startOf('month').toJSDate();
  const [row] = await tenantDb.run(orgId, (tx) =>
    tx
      .select({ total: sql<string>`coalesce(sum(${schema.aiRuns.costUsd}), 0)` })
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.organizationId, orgId), gte(schema.aiRuns.createdAt, monthStart))),
  );
  return Number(row?.total ?? 0);
}
