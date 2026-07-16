import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  claimOutboxBatch,
  createDatabase,
  createDatabasePool,
  requeueDeadLetterEvent,
  requeueFailedEvent,
  runMigrations,
  seedOrganizationFixture,
  updateOrganizationDisplayName,
  withoutTenantContext,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import { createOutboxClaimLoop } from '@pie/control-plane-worker/outbox-claim-loop'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import { allowAllConnections } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let wsUrl = ''

const clock = { now: () => Date.now(), newId: () => randomUUID() }

async function freshOrg(): Promise<string> {
  const id = randomUUID()
  await seedOrganizationFixture(db, { id, slug: `dlv-${id.slice(0, 8)}`, displayName: 'DLV Org' })
  return id
}

// A realtime subscriber that records every resource.changed it receives.
async function openSubscriber(orgId: string): Promise<{ close: () => void; changes: unknown[] }> {
  const changes: unknown[] = []
  const socket = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
  })
  socket.on('message', (data: Buffer) => {
    const message = JSON.parse(data.toString()) as { type?: string }
    if (message.type === 'resource.changed') {
      changes.push(message)
    }
  })
  socket.send(
    JSON.stringify({
      type: 'client.hello',
      schemaVersion: 1,
      protocolVersion: '1.0',
      instanceId: 'dlv-test',
      organizationId: orgId,
      lastCursor: null
    })
  )
  await delay(200)
  return { close: () => socket.close(), changes }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function loop() {
  return createOutboxClaimLoop({
    db,
    workerId: `dlv-${randomUUID().slice(0, 8)}`,
    batchSize: 50,
    leaseMs: 30_000,
    pollIntervalMs: 1000,
    maxAttempts: 1,
    baseBackoffMs: 0,
    maxBackoffMs: 0
  })
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED dead-letter vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  registry = createContractSchemaRegistry()
  gateway = createRealtimeGateway({
    authorizeConnection: allowAllConnections(),
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000
  })
  app = buildApp({ ping: async () => true, db, registry, gateway })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('dead-letter requeue vertical', () => {
  it('republishes a requeued dead letter all the way to a realtime subscriber', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    // Enqueue then dead-letter a valid event (retry budget 1 → first failure parks).
    await updateOrganizationDisplayName(db, clock, { organizationId: orgId, displayName: 'v2' })
    const claimed = await claimOutboxBatch(db, {
      workerId: 'dlv-park',
      batchSize: 50,
      leaseMs: 30_000
    })
    const mine = claimed.find((event) => event.organizationId === orgId)
    if (!mine) throw new Error('expected to claim the enqueued event')
    await requeueFailedEvent(db, mine, 'FORCED_PARK', {
      maxAttempts: 1,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    })

    // Subscribe, then operator-requeue and let the worker republish.
    const subscriber = await openSubscriber(orgId)
    const requeue = await requeueDeadLetterEvent(db, mine.id, 'operator@test')
    expect(requeue.outcome).toBe('requeued')
    await loop().runOnce()

    await waitFor(() => subscriber.changes.length >= 1, 'republished change to reach subscriber')
    subscriber.close()
  })

  it('parks a poison event without blocking a healthy event delivery', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const poisonId = randomUUID()
    await withoutTenantContext(db, (trx) =>
      trx
        .insertInto('operations.outbox_events')
        .values({
          id: poisonId,
          organization_id: orgId,
          aggregate_type: 'organization',
          aggregate_id: orgId,
          aggregate_version: 1,
          event_type: 'broken',
          event_schema_version: 1,
          payload: JSON.stringify({ not: 'an-envelope' })
        })
        .execute()
    )
    await updateOrganizationDisplayName(db, clock, {
      organizationId: orgId,
      displayName: 'healthy'
    })

    const subscriber = await openSubscriber(orgId)
    const summary = await loop().runOnce()
    expect(summary.published).toBeGreaterThanOrEqual(1)
    expect(summary.parked).toBeGreaterThanOrEqual(1)

    // The healthy event still reaches the subscriber despite the poison sibling.
    await waitFor(() => subscriber.changes.length >= 1, 'healthy change to reach subscriber')

    // The poison event relocated to the dead-letter store, out of the hot outbox.
    const dead = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.dead_letter_events')
        .select('status')
        .where('id', '=', poisonId)
        .executeTakeFirst()
    )
    expect(dead?.status).toBe('parked')
    subscriber.close()
  })
})
