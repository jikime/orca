import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The ONLY sanctioned way app code touches tenant tables. Opens a transaction,
 * drops to the `pie_app` role (so RLS applies even if the pool connected as a
 * superset role), binds `pie.organization_id` for the SET LOCAL lifetime, runs
 * `fn`, and commits. The context vanishes at commit so a pooled connection never
 * leaks one tenant's context into the next request (doc 30 :168-169).
 */
export async function withTenantTransaction<T>(
  db: Kysely<Database>,
  organizationId: string,
  fn: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error('withTenantTransaction requires a UUID organizationId')
  }
  return db.transaction().execute(async (trx) => {
    await sql`set local role pie_app`.execute(trx)
    // set_config(..., true) is SET LOCAL; the org id is a bind parameter.
    await sql`select set_config('pie.organization_id', ${organizationId}, true)`.execute(trx)
    return fn(trx)
  })
}

/**
 * Like withTenantTransaction, but ALSO binds `pie.user_id` for per-user RLS. Used by
 * reads/updates of per-user data (notifications) so a policy of `user_id =
 * pie.user_id` restricts a caller to their OWN rows even within their org. Writes
 * that create rows FOR another user (a mention notification) stay on
 * withTenantTransaction — the per-user policies gate only SELECT/UPDATE.
 */
export async function withTenantUserTransaction<T>(
  db: Kysely<Database>,
  organizationId: string,
  userId: string,
  fn: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(userId)) {
    throw new Error('withTenantUserTransaction requires UUID organizationId and userId')
  }
  return db.transaction().execute(async (trx) => {
    await sql`set local role pie_app`.execute(trx)
    await sql`select set_config('pie.organization_id', ${organizationId}, true)`.execute(trx)
    await sql`select set_config('pie.user_id', ${userId}, true)`.execute(trx)
    return fn(trx)
  })
}

/**
 * Worker-side transaction for cross-tenant outbox claiming. Drops to `pie_worker`
 * (its dedicated grant/policy allows the claim without BYPASSRLS) and sets NO org
 * context. Per-org side effects re-enter withTenantTransaction (slice 2).
 */
export async function withWorkerClaimTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set local role pie_worker`.execute(trx)
    return fn(trx)
  })
}

/**
 * Ops / seed / migration path: runs as the connecting (privileged) role with NO
 * tenant role or context. Never use this for user API request handling — it is
 * for bootstrapping and maintenance that legitimately spans tenants.
 */
export async function withoutTenantContext<T>(
  db: Kysely<Database>,
  fn: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute((trx) => fn(trx))
}
