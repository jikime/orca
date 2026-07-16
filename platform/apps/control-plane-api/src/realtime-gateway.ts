import {
  decodeCursor,
  decodeResourceChangedNotification,
  encodeCursor,
  getLatestPublishedSequence,
  listResourceChanges,
  RESOURCE_CHANGED_CHANNEL,
  type PieDatabase
} from '@pie/persistence'
import { randomUUID } from 'node:crypto'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { createPostgresListenSource, type ListenSource } from './postgres-listen-source'

// Minimal transport surface so the gateway is testable with a fake socket and
// adapts cleanly to @fastify/websocket's ws socket.
export type RealtimeSocket = {
  send: (data: string) => void
  close: (code: number, reason: string) => void
  onMessage: (handler: (data: string) => void) => void
  onClose: (handler: () => void) => void
}

export type RealtimeGatewayOptions = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  listenConnectionString: string
  now?: () => number
  heartbeatIntervalMs?: number
  // Max changes a reconnecting client may be behind before we send resync.required
  // instead of a live delta (client then converges via listResourceChanges).
  resyncWindow?: number
  newConnectionId?: () => string
}

export type RealtimeGateway = {
  start: () => Promise<void>
  handleConnection: (socket: RealtimeSocket) => void
  broadcastClosing: (reason: string) => void
  catchUpAllAfterReconnect: () => Promise<void>
  connectionCount: () => number
  stop: () => Promise<void>
}

type GatewayConnection = {
  id: string
  socket: RealtimeSocket
  organizationId: string
  lastDeliveredSequence: number
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_RESYNC_WINDOW = 500

export function createRealtimeGateway(options: RealtimeGatewayOptions): RealtimeGateway {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS
  const resyncWindow = options.resyncWindow ?? DEFAULT_RESYNC_WINDOW
  const now = options.now ?? (() => Date.now())
  const newConnectionId = options.newConnectionId ?? (() => randomUUID())
  const orgConnections = new Map<string, Set<GatewayConnection>>()

  const listenSource: ListenSource = createPostgresListenSource({
    connectionString: options.listenConnectionString,
    channels: [RESOURCE_CHANGED_CHANNEL],
    onReconnect: () => {
      void catchUpAllAfterReconnect()
    }
  })

  function send(connection: GatewayConnection, messageType: string, message: unknown): void {
    // Belt-and-suspenders: never put a message on the wire that fails its own
    // contract schema.
    if (!options.registry.validate(messageType, message)) {
      return
    }
    connection.socket.send(JSON.stringify(message))
  }

  function addConnection(connection: GatewayConnection): void {
    let set = orgConnections.get(connection.organizationId)
    if (!set) {
      set = new Set()
      orgConnections.set(connection.organizationId, set)
    }
    set.add(connection)
  }

  function removeConnection(connection: GatewayConnection): void {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer)
    }
    const set = orgConnections.get(connection.organizationId)
    if (set) {
      set.delete(connection)
      if (set.size === 0) {
        orgConnections.delete(connection.organizationId)
      }
    }
  }

  async function catchUp(
    connection: GatewayConnection,
    lastCursor: string | null,
    currentMax: number
  ): Promise<void> {
    const lastSequence = lastCursor ? decodeCursor(lastCursor) : 0
    if (lastCursor && lastSequence === null) {
      send(connection, 'resync.required', resyncMessage('cursor_expired', encodeCursor(currentMax)))
      connection.lastDeliveredSequence = currentMax
      return
    }
    const from = lastSequence ?? 0
    if (currentMax - from > resyncWindow) {
      send(
        connection,
        'resync.required',
        resyncMessage('buffer_overflow', encodeCursor(currentMax))
      )
      connection.lastDeliveredSequence = currentMax
      return
    }
    connection.lastDeliveredSequence = from
    if (currentMax > from) {
      await deliverAfter(connection, lastCursor ?? encodeCursor(from))
    }
  }

  async function deliverAfter(connection: GatewayConnection, afterCursor: string): Promise<void> {
    const result = await listResourceChanges(options.db, connection.organizationId, {
      afterCursor,
      limit: resyncWindow
    })
    if (!result.ok) {
      return
    }
    for (const item of result.page.items) {
      const sequence = decodeCursor(item.cursor) ?? connection.lastDeliveredSequence
      if (sequence > connection.lastDeliveredSequence) {
        send(connection, 'resource.changed', item)
        connection.lastDeliveredSequence = sequence
      }
    }
  }

  async function deliver(organizationId: string, sequence: number): Promise<void> {
    const set = orgConnections.get(organizationId)
    if (!set || set.size === 0) {
      return
    }
    // Fetch the org-scoped change at this sequence (RLS keeps it tenant-safe).
    const result = await listResourceChanges(options.db, organizationId, {
      afterCursor: encodeCursor(sequence - 1),
      limit: 1
    })
    if (!result.ok || result.page.items.length === 0) {
      return
    }
    const message = result.page.items[0]!
    for (const connection of set) {
      if (sequence > connection.lastDeliveredSequence) {
        send(connection, 'resource.changed', message)
        connection.lastDeliveredSequence = sequence
      }
    }
  }

  async function catchUpAllAfterReconnect(): Promise<void> {
    for (const set of orgConnections.values()) {
      for (const connection of set) {
        await deliverAfter(connection, encodeCursor(connection.lastDeliveredSequence))
      }
    }
  }

  function startHeartbeat(connection: GatewayConnection): void {
    const timer = setInterval(() => {
      send(connection, 'heartbeat', {
        type: 'heartbeat',
        schemaVersion: 1,
        direction: 'ping',
        sentAt: new Date(now()).toISOString()
      })
    }, heartbeatIntervalMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    connection.heartbeatTimer = timer
  }

  function handleConnection(socket: RealtimeSocket): void {
    let connection: GatewayConnection | null = null
    let handshakeComplete = false

    socket.onClose(() => {
      if (connection) {
        removeConnection(connection)
      }
    })

    socket.onMessage((raw) => {
      void (async () => {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          socket.close(1002, 'malformed message')
          return
        }
        if (!handshakeComplete) {
          // The first message MUST be a valid client.hello; the org comes from it
          // (authn stand-in — R3 replaces this with the token subject + membership).
          if (!options.registry.validate('client.hello', parsed)) {
            socket.send(
              JSON.stringify(closingMessage('protocol_unsupported', 'invalid client.hello', false))
            )
            socket.close(1002, 'invalid client.hello')
            return
          }
          handshakeComplete = true
          const hello = parsed as { organizationId: string; lastCursor?: string | null }
          connection = {
            id: newConnectionId(),
            socket,
            organizationId: hello.organizationId,
            lastDeliveredSequence: 0,
            heartbeatTimer: null
          }
          addConnection(connection)
          const currentMax = await getLatestPublishedSequence(options.db, hello.organizationId)
          send(connection, 'server.welcome', {
            type: 'server.welcome',
            schemaVersion: 1,
            protocolVersion: '1.0',
            connectionId: connection.id,
            cursor: encodeCursor(currentMax),
            heartbeatIntervalMs
          })
          await catchUp(connection, hello.lastCursor ?? null, currentMax)
          startHeartbeat(connection)
        }
        // Post-handshake client frames (heartbeat pong) need no server action here.
      })()
    })
  }

  function broadcastClosing(reason: string): void {
    for (const set of orgConnections.values()) {
      for (const connection of set) {
        send(connection, 'connection.closing', closingMessage('server_shutdown', reason, true))
      }
    }
  }

  return {
    start: async () => {
      await listenSource.start((channel, payload) => {
        if (channel !== RESOURCE_CHANGED_CHANNEL) {
          return
        }
        const notification = decodeResourceChangedNotification(payload)
        if (notification) {
          void deliver(notification.organizationId, notification.sequence)
        }
      })
    },
    handleConnection,
    broadcastClosing,
    catchUpAllAfterReconnect,
    connectionCount: () => {
      let total = 0
      for (const set of orgConnections.values()) {
        total += set.size
      }
      return total
    },
    stop: async () => {
      for (const set of orgConnections.values()) {
        for (const connection of set) {
          if (connection.heartbeatTimer) {
            clearInterval(connection.heartbeatTimer)
          }
        }
      }
      orgConnections.clear()
      await listenSource.stop()
    }
  }
}

function resyncMessage(reason: string, cursor: string | null): unknown {
  return { type: 'resync.required', schemaVersion: 1, reason, cursor }
}

function closingMessage(code: string, reason: string, reconnect: boolean): unknown {
  return { type: 'connection.closing', schemaVersion: 1, code, reason, reconnect }
}
