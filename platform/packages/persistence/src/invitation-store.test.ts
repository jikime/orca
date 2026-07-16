import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import {
  acceptInvitation,
  createInvitation,
  revokeInvitation,
  type AcceptInvitationSubject
} from './invitation-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'
import { withoutTenantContext } from './tenant-transaction'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshOrgWithAdmin(): Promise<{ orgId: string; adminUserId: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `inv-${orgId.slice(0, 8)}`,
    displayName: 'Inv Org'
  })
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: 'https://issuer.test',
    subject: `admin-${orgId.slice(0, 8)}`
  })
  return { orgId, adminUserId: userId }
}

function invitee(email: string): AcceptInvitationSubject {
  return {
    issuer: 'https://issuer.test',
    subject: `invitee-${randomUUID()}`,
    email,
    emailVerified: true,
    displayName: 'Invitee'
  }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED invitation suite: Docker/PostgreSQL unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
}, 180_000)

afterAll(async () => {
  await db?.destroy()
  await harness?.stop()
})

// AUT-004 invitation-replay-cross-tenant-suite
describe('invitation-replay-cross-tenant-suite (AUT-004)', () => {
  it('creates and accepts an invite, membership fixed to the invite role', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'joiner@test',
      userType: 'internal',
      roleIds: ['member']
    })
    const result = await acceptInvitation(db, invitee('joiner@test'), rawToken)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.organizationId).toBe(orgId)
    const membership = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('identity.memberships')
        .select(['role_ids', 'status'])
        .where('id', '=', result.membershipId)
        .executeTakeFirstOrThrow()
    )
    // Role is fixed by the invite, not caller-supplied.
    expect(membership.role_ids).toEqual(['member'])
    expect(membership.status).toBe('active')
  })

  it('rejects a second accept of the same token (single-use replay)', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'once@test',
      userType: 'internal',
      roleIds: ['member']
    })
    expect((await acceptInvitation(db, invitee('once@test'), rawToken)).ok).toBe(true)
    const second = await acceptInvitation(db, invitee('once@test'), rawToken)
    expect(second).toEqual({ ok: false, reason: 'not_pending' })
  })

  it('rejects acceptance by a different email (cross-account replay)', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'target@test',
      userType: 'internal',
      roleIds: ['member']
    })
    const wrong = await acceptInvitation(db, invitee('attacker@test'), rawToken)
    expect(wrong).toEqual({ ok: false, reason: 'email_mismatch' })
  })

  it('rejects an expired invite', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'late@test',
      userType: 'internal',
      roleIds: ['member'],
      expiresInMs: -1000
    })
    expect(await acceptInvitation(db, invitee('late@test'), rawToken)).toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('rejects a revoked invite', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { invitationId, rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'gone@test',
      userType: 'internal',
      roleIds: ['member']
    })
    expect(
      (
        await revokeInvitation(db, {
          organizationId: orgId,
          invitationId,
          actorUserId: adminUserId
        })
      ).outcome
    ).toBe('revoked')
    expect(await acceptInvitation(db, invitee('gone@test'), rawToken)).toEqual({
      ok: false,
      reason: 'not_pending'
    })
  })

  it('stores only the token hash, never the raw token', async (ctx) => {
    if (!harness) return ctx.skip()
    const { orgId, adminUserId } = await freshOrgWithAdmin()
    const { invitationId, rawToken } = await createInvitation(db, {
      organizationId: orgId,
      actorUserId: adminUserId,
      email: 'hash@test',
      userType: 'internal',
      roleIds: ['member']
    })
    const row = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('identity.invitations')
        .select('token_hash')
        .where('id', '=', invitationId)
        .executeTakeFirstOrThrow()
    )
    expect(row.token_hash).not.toBe(rawToken)
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
