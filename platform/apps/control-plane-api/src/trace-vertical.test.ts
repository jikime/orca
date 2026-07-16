import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
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

type CaptureLogger = {
  entries: Record<string, unknown>[]
  info: (fields: Record<string, unknown>) => void
  warn: (fields: Record<string, unknown>) => void
  error: (fields: Record<string, unknown>) => void
}

function captureLogger(): CaptureLogger {
  const entries: Record<string, unknown>[] = []
  const push = (fields: Record<string, unknown>): void => {
    entries.push(fields)
  }
  return { entries, info: push, warn: push, error: push }
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let gatewayLog: CaptureLogger
let app: FastifyInstance
let orgId = ''
let wsUrl = ''
let baseUrl = ''

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED trace vertical: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `trace-${orgId.slice(0, 8)}`,
    displayName: 'Trace Org'
  })
  registry = createContractSchemaRegistry()
  gatewayLog = captureLogger()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000,
    logger: gatewayLog
  })
  app = buildApp({ ping: async () => true, db, registry, gateway })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
  baseUrl = `http://127.0.0.1:${port}`
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('end-to-end trace', () => {
  it('propagates one trace id through audit, outbox, worker log, and gateway log', async (ctx) => {
    if (!harness) return ctx.skip()

    // A realtime subscriber so the gateway actually delivers (and logs) the change.
    const client = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    client.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'trace-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(200)

    await updateOrganizationDisplayName(
      db,
      { now: () => Date.now(), newId: () => randomUUID() },
      {
        organizationId: orgId,
        displayName: 'traced',
        traceparent: TRACEPARENT
      }
    )

    // 1. audit row carries the trace id.
    const audit = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('trace_id')
        .where('organization_id', '=', orgId)
        .where('action', '=', 'organization.display_name.updated')
        .executeTakeFirst()
    )
    expect(audit?.trace_id).toBe(TRACE_ID)

    // 2. outbox envelope carries the traceparent.
    const outbox = await withoutTenantContext(db, (trx) =>
      trx
        .selectFrom('operations.outbox_events')
        .select('payload')
        .where('organization_id', '=', orgId)
        .executeTakeFirst()
    )
    const payload = (outbox?.payload ?? {}) as { traceparent?: string }
    expect(payload.traceparent).toBe(TRACEPARENT)

    // 3. worker publish log carries the trace id.
    const workerLog = captureLogger()
    await createOutboxClaimLoop({
      db,
      workerId: 'trace-worker',
      batchSize: 10,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 5,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      logger: workerLog
    }).runOnce()
    const publishEntry = workerLog.entries.find((entry) => entry.event === 'outbox.published')
    expect(publishEntry?.traceId).toBe(TRACE_ID)

    // 4. gateway delivery log carries the same trace id.
    await (async () => {
      for (let i = 0; i < 50; i++) {
        if (
          gatewayLog.entries.some((e) => e.event === 'realtime.delivered' && e.traceId === TRACE_ID)
        ) {
          return
        }
        await delay(50)
      }
      throw new Error('no gateway delivery log with the trace id')
    })()

    client.close()
  })

  it('serves the metrics JSON and the static ops page', async (ctx) => {
    if (!harness) return ctx.skip()
    const metrics = await fetch(`${baseUrl}/internal/metrics`)
    expect(metrics.status).toBe(200)
    const body = (await metrics.json()) as {
      outbox: { published: number; pending: number; parked: number; claimLagSeconds: number }
      realtime: { connectedClients: number; deliveredMessages: number }
    }
    expect(body.outbox.published).toBeGreaterThanOrEqual(1)
    expect(typeof body.realtime.deliveredMessages).toBe('number')

    const ops = await fetch(`${baseUrl}/internal/ops`)
    expect(ops.status).toBe(200)
    expect(ops.headers.get('content-type')).toContain('text/html')
    expect(await ops.text()).toContain('ops dashboard')
  })
})
