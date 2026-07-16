import { randomBytes, randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { buildResourceChangeCloudEvent } from './resource-change-event'
import { withoutTenantContext } from './tenant-transaction'

// The owner role is fixed manifest vocabulary (roles.json). Provisioning only ever
// grants this one role, so we name it here rather than plumbing it through.
const OWNER_ROLE_ID = 'organization_owner'

export type VerifiedSubject = {
  issuer: string
  subject: string
  email: string
  emailVerified: boolean
  displayName: string
}

export type ProvisionOwnerInput = {
  subject: VerifiedSubject
  organizationDisplayName?: string
}

export type ProvisionOwnerResult = {
  organizationId: string
  userId: string
  membershipId: string
  // True when this call created the org; false when an existing owner org was
  // returned (idempotent replay).
  created: boolean
}

export class EmailNotVerifiedError extends Error {
  constructor() {
    super('provisioning requires an email-verified subject')
    this.name = 'EmailNotVerifiedError'
  }
}

function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32)
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`
}

/**
 * The signup → organization-creation transaction (doc 01 :67-79, ADR-0009 clause
 * 12). In ONE Pie transaction it maps the verified issuer+subject to a UserAccount
 * and creates Organization + owner Membership + audit + outbox. There is NO
 * distributed transaction with Keycloak: idempotency is keyed on issuer+subject —
 * re-provisioning the same subject returns the existing owned org with no
 * duplicates. Runs privileged (no tenant context): it bootstraps a tenant that
 * does not exist yet, and its input is the caller's own verified subject only.
 */
export async function provisionOwner(
  db: Kysely<Database>,
  input: ProvisionOwnerInput
): Promise<ProvisionOwnerResult> {
  if (!input.subject.emailVerified) {
    throw new EmailNotVerifiedError()
  }
  return withoutTenantContext(db, async (trx) => {
    // Map issuer+subject -> user id, creating the account on first sight. email /
    // display_name refresh on replay but are not the authorization identity.
    const account = await trx
      .insertInto('identity.user_accounts')
      .values({
        issuer: input.subject.issuer,
        subject: input.subject.subject,
        email: input.subject.email,
        email_verified: input.subject.emailVerified,
        display_name: input.subject.displayName
      })
      .onConflict((oc) =>
        oc.columns(['issuer', 'subject']).doUpdateSet({
          email: input.subject.email,
          email_verified: input.subject.emailVerified,
          display_name: input.subject.displayName,
          updated_at: sql`now()`
        })
      )
      .returning('id')
      .executeTakeFirstOrThrow()
    const userId = account.id

    // Idempotent replay: if this subject already owns an org, return it untouched.
    const existingOwner = await trx
      .selectFrom('identity.memberships')
      .select(['id', 'organization_id'])
      .where('user_id', '=', userId)
      .where(sql<boolean>`${OWNER_ROLE_ID} = any(role_ids)`)
      .where('status', '=', 'active')
      .executeTakeFirst()
    if (existingOwner) {
      return {
        organizationId: existingOwner.organization_id,
        userId,
        membershipId: existingOwner.id,
        created: false
      }
    }

    const organizationId = randomUUID()
    const displayName =
      input.organizationDisplayName?.trim() || `${input.subject.displayName}의 조직`
    const occurredAt = new Date().toISOString()
    await trx
      .insertInto('identity.organizations')
      .values({ id: organizationId, slug: slugify(displayName), display_name: displayName })
      .execute()

    const membership = await trx
      .insertInto('identity.memberships')
      .values({
        organization_id: organizationId,
        user_id: userId,
        status: 'active',
        role_ids: [OWNER_ROLE_ID]
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: organizationId,
        actor_id: userId,
        action: 'organization.provisioned',
        target_type: 'organization',
        target_id: organizationId
      })
      .execute()

    // Emit an organization.created change so the Worker → Realtime path delivers
    // it with no new plumbing (reuses the slice-2 outbox vertical).
    const outboxId = randomUUID()
    const cloudEvent = buildResourceChangeCloudEvent({
      organizationId,
      eventId: outboxId,
      resourceType: 'organization',
      resourceId: organizationId,
      changeKind: 'created',
      version: 1,
      occurredAt
    })
    await trx
      .insertInto('operations.outbox_events')
      .values({
        id: outboxId,
        organization_id: organizationId,
        aggregate_type: 'organization',
        aggregate_id: organizationId,
        aggregate_version: 1,
        event_type: cloudEvent.type,
        event_schema_version: 1,
        payload: JSON.stringify(cloudEvent),
        occurred_at: occurredAt,
        available_at: occurredAt
      })
      .execute()

    return { organizationId, userId, membershipId: membership.id, created: true }
  })
}
