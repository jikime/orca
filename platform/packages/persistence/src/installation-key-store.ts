import type { Kysely, Transaction } from 'kysely'
import type { Database } from './database-schema'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 2b: the per-installation Ed25519 PUBLIC key registry (doc 24 anti-forgery). The
// producer registers its public key so the Control Plane can verify signed ExecutionContexts.
// One row per (org, user, installation); a re-register ROTATES the row in place — the
// verification path always reads the current key, and rotation_count/updated_at make a rotation
// auditable. Registration + its audit row commit in ONE tenant tx (RLS-scoped to the org).

export type InstallationPublicKeyRow = {
  id: string
  user_id: string
  installation_id: string
  public_key: string
  public_key_id: string
  rotation_count: number
}

export type RegisterInstallationKeyInput = {
  organizationId: string
  userId: string
  installationId: string
  publicKeyPem: string
  publicKeyId: string
}

/**
 * Upserts the producer's installation public key on (org, user, installation): a first
 * registration inserts (rotation_count 0), a re-register with a different key rotates the row
 * (public_key/public_key_id replaced, rotation_count bumped, updated_at stamped). Writes an
 * audit `installation_key.registered` row (after_digest = the fingerprint) so a rotation is
 * traceable. Returns the row id and whether this call rotated an existing key.
 */
export async function registerInstallationKey(
  db: Kysely<Database>,
  input: RegisterInstallationKeyInput
): Promise<{ id: string; rotated: boolean }> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const existing = await trx
      .selectFrom('execution.installation_public_keys')
      .select(['id', 'rotation_count'])
      .where('user_id', '=', input.userId)
      .where('installation_id', '=', input.installationId)
      .executeTakeFirst()
    const rotated = existing !== undefined
    const row = await trx
      .insertInto('execution.installation_public_keys')
      .values({
        organization_id: input.organizationId,
        user_id: input.userId,
        installation_id: input.installationId,
        public_key: input.publicKeyPem,
        public_key_id: input.publicKeyId
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'user_id', 'installation_id']).doUpdateSet((eb) => ({
          public_key: input.publicKeyPem,
          public_key_id: input.publicKeyId,
          updated_at: new Date(),
          // A conflict means a rotation: advance the counter off the stored value.
          rotation_count: eb('execution.installation_public_keys.rotation_count', '+', 1)
        }))
      )
      .returning('id')
      .executeTakeFirstOrThrow()
    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: input.organizationId,
        actor_id: input.userId,
        action: 'installation_key.registered',
        target_type: 'installation_key',
        target_id: row.id,
        after_digest: input.publicKeyId
      })
      .execute()
    return { id: row.id, rotated }
  })
}

/**
 * Loads the registered key for (user, installation) in the current tenant tx. Org scope comes
 * from RLS, so a key registered in another org is invisible here (null) — cross-tenant key
 * isolation for free. Returns null when no key is registered.
 */
export async function loadInstallationKeyTx(
  trx: Transaction<Database>,
  input: { userId: string; installationId: string }
): Promise<InstallationPublicKeyRow | null> {
  const row = await trx
    .selectFrom('execution.installation_public_keys')
    .select(['id', 'user_id', 'installation_id', 'public_key', 'public_key_id', 'rotation_count'])
    .where('user_id', '=', input.userId)
    .where('installation_id', '=', input.installationId)
    .executeTakeFirst()
  return row ? { ...row, rotation_count: Number(row.rotation_count) } : null
}
