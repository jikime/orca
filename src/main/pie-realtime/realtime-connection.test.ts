import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRealtimeConnection,
  type RealtimeClientStatus,
  type RealtimeConnection
} from './realtime-connection'

type ConnectionHandler = (socket: WebSocket, send: (message: unknown) => void) => void

type MockServer = {
  url: string
  connectionCount: () => number
  receivedByAll: () => unknown[]
  close: () => Promise<void>
}

async function startMockServer(onConnection: ConnectionHandler): Promise<MockServer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const received: unknown[] = []
  let connections = 0
  server.on('connection', (socket) => {
    connections += 1
    socket.on('message', (data: Buffer) => received.push(JSON.parse(data.toString())))
    onConnection(socket, (message) => socket.send(JSON.stringify(message)))
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${port}`,
    connectionCount: () => connections,
    receivedByAll: () => received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate()
        }
        server.close(() => resolve())
      })
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return
    }
    await delay(10)
  }
  throw new Error('waitUntil timed out')
}

function welcome(cursor = 'cursor-00000000') {
  return {
    type: 'server.welcome',
    schemaVersion: 1,
    protocolVersion: '1.0',
    connectionId: '55555555-5555-4555-8555-555555555555',
    cursor,
    heartbeatIntervalMs: 1000
  }
}

function change(sequence: number) {
  return {
    type: 'resource.changed',
    schemaVersion: 1,
    eventId: '77777777-7777-4777-8777-777777777777',
    cursor: `cursor-${String(sequence).padStart(8, '0')}`,
    organizationId: '11111111-1111-4111-8111-111111111111',
    resourceType: 'organization',
    resourceId: '66666666-6666-4666-8666-666666666666',
    changeKind: 'updated',
    version: sequence,
    occurredAt: '2026-07-15T10:45:00Z'
  }
}

let connection: RealtimeConnection | null = null
let server: MockServer | null = null

afterEach(async () => {
  connection?.stop()
  connection = null
  await server?.close()
  server = null
})

function connect(overrides: Partial<Parameters<typeof createRealtimeConnection>[0]> = {}): {
  changes: unknown[]
  statuses: RealtimeClientStatus[]
} {
  const changes: unknown[] = []
  const statuses: RealtimeClientStatus[] = []
  connection = createRealtimeConnection({
    url: server!.url,
    instanceId: 'pie-desktop-test',
    organizationId: '11111111-1111-4111-8111-111111111111',
    reconnect: { baseMs: 10, maxMs: 40, jitterRatio: 0 },
    defaultHeartbeatTimeoutMs: 120,
    // A token is required to connect (an unauthenticated connect is deferred);
    // tests exercising the no-token path override this with () => null.
    getAccessToken: () => 'test-token',
    onChange: (message) => changes.push(message),
    onStatus: (status) => statuses.push(status),
    ...overrides
  })
  connection.start()
  return { changes, statuses }
}

describe('createRealtimeConnection', () => {
  it('handshakes and dedupes resource changes by cursor', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send(change(1))
      send(change(1)) // duplicate cursor — must be ignored
      send(change(2))
    })
    const { changes } = connect()
    await waitUntil(() => changes.length >= 2)
    await delay(50)
    expect(changes.map((c) => (c as { cursor: string }).cursor)).toEqual([
      'cursor-00000001',
      'cursor-00000002'
    ])
    expect(connection!.getStatus().state).toBe('connected')
  })

  it('keeps the connection open for resource types added by other product verticals', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({ ...change(1), resourceType: 'meeting' })
    })
    const { changes } = connect()
    await waitUntil(() => changes.length === 1)
    await delay(80)
    expect(server.connectionCount()).toBe(1)
    expect(connection!.getStatus().state).toBe('connected')
  })

  it('answers a heartbeat ping with a pong', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({
        type: 'heartbeat',
        schemaVersion: 1,
        direction: 'ping',
        sentAt: '2026-07-15T04:00:00.000Z'
      })
    })
    connect()
    await waitUntil(() =>
      server!
        .receivedByAll()
        .some((m) => (m as { type?: string; direction?: string }).direction === 'pong')
    )
  })

  it('reconnects after a heartbeat timeout', async () => {
    // Server accepts but stays silent → client's default watchdog fires.
    server = await startMockServer(() => {})
    connect()
    await waitUntil(() => server!.connectionCount() >= 2)
  })

  it('emits resync-needed and converges through the injected fetch', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({ type: 'resync.required', schemaVersion: 1, reason: 'buffer_overflow', cursor: null })
    })
    const { changes, statuses } = connect({
      fetchChanges: async () => [change(7) as never]
    })
    await waitUntil(() => changes.length >= 1)
    expect((changes[0] as { cursor: string }).cursor).toBe('cursor-00000007')
    expect(statuses.some((s) => s.state === 'resync-needed')).toBe(true)
    await waitUntil(() => connection!.getStatus().state === 'connected')
  })

  it('drops to revoked without reconnecting on session.revoked', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({
        type: 'session.revoked',
        schemaVersion: 1,
        reason: 'admin_revoke',
        effectiveAt: '2026-07-15T10:45:00Z'
      })
    })
    connect()
    await waitUntil(() => connection!.getStatus().state === 'revoked')
    await delay(120)
    expect(server!.connectionCount()).toBe(1)
  })

  it('reconnects on connection.closing with reconnect=true', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({
        type: 'connection.closing',
        schemaVersion: 1,
        code: 'server_shutdown',
        reason: 'restart',
        reconnect: true
      })
    })
    connect()
    await waitUntil(() => server!.connectionCount() >= 2)
  })

  it('stops without reconnecting on connection.closing with reconnect=false', async () => {
    // Regression: this frame used to call a bare `stop()` that was not in scope,
    // throwing a ReferenceError that crashed Main. It must reach 'stopped'.
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({
        type: 'connection.closing',
        schemaVersion: 1,
        code: 'server_shutdown',
        reason: 'restart',
        reconnect: false
      })
    })
    connect()
    await waitUntil(() => connection!.getStatus().state === 'stopped')
    await delay(80)
    // No reconnect after a non-reconnect close.
    expect(server!.connectionCount()).toBe(1)
  })

  it('never dispatches an invalid message and reconnects instead', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      // version 0 violates the contract (min 1).
      send({ ...change(1), version: 0 })
    })
    const { changes } = connect()
    await waitUntil(() => server!.connectionCount() >= 2)
    expect(changes).toHaveLength(0)
  })

  it('backs off when the same post-welcome protocol failure repeats', async () => {
    server = await startMockServer((_socket, send) => {
      send(welcome())
      send({ type: 'unknown.future-frame', schemaVersion: 1 })
    })
    connect({ reconnect: { baseMs: 10, maxMs: 40, jitterRatio: 0 } })
    await delay(85)
    expect(server.connectionCount()).toBeLessThanOrEqual(4)
  })

  it('does not connect when the subsystem is disabled (safe mode)', async () => {
    server = await startMockServer(() => {})
    connect({ isDisabled: () => true })
    await delay(80)
    expect(server!.connectionCount()).toBe(0)
    expect(connection!.getStatus().state).toBe('disabled')
  })
})
