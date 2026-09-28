import { sql } from 'drizzle-orm';
import { isUuid } from '../lib/ids';
import type { Db } from './client';

export const TENANT_ROLE = 'app_tenant';

/**
 * Runs work for one organization inside a short transaction with Postgres RLS engaged:
 * `set_config('app.org_id', …)` scopes every policy, and `SET LOCAL ROLE app_tenant` drops the
 * owner's RLS bypass. Application code still filters by organization_id; RLS is the backstop.
 */
export class TenantDb {
  constructor(
    readonly db: Db,
    private readonly enforceRls = true,
  ) {}

  run<T>(orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!isUuid(orgId)) throw new Error(`Invalid organization id: ${String(orgId)}`);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
      if (this.enforceRls) await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
      return fn(tx as unknown as Db);
    });
  }
}

/** Service calls accept an optional transaction so several changes (and their events) commit together. */
export interface Scope {
  orgId: string;
  tx?: Db;
}

export function inScope<T>(tenantDb: TenantDb, scope: Scope, fn: (tx: Db) => Promise<T>): Promise<T> {
  return scope.tx ? fn(scope.tx) : tenantDb.run(scope.orgId, fn);
}
