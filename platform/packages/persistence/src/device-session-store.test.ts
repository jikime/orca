import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import {
  isSessionRevoked,
  recordDeviceSession,
  revokeSession,
  revokeUserSessions,
  rotateSessionFamily
} from './device-session-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

async function freshUser(): Promise<{ userId: string; issuer: string; subject: string }> {
  const orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `ds-${orgId.slice(0, 8)}`,
    displayName: 'DS'
  })
  const issuer = 'https://issuer.test'
  const subject = `u-${randomUUID()}`
  const { userId } = await seedMembershipFixture(db, { organizationId: orgId, issuer, subject })
  return { userId, issuer, subject }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED device session suite: Docker/PostgreSQL unavailable — ${String(error)}`)
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

// AUT-002 refresh-token-family-reuse-suite
describe('refresh-token-family-reuse-suite (AUT-002)', () => {
  it('rotates the family forward on a matching rotation marker', async (ctx) => {
    if (!harness) return ctx.skip()
    const user = await freshUser()
    const sessionId = `sid-${randomUUID()}`
    await recordDeviceSession(db, {
      sessionId,
      userId: user.userId,
      issuer: user.issuer,
      subject: user.subject
    })
    expect(await rotateSessionFamily(db, { sessionId, presentedRotation: 0 })).toEqual({
      outcome: 'rotated',
      rotationCounter: 1
    })
    expect(await rotateSessionFamily(db, { sessionId, presentedRotation: 1 })).toEqual({
      outcome: 'rotated',
      rotationCounter: 2
    })
  })

  it('revokes the entire family when a stale rotation marker is replayed (reuse)', async (ctx) => {
    if (!harness) return ctx.skip()
    const user = await freshUser()
    const sessionId = `sid-${randomUUID()}`
    await recordDeviceSession(db, {
      sessionId,
      userId: user.userId,
      issuer: user.issuer,
      subject: user.subject
    })
    await rotateSessionFamily(db, { sessionId, presentedRotation: 0 }) // now at 1
    // Replaying the already-used marker 0 = reuse attack → whole family revoked.
    expect(await rotateSessionFamily(db, { sessionId, presentedRotation: 0 })).toEqual({
      outcome: 'reuse_revoked'
    })
    expect(await isSessionRevoked(db, sessionId)).toBe(true)
  })
})

// AUT-005 (persistence half): a revoked session reads as revoked immediately.
describe('session revocation store (AUT-005)', () => {
  it('an unknown session is not revoked; an explicitly revoked one is', async (ctx) => {
    if (!harness) return ctx.skip()
    const user = await freshUser()
    const sessionId = `sid-${randomUUID()}`
    expect(await isSessionRevoked(db, sessionId)).toBe(false)
    await recordDeviceSession(db, {
      sessionId,
      userId: user.userId,
      issuer: user.issuer,
      subject: user.subject
    })
    expect(await isSessionRevoked(db, sessionId)).toBe(false)
    await revokeSession(db, { sessionId, reason: 'admin_revoke' })
    expect(await isSessionRevoked(db, sessionId)).toBe(true)
  })

  it('revokes all sessions but the current one', async (ctx) => {
    if (!harness) return ctx.skip()
    const user = await freshUser()
    const current = `sid-${randomUUID()}`
    const other = `sid-${randomUUID()}`
    await recordDeviceSession(db, {
      sessionId: current,
      userId: user.userId,
      issuer: user.issuer,
      subject: user.subject
    })
    await recordDeviceSession(db, {
      sessionId: other,
      userId: user.userId,
      issuer: user.issuer,
      subject: user.subject
    })
    await revokeUserSessions(db, {
      userId: user.userId,
      reason: 'user_logout',
      exceptSessionId: current
    })
    expect(await isSessionRevoked(db, current)).toBe(false)
    expect(await isSessionRevoked(db, other)).toBe(true)
  })
})
