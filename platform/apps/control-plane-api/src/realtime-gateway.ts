import {
  decodeCursor,
  decodeEphemeralNotification,
  decodeResourceChangedNotification,
  encodeCursor,
  EPHEMERAL_CHANNEL,
  fireEphemeralNotification,
  getLatestPublishedSequence,
  getResourceChangeAtSequence,
  listChannelMemberUserIds,
  listResourceChanges,
  RESOURCE_CHANGED_CHANNEL,
  traceIdFromTraceparent,
  type EphemeralNotification,
  type PieDatabase
} from '@pie/persistence'
import { randomUUID } from 'node:crypto'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { createPostgresListenSource, type ListenSource } from './postgres-listen-source'

// pino-compatible subset (matches the worker's logger) for structured delivery logs.
export type GatewayLogger = {
  info: (fields: Record<string, unknown>, message?: string) => void
}

// Minimal transport surface so the gateway is testable with a fake socket and
// adapts cleanly to @fastify/websocket's ws socket.
export type RealtimeSocket = {
  send: (data: string) => void
  close: (code: number, reason: string) => void
  onMessage: (handler: (data: string) => void) => void
  onClose: (handler: () => void) => void
}

export type ConnectionAuthorization = { authorized: boolean; reason?: string; userId?: string }

export type RealtimeGatewayOptions = {
  db: PieDatabase
  registry: ContractSchemaRegistry
  listenConnectionString: string
  // Verifies the connection's bearer token and confirms the subject has an active
  // membership (with organization.read) in the requested org. The org is no longer
  // trusted from ClientHello — it is only honored after this authorizes it.
  authorizeConnection: (
    token: string | null,
    organizationId: string
  ) => Promise<ConnectionAuthorization>
  now?: () => number
  heartbeatIntervalMs?: number
  // Max changes a reconnecting client may be behind before we send resync.required
  // instead of a live delta (client then converges via listResourceChanges).
  resyncWindow?: number
  newConnectionId?: () => string
  logger?: GatewayLogger
}

export type RealtimeGateway = {
  start: () => Promise<void>
  handleConnection: (socket: RealtimeSocket, authToken: string | null) => void
  broadcastClosing: (reason: string) => void
  // Pushes session.revoked to a user's live connections (and closes them) so a
  // revoked client learns immediately (doc 01 "역할·세션 폐기가 다음 요청부터 반영").
  notifySessionRevoked: (userId: string, reason: string) => void
  catchUpAllAfterReconnect: () => Promise<void>
  connectionCount: () => number
  deliveredMessageCount: () => number
  stop: () => Promise<void>
}

type GatewayConnection = {
  id: string
  socket: RealtimeSocket
  organizationId: string
  userId: string | null
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
  let deliveredMessages = 0

  const listenSource: ListenSource = createPostgresListenSource({
    connectionString: options.listenConnectionString,
    // The durable resource channel AND the non-durable ephemeral channel. Ephemeral
    // is NOT caught up on reconnect (it is lossy by design) — only the durable path
    // runs catchUpAllAfterReconnect, so a presence/typing gap never triggers replay.
    channels: [RESOURCE_CHANGED_CHANNEL, EPHEMERAL_CHANNEL],
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
    // Fetch the org-scoped change + its traceparent (RLS keeps it tenant-safe).
    const change = await getResourceChangeAtSequence(options.db, organizationId, sequence)
    if (!change) {
      return
    }
    const traceId = traceIdFromTraceparent(change.traceparent)
    for (const connection of set) {
      if (sequence > connection.lastDeliveredSequence) {
        send(connection, 'resource.changed', change.message)
        connection.lastDeliveredSequence = sequence
        deliveredMessages += 1
        // The WS message carries no trace field (contract unchanged); the trace
        // id is logged server-side so the request is followable to delivery.
        options.logger?.info(
          {
            event: 'realtime.delivered',
            organizationId,
            sequence,
            traceId,
            connectionId: connection.id
          },
          'realtime delivered'
        )
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

  function userConnectionCount(organizationId: string, userId: string): number {
    const set = orgConnections.get(organizationId)
    if (!set) {
      return 0
    }
    let count = 0
    for (const connection of set) {
      if (connection.userId === userId) {
        count += 1
      }
    }
    return count
  }

  /** Fires a presence transition on the ephemeral channel so EVERY gateway (incl.
   *  this one) broadcasts it — presence works across horizontally-scaled gateways
   *  without a durable table. Best-effort; a dropped ping self-heals. */
  function firePresence(organizationId: string, userId: string, state: 'online' | 'offline'): void {
    void fireEphemeralNotification(options.db, {
      kind: 'presence',
      organizationId,
      userId,
      state,
      at: new Date(now()).toISOString()
    })
  }

  /** Org-level presence fan-out: online/offline to every connection in the org. No
   *  membership filter (presence is "who is online in the org"). */
  function deliverPresence(
    notification: Extract<EphemeralNotification, { kind: 'presence' }>
  ): void {
    const set = orgConnections.get(notification.organizationId)
    if (!set) {
      return
    }
    for (const connection of set) {
      send(connection, 'presence.changed', {
        type: 'presence.changed',
        schemaVersion: 1,
        organizationId: notification.organizationId,
        userId: notification.userId,
        state: notification.state,
        at: notification.at
      })
    }
  }

  /** Typing fan-out: only to the channel's OTHER members (a non-member must never
   *  learn who is typing). One membership read per typing event, bounded by the
   *  route's per-user rate cap. */
  async function deliverTyping(
    notification: Extract<EphemeralNotification, { kind: 'typing' }>
  ): Promise<void> {
    const set = orgConnections.get(notification.organizationId)
    if (!set || set.size === 0) {
      return
    }
    const members = new Set(
      await listChannelMemberUserIds(
        options.db,
        notification.organizationId,
        notification.channelId
      )
    )
    for (const connection of set) {
      if (!connection.userId || connection.userId === notification.userId) {
        continue
      }
      if (!members.has(connection.userId)) {
        continue
      }
      send(connection, 'typing.changed', {
        type: 'typing.changed',
        schemaVersion: 1,
        organizationId: notification.organizationId,
        channelId: notification.channelId,
        userId: notification.userId,
        at: notification.at
      })
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

  function handleConnection(socket: RealtimeSocket, authToken: string | null): void {
    let connection: GatewayConnection | null = null
    let handshakeComplete = false

    socket.onClose(() => {
      if (connection) {
        const { organizationId, userId } = connection
        removeConnection(connection)
        // Presence offline only when this was the user's LAST live connection (closing
        // one of several tabs keeps them online).
        if (userId && userConnectionCount(organizationId, userId) === 0) {
          firePresence(organizationId, userId, 'offline')
        }
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
          if (!options.registry.validate('client.hello', parsed)) {
            socket.send(
              JSON.stringify(closingMessage('protocol_unsupported', 'invalid client.hello', false))
            )
            socket.close(1002, 'invalid client.hello')
            return
          }
          const hello = parsed as { organizationId: string; lastCursor?: string | null }
          // The requested org is honored only after the bearer token is verified and
          // its subject is confirmed a member — the org is no longer trusted blindly.
          const authorization = await options.authorizeConnection(authToken, hello.organizationId)
          if (!authorization.authorized) {
            socket.send(JSON.stringify(closingMessage('session_revoked', 'unauthorized', false)))
            socket.close(1008, 'unauthorized')
            return
          }
          handshakeComplete = true
          const connectionUserId = authorization.userId ?? null
          // First live connection for this user → they just came online.
          const wasOffline =
            connectionUserId !== null &&
            userConnectionCount(hello.organizationId, connectionUserId) === 0
          connection = {
            id: newConnectionId(),
            socket,
            organizationId: hello.organizationId,
            userId: connectionUserId,
            lastDeliveredSequence: 0,
            heartbeatTimer: null
          }
          addConnection(connection)
          if (wasOffline && connectionUserId) {
            firePresence(hello.organizationId, connectionUserId, 'online')
          }
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

  function notifySessionRevoked(userId: string, reason: string): void {
    for (const set of orgConnections.values()) {
      for (const connection of set) {
        if (connection.userId !== userId) {
          continue
        }
        send(connection, 'session.revoked', {
          type: 'session.revoked',
          schemaVersion: 1,
          reason,
          effectiveAt: new Date(now()).toISOString()
        })
        connection.socket.close(1008, 'session revoked')
      }
    }
  }

  return {
    start: async () => {
      await listenSource.start((channel, payload) => {
        if (channel === RESOURCE_CHANGED_CHANNEL) {
          const notification = decodeResourceChangedNotification(payload)
          if (notification) {
            void deliver(notification.organizationId, notification.sequence)
          }
          return
        }
        if (channel === EPHEMERAL_CHANNEL) {
          const notification = decodeEphemeralNotification(payload)
          if (notification?.kind === 'presence') {
            deliverPresence(notification)
          } else if (notification?.kind === 'typing') {
            void deliverTyping(notification)
          }
        }
      })
    },
    handleConnection,
    broadcastClosing,
    notifySessionRevoked,
    catchUpAllAfterReconnect,
    connectionCount: () => {
      let total = 0
      for (const set of orgConnections.values()) {
        total += set.size
      }
      return total
    },
    deliveredMessageCount: () => deliveredMessages,
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
