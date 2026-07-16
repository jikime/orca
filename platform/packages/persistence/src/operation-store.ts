import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// Shape of contracts/schemas/resources/operation.v1.
export type OperationResource = {
  id: string
  organizationId: string
  kind: string
  status: string
  resultResourceId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Reads an operation within a tenant context (RLS-scoped). getOperation has no
 * org in the URL and no authn yet (R3): the caller supplies the org as an authn
 * stand-in, and RLS ensures the operation must belong to that org or it is unseen.
 */
export async function getOperationForTenant(
  db: Kysely<Database>,
  organizationId: string,
  operationId: string
): Promise<OperationResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('operations.operations')
      .selectAll()
      .where('id', '=', operationId)
      .executeTakeFirst()
    if (!row) {
      return null
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      kind: row.kind,
      status: row.status,
      resultResourceId: row.result_resource_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    }
  })
}
