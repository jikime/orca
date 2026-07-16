import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  claimOutboxBatch,
  createDatabase,
  createDatabasePool,
  encodeCursor,
  publishClaimedEvent,
  runMigrations,
  seedOrganizationFixture,
  seedMembershipFixture,
  updateOrganizationDisplayName,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
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
import {
  allowAllConnections,
  createTestTokenVerifier,
  TEST_ISSUER
} from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''

const clock = { now: () => Date.now(), newId: () => randomUUID() }

async function freshOrg(): Promise<string> {
  const id = randomUUID()
  await seedOrganizationFixture(db, { id, slug: `org-${id.slice(0, 8)}`, displayName: 'Org' })
  return id
}

async function mutate(organizationId: string, displayName: string): Promise<string> {
  const result = await updateOrganizationDisplayName(db, clock, { organizationId, displayName })
  return result.operationId
}

async function publishPending(): Promise<void> {
  const claimed = await claimOutboxBatch(db, {
    workerId: 'test-worker',
    batchSize: 100,
    leaseMs: 30_000
  })
  for (const event of claimed) {
    await publishClaimedEvent(db, event)
  }
}

type RealtimeClient = {
  waitFor: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  received: (type: string) => Record<string, unknown>[]
  close: () => void
}

async function connect(hello: Record<string, unknown>): Promise<RealtimeClient> {
  const ws = new WebSocket(wsUrl)
  const messages: Record<string, unknown>[] = []
  const delivered = new Map<string, number>()
  ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  ws.send(JSON.stringify(hello))
  const nextUnconsumed = (type: string): Record<string, unknown> | undefined => {
    const matches = messages.filter((message) => message.type === type)
    const already = delivered.get(type) ?? 0
    if (matches.length > already) {
      delivered.set(type, already + 1)
      return matches[already]
    }
    return undefined
  }
  return {
    received: (type) => messages.filter((message) => message.type === type),
    waitFor: (type, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const immediate = nextUnconsumed(type)
        if (immediate) {
          resolve(immediate)
          return
        }
        const timer = setTimeout(() => {
          ws.off('message', onMessage)
          reject(new Error(`timeout waiting for ${type}`))
        }, timeoutMs)
        const onMessage = (): void => {
          const message = nextUnconsumed(type)
          if (message) {
            clearTimeout(timer)
            ws.off('message', onMessage)
            resolve(message)
          }
        }
        ws.on('message', onMessage)
      }),
    close: () => ws.close()
  }
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED realtime vertical: Docker/PostgreSQL unavailable — ${String(error)}`)
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
    heartbeatIntervalMs: 60_000,
    // Small window so the reconnect test can force a resync deterministically.
    resyncWindow: 1
  })
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    gateway,
    tokenVerifier: createTestTokenVerifier()
  })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
  wsUrl = `ws://127.0.0.1:${address.port}/v1/realtime`
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

function helloMessage(organizationId: string, lastCursor?: string): Record<string, unknown> {
  return {
    type: 'client.hello',
    schemaVersion: 1,
    protocolVersion: '1.0',
    instanceId: 'test-instance',
    organizationId,
    lastCursor: lastCursor ?? null
  }
}

describe('realtime vertical', () => {
  it('welcomes a client and pushes a live resource.changed', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const client = await connect(helloMessage(orgId))
    const welcome = await client.waitFor('server.welcome')
    expect(welcome.cursor).toBe('cursor-00000000')

    await mutate(orgId, 'Live')
    await publishPending()
    const changed = await client.waitFor('resource.changed')
    expect(changed).toMatchObject({
      type: 'resource.changed',
      organizationId: orgId,
      resourceType: 'organization',
      changeKind: 'updated'
    })
    expect(registry.validate('resource.changed', changed)).toBe(true)
    client.close()
  })

  it('never delivers another tenant’s events', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgA = await freshOrg()
    const orgB = await freshOrg()
    const clientA = await connect(helloMessage(orgA))
    await clientA.waitFor('server.welcome')

    await mutate(orgB, 'B changes')
    await publishPending()
    await delay(600)
    expect(clientA.received('resource.changed')).toHaveLength(0)
    clientA.close()
  })

  it('delivers the missed delta on reconnect within the window', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const first = await connect(helloMessage(orgId))
    await first.waitFor('server.welcome')
    await mutate(orgId, 'v1')
    await publishPending()
    const live = await first.waitFor('resource.changed')
    const cursorAfterFirst = live.cursor as string
    first.close()

    await mutate(orgId, 'v2')
    await publishPending()

    const second = await connect(helloMessage(orgId, cursorAfterFirst))
    await second.waitFor('server.welcome')
    const delta = await second.waitFor('resource.changed')
    expect(delta.cursor).toBe(encodeCursor(2))
    second.close()
  })

  it('asks for resync when too far behind, then converges via /changes', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    await mutate(orgId, 'a')
    await publishPending()
    await mutate(orgId, 'b')
    await publishPending()

    // lastCursor at sequence 0 while currentMax is 2 → gap 2 > window 1 → resync.
    const client = await connect(helloMessage(orgId, encodeCursor(0)))
    await client.waitFor('server.welcome')
    const resync = await client.waitFor('resync.required')
    expect(resync.reason).toBe('buffer_overflow')
    client.close()

    // The client converges through the authoritative REST feed (authenticated).
    const subject = await memberToken(orgId)
    const response = await fetch(
      `${baseUrl}/v1/organizations/${orgId}/changes?after=${encodeCursor(0)}`,
      { headers: { authorization: `Bearer ${subject}` } }
    )
    expect(response.status).toBe(200)
    const page = (await response.json()) as { items: unknown[]; hasMore: boolean }
    expect(page.items).toHaveLength(2)
    expect(registry.validate('resource.changed', page.items[0])).toBe(true)
  })

  it('serves the REST endpoints scoped to the authenticated subject', async (ctx) => {
    if (!harness) return ctx.skip()
    const orgId = await freshOrg()
    const operationId = await mutate(orgId, 'rest')
    const subject = await memberToken(orgId)
    const auth = { authorization: `Bearer ${subject}` }

    const orgs = await fetch(`${baseUrl}/v1/organizations`, { headers: auth })
    expect(orgs.status).toBe(200)
    const orgsBody = (await orgs.json()) as { items: { id: string }[] }
    // The membership-scoped list returns exactly the org this subject belongs to.
    expect(orgsBody.items.map((item) => item.id)).toEqual([orgId])

    const operation = await fetch(`${baseUrl}/v1/operations/${operationId}`, { headers: auth })
    expect(operation.status).toBe(200)
    expect(operation.headers.get('etag')).toMatch(/^"operation-/)
    const operationBody = (await operation.json()) as { id: string }
    expect(operationBody.id).toBe(operationId)
  })

  it('rejects an organization list without a bearer token (401)', async (ctx) => {
    if (!harness) return ctx.skip()
    const response = await fetch(`${baseUrl}/v1/organizations`)
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
  })
})

// A per-test subject with an active owner membership in the org, returned as its
// bearer token (the test verifier treats the token string as the subject).
async function memberToken(orgId: string): Promise<string> {
  const subject = `sub-${orgId.slice(0, 8)}`
  await seedMembershipFixture(db, { organizationId: orgId, issuer: TEST_ISSUER, subject })
  return subject
}
