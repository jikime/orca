import { randomUUID } from 'node:crypto'
import { Kysely } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { runMigrations } from './migration-runner'
import {
  audienceForRoles,
  projectCommentsForAudience,
  projectProjectForAudience,
  projectWorkItemForAudience,
  resolveAudience
} from './resource-projection'
import type { CommentResource } from './comment-store'
import type { WorkItemResource } from './work-item-store'
import type { ProjectResource } from './project-store'
import { seedMembershipFixture, seedOrganizationFixture } from './organization-seed'
import { seedRoleManifest } from './role-manifest-seed'
import { startPostgresHarness, type PostgresHarness } from './postgres-test-harness'

let harness: PostgresHarness | null = null
let pool: Pool
let db: Kysely<Database>

const WORK_ITEM: WorkItemResource = {
  id: 'w1',
  organizationId: 'o1',
  teamId: 't1',
  projectId: 'p1',
  identifier: 'APP-1',
  title: 'Ship the thing',
  description: 'details',
  stateId: 's1',
  workflowVersion: 1,
  sortKey: 3,
  priority: 'high',
  assigneeId: 'u-internal',
  version: 2,
  createdAt: '2026-07-16T09:00:00.000Z',
  updatedAt: '2026-07-16T09:00:00.000Z'
}

const PROJECT: ProjectResource = {
  id: 'p1',
  organizationId: 'o1',
  name: 'Apollo',
  summary: 'internal delivery notes',
  status: 'active',
  version: 1,
  createdAt: '2026-07-16T09:00:00.000Z',
  updatedAt: '2026-07-16T09:00:00.000Z',
  archivedAt: null
}

const COMMENTS: CommentResource[] = [
  {
    id: 'c1',
    organizationId: 'o1',
    workItemId: 'w1',
    authorId: 'u',
    body: 'internal only',
    visibility: 'internal',
    createdAt: '2026-07-16T09:00:00.000Z'
  },
  {
    id: 'c2',
    organizationId: 'o1',
    workItemId: 'w1',
    authorId: 'u',
    body: 'team note',
    visibility: 'project',
    createdAt: '2026-07-16T09:01:00.000Z'
  },
  {
    id: 'c3',
    organizationId: 'o1',
    workItemId: 'w1',
    authorId: 'u',
    body: 'for the customer',
    visibility: 'customer',
    createdAt: '2026-07-16T09:02:00.000Z'
  }
]

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED projection suite: Docker unavailable — ${String(error)}`)
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

// TEN-004: an external (customer) role must not see internal fields/comments.
describe('customer-field-projection-snapshots (TEN-004)', () => {
  it('classifies an all-external membership as external, any internal role as internal', () => {
    expect(audienceForRoles(['customer_approver'])).toBe('external')
    expect(audienceForRoles(['partner'])).toBe('external')
    expect(audienceForRoles(['member'])).toBe('internal')
    expect(audienceForRoles(['member', 'customer_approver'])).toBe('internal')
    expect(audienceForRoles([])).toBe('external')
  })

  it('omits internal work item fields for an external audience', () => {
    const internal = projectWorkItemForAudience(WORK_ITEM, 'internal')
    expect(internal).toEqual(WORK_ITEM)
    const external = projectWorkItemForAudience(WORK_ITEM, 'external') as Record<string, unknown>
    for (const field of ['assigneeId', 'priority', 'sortKey', 'workflowVersion'])
      expect(external).not.toHaveProperty(field)
    // Customer-safe fields survive.
    expect(external.identifier).toBe('APP-1')
    expect(external.title).toBe('Ship the thing')
    expect(external.stateId).toBe('s1')
  })

  it('omits internal project fields for an external audience', () => {
    const external = projectProjectForAudience(PROJECT, 'external') as Record<string, unknown>
    expect(external).not.toHaveProperty('summary')
    expect(external).not.toHaveProperty('status')
    expect(external.name).toBe('Apollo')
  })

  it('shows an external audience only customer-visible comments', () => {
    expect(projectCommentsForAudience(COMMENTS, 'internal').map((c) => c.id)).toEqual([
      'c1',
      'c2',
      'c3'
    ])
    expect(projectCommentsForAudience(COMMENTS, 'external').map((c) => c.id)).toEqual(['c3'])
  })

  it('resolves audience from a real customer membership fixture', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = randomUUID()
    await seedOrganizationFixture(db, {
      id: orgId,
      slug: `x-${orgId.slice(0, 8)}`,
      displayName: 'X'
    })
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'kc',
      subject: 'internal-user',
      roleIds: ['member']
    })
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: 'kc',
      subject: 'customer-user',
      roleIds: ['customer_approver']
    })
    expect(await resolveAudience(db, orgId, { issuer: 'kc', subject: 'internal-user' })).toBe(
      'internal'
    )
    expect(await resolveAudience(db, orgId, { issuer: 'kc', subject: 'customer-user' })).toBe(
      'external'
    )
    // A subject with no membership in the org → most restrictive.
    expect(await resolveAudience(db, orgId, { issuer: 'kc', subject: 'stranger' })).toBe('external')
  })
})
