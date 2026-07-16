import { createHash, randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureLogicalBackup,
  restoreLogicalBackup,
  type LogicalBackup,
  type PgExec
} from './database-backup'
import { createArtifactUploadIntent, finalizeArtifactUpload } from './artifact-upload'
import { createDatabase, createDatabasePool } from './database-connection'
import type { Database } from './database-schema'
import { listMigrationFiles, runMigrations } from './migration-runner'
import { updateOrganizationDisplayName } from './organization-mutation'
import { claimOutboxBatch, publishClaimedEvent } from './outbox-publish'
import { seedOrganizationFixture } from './organization-seed'
import { withoutTenantContext, withTenantTransaction } from './tenant-transaction'

const PG_USER = 'test'
const PG_DATABASE = 'test'
const clock = { now: () => Date.now(), newId: () => randomUUID() }

const ORG_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a'
const ORG_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b'
const CANARY_SECRET = `CANARY-SECRET-${randomUUID()}`
const CANARY_DIGEST = createHash('sha256').update(CANARY_SECRET).digest('hex')

let containersReady = false
let source: StartedPostgreSqlContainer
let target: StartedPostgreSqlContainer
let sourcePool: Pool
let sourceDb: Kysely<Database>
let targetPool: Pool
let targetDb: Kysely<Database>
let backup: LogicalBackup

function execFor(container: StartedPostgreSqlContainer): PgExec {
  return async (command) => {
    const result = await container.exec(command)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }
}

async function countRows(db: Kysely<Database>, table: keyof Database): Promise<number> {
  return withoutTenantContext(db, async (trx) => {
    const row = await trx
      .selectFrom(table)
      .select(sql<string>`count(*)`.as('count'))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  })
}

beforeAll(async () => {
  try {
    source = await new PostgreSqlContainer('postgres:16').start()
    target = await new PostgreSqlContainer('postgres:16').start()
  } catch (error) {
    console.warn(`SKIPPED restore smoke: Docker unavailable — ${String(error)}`)
    return
  }
  containersReady = true
  sourcePool = createDatabasePool({ connectionString: source.getConnectionUri() })
  sourceDb = createDatabase(sourcePool)
  await runMigrations(sourcePool)

  // Populate the source: two tenants, an org mutation vertical (audit + outbox +
  // operation), a published event (stream_cursors), and an artifact revision.
  await seedOrganizationFixture(sourceDb, {
    id: ORG_A,
    slug: 'restore-a',
    displayName: 'Restore A'
  })
  await seedOrganizationFixture(sourceDb, {
    id: ORG_B,
    slug: 'restore-b',
    displayName: 'Restore B'
  })
  await updateOrganizationDisplayName(sourceDb, clock, {
    organizationId: ORG_A,
    displayName: 'A renamed'
  })
  const claimed = await claimOutboxBatch(sourceDb, {
    workerId: 'smoke',
    batchSize: 10,
    leaseMs: 30_000
  })
  for (const event of claimed) {
    await publishClaimedEvent(sourceDb, event)
  }
  const objectId = randomUUID()
  const artifactId = randomUUID()
  const uploadSessionId = randomUUID()
  await createArtifactUploadIntent(sourceDb, {
    organizationId: ORG_A,
    uploadSessionId,
    artifactId,
    objectId,
    storageKey: `org/${ORG_A}/artifacts/${objectId}`,
    projectId: randomUUID(),
    workItemId: null,
    name: 'restore.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    classification: 'internal',
    visibility: 'internal',
    method: 'single',
    expiresAt: new Date(Date.now() + 900_000).toISOString()
  })
  await finalizeArtifactUpload(sourceDb, clock, { organizationId: ORG_A, uploadSessionId })
  // A canary that must only ever appear as a DIGEST in audit, never in clear.
  await withoutTenantContext(sourceDb, (trx) =>
    trx
      .insertInto('audit.audit_events')
      .values({
        organization_id: ORG_A,
        action: 'secret.rotated',
        target_type: 'credential',
        after_digest: CANARY_DIGEST
      })
      .execute()
  )

  backup = await captureLogicalBackup(execFor(source), { user: PG_USER, database: PG_DATABASE })
  await restoreLogicalBackup(
    execFor(target),
    (content, path) =>
      target.copyContentToContainer([{ content, target: path }]).then(() => undefined),
    backup,
    {
      user: PG_USER,
      database: PG_DATABASE
    }
  )
  targetPool = createDatabasePool({ connectionString: target.getConnectionUri() })
  targetDb = createDatabase(targetPool)
}, 240_000)

afterAll(async () => {
  await sourceDb?.destroy()
  await targetDb?.destroy()
  // Scoped cleanup: stop ONLY the containers this test started (testcontainers
  // removes them). Never touch other resources.
  await source?.stop()
  await target?.stop()
})

describe('logical backup + separate-environment restore', () => {
  it('contains no plaintext secret — audit stores digests only', (ctx) => {
    if (!containersReady) return ctx.skip()
    expect(backup.database).toContain(CANARY_DIGEST)
    expect(backup.database).not.toContain(CANARY_SECRET)
    // Roles dumped without passwords (no secret material in the globals dump).
    expect(backup.globals).toContain('pie_app')
    expect(backup.globals.toUpperCase()).not.toContain('PASSWORD')
  })

  it('preserves the migration checksum table', async (ctx) => {
    if (!containersReady) return ctx.skip()
    const rows = await withoutTenantContext(targetDb, (trx) =>
      sql<{
        filename: string
        checksum: string
      }>`select filename, checksum from public.pie_schema_migrations order by filename`.execute(trx)
    )
    const restored = new Map(rows.rows.map((row) => [row.filename, row.checksum]))
    for (const file of listMigrationFiles()) {
      expect(restored.get(file.name)).toBe(file.checksum)
    }
  })

  it('preserves org/audit/outbox/artifact row counts and content', async (ctx) => {
    if (!containersReady) return ctx.skip()
    expect(await countRows(targetDb, 'identity.organizations')).toBe(
      await countRows(sourceDb, 'identity.organizations')
    )
    expect(await countRows(targetDb, 'audit.audit_events')).toBe(
      await countRows(sourceDb, 'audit.audit_events')
    )
    expect(await countRows(targetDb, 'agent.artifact_revisions')).toBe(
      await countRows(sourceDb, 'agent.artifact_revisions')
    )
    const org = await withTenantTransaction(targetDb, ORG_A, (trx) =>
      trx
        .selectFrom('identity.organizations')
        .select('display_name')
        .where('id', '=', ORG_A)
        .executeTakeFirst()
    )
    expect(org?.display_name).toBe('A renamed')
  })

  it('keeps RLS enforced on the restored database', async (ctx) => {
    if (!containersReady) return ctx.skip()
    const rows = await withTenantTransaction(targetDb, ORG_A, (trx) =>
      trx.selectFrom('identity.organizations').select('id').execute()
    )
    expect(rows.map((row) => row.id)).toEqual([ORG_A])
  })

  it('keeps stream_cursors consistent so a resumed worker does not re-issue sequences', async (ctx) => {
    if (!containersReady) return ctx.skip()
    const sourceCursor = await withoutTenantContext(sourceDb, (trx) =>
      trx
        .selectFrom('operations.stream_cursors')
        .select('last_sequence')
        .where('organization_id', '=', ORG_A)
        .executeTakeFirst()
    )
    const targetCursor = await withoutTenantContext(targetDb, (trx) =>
      trx
        .selectFrom('operations.stream_cursors')
        .select('last_sequence')
        .where('organization_id', '=', ORG_A)
        .executeTakeFirst()
    )
    expect(Number(targetCursor?.last_sequence)).toBe(Number(sourceCursor?.last_sequence))

    // A resumed publish on the restored DB continues from the next sequence.
    await updateOrganizationDisplayName(targetDb, clock, {
      organizationId: ORG_A,
      displayName: 'resumed'
    })
    const claimed = await claimOutboxBatch(targetDb, {
      workerId: 'resumed',
      batchSize: 10,
      leaseMs: 30_000
    })
    const results = await Promise.all(claimed.map((event) => publishClaimedEvent(targetDb, event)))
    const published = results.find((result) => result.outcome === 'published')
    expect(published?.outcome).toBe('published')
    if (published?.outcome === 'published') {
      expect(published.sequence).toBe(Number(sourceCursor?.last_sequence) + 1)
    }
  })
})
