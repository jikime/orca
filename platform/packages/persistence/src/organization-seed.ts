import type { Kysely } from 'kysely'
import type { Database } from './database-schema'
import { withoutTenantContext } from './tenant-transaction'

export type OrganizationSeedInput = {
  id: string
  slug: string
  displayName: string
  version?: number
  status?: 'active' | 'suspended' | 'archived'
}

// Dev/test fixture aligned with contracts/fixtures/valid/organization.json.
export const DEFAULT_ORGANIZATION_FIXTURE: OrganizationSeedInput = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'kaon-soft-lab',
  displayName: 'Kaon Soft Lab',
  version: 1,
  status: 'active'
}

export type OrganizationSeedResult = {
  id: string
  inserted: boolean
}

/**
 * Idempotently seeds a temp organization fixture. Runs without tenant context
 * (organizations is the tenant root — it cannot be created inside a tenant) and
 * is a dev/test fixture loader, not a public endpoint. Re-running is a no-op.
 */
export async function seedOrganizationFixture(
  db: Kysely<Database>,
  input: OrganizationSeedInput = DEFAULT_ORGANIZATION_FIXTURE
): Promise<OrganizationSeedResult> {
  return withoutTenantContext(db, async (trx) => {
    const result = await trx
      .insertInto('identity.organizations')
      .values({
        id: input.id,
        slug: input.slug,
        display_name: input.displayName,
        status: input.status ?? 'active',
        version: input.version ?? 1
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst()
    return { id: input.id, inserted: (result?.numInsertedOrUpdatedRows ?? 0n) > 0n }
  })
}

/** Dev/test fixture: assigns a plan to an org (a subscription row). Enables
 *  entitlement enforcement for that org. */
export async function seedSubscriptionFixture(
  db: Kysely<Database>,
  input: { organizationId: string; planId: string; deploymentType?: string }
): Promise<void> {
  await withoutTenantContext(db, (trx) =>
    trx
      .insertInto('identity.subscriptions')
      .values({
        organization_id: input.organizationId,
        plan_id: input.planId,
        deployment_type: input.deploymentType ?? 'saas'
      })
      .onConflict((oc) => oc.column('organization_id').doUpdateSet({ plan_id: input.planId }))
      .execute()
  )
}

export type MembershipSeedInput = {
  organizationId: string
  issuer: string
  subject: string
  roleIds?: string[]
  email?: string
  displayName?: string
}

export type MembershipSeedResult = {
  userId: string
  membershipId: string
}

/**
 * Dev/test fixture: maps an issuer+subject to a UserAccount and grants an active
 * membership (owner role by default) in the given org. Runs privileged (org root +
 * global user account). Idempotent on (issuer, subject) and (org, user).
 */
export async function seedMembershipFixture(
  db: Kysely<Database>,
  input: MembershipSeedInput
): Promise<MembershipSeedResult> {
  return withoutTenantContext(db, async (trx) => {
    const account = await trx
      .insertInto('identity.user_accounts')
      .values({
        issuer: input.issuer,
        subject: input.subject,
        email: input.email ?? `${input.subject}@test`,
        email_verified: true,
        display_name: input.displayName ?? 'Test Member'
      })
      .onConflict((oc) => oc.columns(['issuer', 'subject']).doUpdateSet({ email_verified: true }))
      .returning('id')
      .executeTakeFirstOrThrow()
    const membership = await trx
      .insertInto('identity.memberships')
      .values({
        organization_id: input.organizationId,
        user_id: account.id,
        status: 'active',
        role_ids: input.roleIds ?? ['organization_owner']
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'user_id']).doUpdateSet({
          status: 'active',
          role_ids: input.roleIds ?? ['organization_owner']
        })
      )
      .returning('id')
      .executeTakeFirstOrThrow()
    return { userId: account.id, membershipId: membership.id }
  })
}
