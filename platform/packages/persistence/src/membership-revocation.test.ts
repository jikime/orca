import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import { authorizeSubjectForOrg } from './authorize-request'
import { revokeMembership } from './membership-revocation'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>
const ISSUER = 'https://issuer.test'

async function freshOrg(): Promise<string> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `rev-${orgId.slice(0, 8)}`,
    displayName: 'Rev'
  })
  return orgId
}

async function addMember(orgId: string, subject: string, roleIds: string[]): Promise<string> {
  const { userId } = await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: ISSUER,
    subject,
    roleIds
  })
  return userId
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED last-owner suite: Docker/PostgreSQL unavailable — ${String(error)}`)
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

// TEN-005 last-owner-concurrency-suite
describe('last-owner-concurrency-suite (TEN-005)', () => {
  it('blocks removal of the last organization owner', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const owner = await addMember(orgId, `owner-${orgId.slice(0, 8)}`, ['organization_owner'])
    const result = await revokeMembership(db, {
      organizationId: orgId,
      targetUserId: owner,
      actorUserId: owner
    })
    expect(result.outcome).toBe('last_owner_blocked')
  })

  it('allows removing an owner when another owner remains, then blocks the last', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const ownerA = await addMember(orgId, `a-${orgId.slice(0, 8)}`, ['organization_owner'])
    const ownerB = await addMember(orgId, `b-${orgId.slice(0, 8)}`, ['organization_owner'])
    expect(
      (
        await revokeMembership(db, {
          organizationId: orgId,
          targetUserId: ownerA,
          actorUserId: ownerB
        })
      ).outcome
    ).toBe('revoked')
    expect(
      (
        await revokeMembership(db, {
          organizationId: orgId,
          targetUserId: ownerB,
          actorUserId: ownerB
        })
      ).outcome
    ).toBe('last_owner_blocked')
  })

  it('two concurrent last-owner removals: exactly one succeeds', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const ownerA = await addMember(orgId, `ca-${orgId.slice(0, 8)}`, ['organization_owner'])
    const ownerB = await addMember(orgId, `cb-${orgId.slice(0, 8)}`, ['organization_owner'])
    const [ra, rb] = await Promise.all([
      revokeMembership(db, { organizationId: orgId, targetUserId: ownerA, actorUserId: ownerA }),
      revokeMembership(db, { organizationId: orgId, targetUserId: ownerB, actorUserId: ownerB })
    ])
    const revoked = [ra, rb].filter((r) => r.outcome === 'revoked')
    const blocked = [ra, rb].filter((r) => r.outcome === 'last_owner_blocked')
    expect(revoked).toHaveLength(1)
    expect(blocked).toHaveLength(1)
  })

  it('a revoked member is denied by RBAC on the next check (AUT-005)', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    // Keep an owner so the member removal is not a last-owner case.
    await addMember(orgId, `keep-${orgId.slice(0, 8)}`, ['organization_owner'])
    const memberSubject = `m-${orgId.slice(0, 8)}`
    const member = await addMember(orgId, memberSubject, ['member'])
    // Before revoke: allowed.
    const before = await authorizeSubjectForOrg(
      db,
      { issuer: ISSUER, subject: memberSubject },
      orgId,
      'organization.read'
    )
    expect(before.decision.allowed).toBe(true)
    // Revoke, then the same subject is denied.
    expect(
      (
        await revokeMembership(db, {
          organizationId: orgId,
          targetUserId: member,
          actorUserId: member
        })
      ).outcome
    ).toBe('revoked')
    const after = await authorizeSubjectForOrg(
      db,
      { issuer: ISSUER, subject: memberSubject },
      orgId,
      'organization.read'
    )
    expect(after.decision).toEqual({ allowed: false, reason: 'no_active_membership' })
  })
})
