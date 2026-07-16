import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedRoleManifest,
  seedEntitlementManifest,
  type PieDatabase
} from '@pie/persistence'
import { createOutboxClaimLoop } from '@pie/control-plane-worker/outbox-claim-loop'
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
import { createGatewayConnectionAuthorizer } from './gateway-connection-authorizer'
import { createRealtimeGateway, type RealtimeGateway } from './realtime-gateway'
import { createTestTokenVerifier } from './authorization-test-support'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let gateway: RealtimeGateway
let app: FastifyInstance
let baseUrl = ''
let wsUrl = ''

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bearerFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED core-gate: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  const verifier = createTestTokenVerifier()
  gateway = createRealtimeGateway({
    db,
    registry,
    listenConnectionString: harness.connectionString,
    heartbeatIntervalMs: 60_000,
    authorizeConnection: createGatewayConnectionAuthorizer(db, verifier)
  })
  app = buildApp({ ping: async () => true, db, registry, gateway, tokenVerifier: verifier })
  await app.ready()
  await gateway.start()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  wsUrl = `ws://127.0.0.1:${port}/v1/realtime`
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

// The named R4 Core Gate evidence (doc 28:307-331): the full vertical end to end,
// plus the gate conditions this slice can honestly assert. The Windows/macOS/Linux
// desktop smoke and the real-Keycloak login are run live; here the token layer is
// faked (bearer=subject) while every server path is real against Postgres.
describe('r4-core-gate', () => {
  it('drives owner → org → team → project → work item → my work → board → comment/activity', async (ctx) => {
    if (!harness) return ctx.skip()

    // owner login → org provisioned (auto default CORE team).
    const prov = await jsonOf<{ organizationId: string }>(
      await bearerFetch('gate-owner', '/v1/provisioning', {
        method: 'POST',
        body: JSON.stringify({ organizationDisplayName: 'Core Gate Org' })
      })
    )
    const orgId = prov.organizationId
    expect(orgId).toMatch(UUID)
    const session = await jsonOf<{ userId: string }>(await bearerFetch('gate-owner', '/v1/session'))
    const ownerId = session.userId

    // Team (the provisioned CORE team).
    const teams = await jsonOf<{ items: Array<{ id: string; key: string }> }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/teams`)
    )
    const team = teams.items.find((t) => t.key === 'CORE')!
    expect(team).toBeTruthy()

    // Project.
    const project = await jsonOf<{ id: string }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/projects`, {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ name: 'Core Gate Project' })
      })
    )
    expect(project.id).toMatch(UUID)

    // WorkItem CORE-1 (opaque UUID id; human key is a distinct namespace from Orca).
    const created = await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ teamId: team.id, projectId: project.id, title: 'Close the gate' })
    })
    expect(created.status).toBe(201)
    const workItem = await jsonOf<{ id: string; identifier: string; version: number }>(created)
    expect(workItem.id).toMatch(UUID)
    expect(workItem.identifier).toBe('CORE-1')
    // WorkItem ID namespace is distinct from Orca Worktree/task IDs: the opaque UUID
    // is the identity, the human key is derived and formatted differently.
    expect(workItem.id).not.toBe(workItem.identifier)
    expect(workItem.identifier).toMatch(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/)

    // Assign to the owner, then My Work shows it.
    await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items/${workItem.id}:assign`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ assigneeId: ownerId, expectedVersion: 1 })
    })
    const myWork = await jsonOf<{ items: Array<{ id: string }> }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items?assignee=me`)
    )
    expect(myWork.items.map((i) => i.id)).toContain(workItem.id)

    // Board move (subscribe to realtime first to prove invalidation delivery).
    const changes: Array<{ resourceType?: string }> = []
    const socket = new WebSocket(wsUrl, { headers: { authorization: 'Bearer gate-owner' } })
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve())
      socket.on('error', reject)
    })
    socket.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString()) as { type?: string; resourceType?: string }
      if (m.type === 'resource.changed') changes.push(m)
    })
    socket.send(
      JSON.stringify({
        type: 'client.hello',
        schemaVersion: 1,
        protocolVersion: '1.0',
        instanceId: 'gate-test',
        organizationId: orgId,
        lastCursor: null
      })
    )
    await delay(250)
    const workflow = await jsonOf<{ items: Array<{ id: string; key: string }> }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/teams/${team.id}/workflow-states`)
    )
    const todo = workflow.items.find((s) => s.key === 'todo')!.id
    const inProgress = workflow.items.find((s) => s.key === 'in_progress')!.id
    // assign bumped the version to 2.
    const move = await bearerFetch(
      'gate-owner',
      `/v1/organizations/${orgId}/work-items/${workItem.id}:move-state`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          fromStateId: todo,
          toStateId: inProgress,
          workflowVersion: 1,
          expectedVersion: 2
        })
      }
    )
    expect(move.status).toBe(200)

    // Comment + Activity shows the move and the comment.
    await bearerFetch(
      'gate-owner',
      `/v1/organizations/${orgId}/work-items/${workItem.id}/comments`,
      {
        method: 'POST',
        headers: { 'idempotency-key': randomUUID() },
        body: JSON.stringify({ body: 'Gate comment', visibility: 'project' })
      }
    )
    const activity = await jsonOf<{ items: Array<{ action: string }> }>(
      await bearerFetch(
        'gate-owner',
        `/v1/organizations/${orgId}/work-items/${workItem.id}/activity`
      )
    )
    const actions = activity.items.map((a) => a.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'work_item.created',
        'work_item.assigned',
        'work_item.state_moved',
        'work_item.commented'
      ])
    )

    await createOutboxClaimLoop({
      db,
      workerId: 'gate-w',
      batchSize: 20,
      leaseMs: 30_000,
      pollIntervalMs: 1000,
      maxAttempts: 3,
      baseBackoffMs: 0,
      maxBackoffMs: 0
    }).runOnce()
    for (let i = 0; i < 60 && !changes.some((c) => c.resourceType === 'work_item'); i++)
      await delay(50)
    expect(changes.some((c) => c.resourceType === 'work_item')).toBe(true)
    socket.close()

    // Gate condition: no access token is exposed between the API and a client.
    for (const [path, body] of [
      ['session', JSON.stringify(session)],
      ['work-item', JSON.stringify(workItem)]
    ] as const) {
      expect(body.toLowerCase(), path).not.toContain('access_token')
      expect(body.toLowerCase(), path).not.toContain('refresh_token')
      expect(body.toLowerCase(), path).not.toContain('bearer ')
    }

    // Gate condition (doc 28:328): duplicate request. A retried create with the same
    // Idempotency-Key + payload returns the SAME resource (one row); a same key with
    // a different payload → 409. This is what closes the gate fully.
    const dupKey = randomUUID()
    const dupBody = JSON.stringify({ teamId: team.id, title: 'Duplicate-guarded' })
    const listBefore = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`)
    )
    const dupHeaders = { 'idempotency-key': dupKey, 'content-type': 'application/json' }
    const firstCreate = await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: dupHeaders,
      body: dupBody
    })
    const secondCreate = await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: dupHeaders,
      body: dupBody
    })
    expect(firstCreate.status).toBe(201)
    expect(secondCreate.status).toBe(201)
    expect((await jsonOf<{ id: string }>(secondCreate)).id).toBe(
      (await jsonOf<{ id: string }>(firstCreate)).id
    )
    const listAfter = await jsonOf<{ items: unknown[] }>(
      await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`)
    )
    expect(listAfter.items.length).toBe(listBefore.items.length + 1)
    const reused = await bearerFetch('gate-owner', `/v1/organizations/${orgId}/work-items`, {
      method: 'POST',
      headers: dupHeaders,
      body: JSON.stringify({ teamId: team.id, title: 'Changed payload' })
    })
    expect(reused.status).toBe(409)

    // Gate condition: stale ETag → 412 (conflict is surfaced, not last-write-wins).
    const stale = await bearerFetch(
      'gate-owner',
      `/v1/organizations/${orgId}/work-items/${workItem.id}`,
      {
        method: 'PATCH',
        headers: { 'if-match': '"work-item-1"', 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify({ title: 'Renamed' })
      }
    )
    expect(stale.status).toBe(412)

    // Gate condition: cross-tenant — a different owner's org cannot read this work item.
    const other = await jsonOf<{ organizationId: string }>(
      await bearerFetch('gate-other', '/v1/provisioning', {
        method: 'POST',
        body: JSON.stringify({ organizationDisplayName: 'Other Org' })
      })
    )
    const crossOrgRead = await bearerFetch(
      'gate-owner',
      `/v1/organizations/${other.organizationId}/work-items/${workItem.id}`
    )
    expect(crossOrgRead.status).toBe(403)
  })
})
