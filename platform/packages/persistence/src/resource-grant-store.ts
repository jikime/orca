import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import type { ResourceGrantInput } from './permission-evaluator'
import { withTenantTransaction } from './tenant-transaction'

export type CreateResourceGrantInput = {
  organizationId: string
  userId: string
  resourceType: string
  resourceId: string
  grantKind: 'narrow' | 'widen'
  permission: string
}

/** Creates a resource grant (narrow/widen) for a user on a specific resource. */
export async function createResourceGrant(
  db: Kysely<Database>,
  input: CreateResourceGrantInput
): Promise<string> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('identity.resource_grants')
      .values({
        organization_id: input.organizationId,
        user_id: input.userId,
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        grant_kind: input.grantKind,
        permission: input.permission
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    return row.id
  })
}

/**
 * Lists a user's resource grants in an org as evaluator inputs. R4's resource-
 * scoped operations (projects, work items, ...) will be the first real callers;
 * they resolve the caller's grants and pass them to evaluatePermission.
 */
export async function listResourceGrantsForUser(
  db: Kysely<Database>,
  organizationId: string,
  userId: string
): Promise<ResourceGrantInput[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('identity.resource_grants')
      .select(['grant_kind', 'resource_type', 'resource_id', 'permission'])
      .where('user_id', '=', userId)
      .execute()
    return rows.map((row) => ({
      grantKind: row.grant_kind === 'widen' ? 'widen' : 'narrow',
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      permission: row.permission
    }))
  })
}
