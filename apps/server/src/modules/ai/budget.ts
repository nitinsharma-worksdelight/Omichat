import { and, eq, gte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { schema } from '../../db/client';
import type { TenantDb } from '../../db/tenant';

/** AI spend (USD) this calendar month (UTC), from the recorded runs: replies and summaries alike. */
export async function monthSpendUsd(tenantDb: TenantDb, orgId: string): Promise<number> {
  const monthStart = DateTime.utc().startOf('month').toJSDate();
  const [row] = await tenantDb.run(orgId, (tx) =>
    tx
      .select({ total: sql<string>`coalesce(sum(${schema.aiRuns.costUsd}), 0)` })
      .from(schema.aiRuns)
      .where(and(eq(schema.aiRuns.organizationId, orgId), gte(schema.aiRuns.createdAt, monthStart))),
  );
  return Number(row?.total ?? 0);
}
