import { WebSocket } from 'ws'
import {
  PIE_REALTIME_PROTOCOL_VERSION,
  PieRealtimeServerMessageSchema,
  type PieRealtimeResourceChanged
} from '../../shared/pie-realtime-contract'

export type RealtimeSocketHandlers = {
  onOpen: () => void
  onMessage: (data: string) => void
  onClose: () => void
  onError: (error: unknown) => void
}

export type RealtimeSocket = {
  send: (data: string) => void
  close: () => void
}

export type RealtimeSocketFactory = (
  url: string,
  handlers: RealtimeSocketHandlers,
  // Bearer access token carried on the WS upgrade (Main-only ws client). The
  // gateway verifies it and the subject's membership before subscribing.
  authToken: string | null
) => RealtimeSocket

// Reuses the `ws` client already used by the relay transport in main; adds no
// new dependency.
export const defaultRealtimeSocketFactory: RealtimeSocketFactory = (url, handlers, authToken) => {
  const socket = new WebSocket(
    url,
    authToken ? { headers: { authorization: `Bearer ${authToken}` } } : undefined
  )
  socket.on('open', () => handlers.onOpen())
  socket.on('message', (data: Buffer) => handlers.onMessage(data.toString()))
  socket.on('close', () => handlers.onClose())
  socket.on('error', (error) => handlers.onError(error))
  return {
    send: (data) => socket.send(data),
    close: () => socket.close()
  }
}

export type RealtimeClientStatus =
  | { state: 'disabled' }
  | { state: 'connecting'; attempt: number }
  | { state: 'connected'; connectionId: string; lastCursor: string | null }
  | { state: 'reconnecting'; attempt: number; reason: string }
  | { state: 'resync-needed'; reason: string }
  | { state: 'revoked'; reason: string }
  | { state: 'stopped' }

export type RealtimeConnectionOptions = {
  url: string
  instanceId: string
  organizationId: string
  capabilities?: string[]
  socketFactory?: RealtimeSocketFactory
  // Supplies the current access token for the WS upgrade (from the auth lifecycle
  // via the composition root — never the renderer). Read at each connect attempt.
  getAccessToken?: () => string | null
  // Injected recovery fetch (the REST listResourceChanges call); keeps this
  // module transport-pure. Returns changes after the given cursor.
  fetchChanges?: (afterCursor: string | null) => Promise<PieRealtimeResourceChanged[]>
  isDisabled?: () => boolean
  reconnect?: { baseMs?: number; maxMs?: number; jitterRatio?: number }
  defaultHeartbeatTimeoutMs?: number
  onChange?: (message: PieRealtimeResourceChanged) => void
  onStatus?: (status: RealtimeClientStatus) => void
  onSessionRevoked?: (reason: string) => void
  log?: (message: string) => void
  now?: () => number
  random?: () => number
}

export type RealtimeConnection = {
  start: () => void
  stop: () => void
  getStatus: () => RealtimeClientStatus
}

// The platform issues cursors as `cursor-<zero-padded sequence>`; decoding the
// sequence lets us dedupe an at-least-once stream numerically. Unparseable
// cursors fall back to exact-string dedupe.
function cursorSequence(cursor: string): number | null {
  const match = /^cursor-(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : null
}

export function createRealtimeConnection(options: RealtimeConnectionOptions): RealtimeConnection {
  const socketFactory = options.socketFactory ?? defaultRealtimeSocketFactory
  const log = options.log ?? (() => {})
  const random = options.random ?? Math.random
  const baseMs = options.reconnect?.baseMs ?? 1000
  const maxMs = options.reconnect?.maxMs ?? 30_000
  const jitterRatio = options.reconnect?.jitterRatio ?? 0.25
  const defaultHeartbeatTimeoutMs = options.defaultHeartbeatTimeoutMs ?? 45_000

  let socket: RealtimeSocket | null = null
  let stopped = false
  let revoked = false
  let attempt = 0
  let connectionId: string | null = null
  let lastAppliedSequence: number | null = null
  let lastAppliedCursor: string | null = null
  let heartbeatTimeoutMs = defaultHeartbeatTimeoutMs
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let status: RealtimeClientStatus = { state: 'disabled' }

  function setStatus(next: RealtimeClientStatus): void {
    status = next
    options.onStatus?.(next)
  }

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function armHeartbeatWatchdog(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
    }
    heartbeatTimer = setTimeout(() => {
      // No frame within the interval → treat the link as dead and reconnect.
      log('[pie-realtime] heartbeat timeout; reconnecting')
      dropSocketAndReconnect('heartbeat-timeout')
    }, heartbeatTimeoutMs)
    if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
      heartbeatTimer.unref()
    }
  }

  function scheduleReconnect(reason: string, delayMs?: number): void {
    if (stopped || revoked) {
      return
    }
    attempt += 1
    const backoff = delayMs ?? Math.min(maxMs, baseMs * 2 ** (attempt - 1))
    const jitter = backoff * jitterRatio * random()
    setStatus({ state: 'reconnecting', attempt, reason })
    reconnectTimer = setTimeout(() => connect(), backoff + jitter)
    if (typeof reconnectTimer === 'object' && 'unref' in reconnectTimer) {
      reconnectTimer.unref()
    }
  }

  function dropSocketAndReconnect(reason: string): void {
    if (socket) {
      const closing = socket
      socket = null
      closing.close()
    }
    connectionId = null
    scheduleReconnect(reason)
  }

  function isNewChange(cursor: string): boolean {
    const sequence = cursorSequence(cursor)
    if (sequence !== null) {
      return lastAppliedSequence === null || sequence > lastAppliedSequence
    }
    return cursor !== lastAppliedCursor
  }

  function markApplied(cursor: string): void {
    const sequence = cursorSequence(cursor)
    if (sequence !== null) {
      lastAppliedSequence = sequence
    }
    lastAppliedCursor = cursor
  }

  function applyChange(message: PieRealtimeResourceChanged): void {
    if (!isNewChange(message.cursor)) {
      return
    }
    markApplied(message.cursor)
    options.onChange?.(message)
  }

  async function runResync(reason: string): Promise<void> {
    setStatus({ state: 'resync-needed', reason })
    if (!options.fetchChanges) {
      return
    }
    try {
      const changes = await options.fetchChanges(lastAppliedCursor)
      for (const change of changes) {
        applyChange(change)
      }
      if (connectionId) {
        setStatus({ state: 'connected', connectionId, lastCursor: lastAppliedCursor })
      }
    } catch (error) {
      // A failed catch-up leaves us in resync-needed; the next reconnect retries.
      log(`[pie-realtime] resync fetch failed: ${String(error)}`)
    }
  }

  function send(payload: unknown): void {
    socket?.send(JSON.stringify(payload))
  }

  function handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      log('[pie-realtime] malformed frame; dropping connection')
      dropSocketAndReconnect('malformed-frame')
      return
    }
    const result = PieRealtimeServerMessageSchema.safeParse(parsed)
    if (!result.success) {
      // NEVER dispatch unvalidated data — a protocol error closes + reconnects.
      log('[pie-realtime] invalid message; dropping connection')
      dropSocketAndReconnect('invalid-message')
      return
    }
    // Any valid frame is a liveness signal.
    armHeartbeatWatchdog()
    const message = result.data
    switch (message.type) {
      case 'server.welcome':
        connectionId = message.connectionId
        attempt = 0
        heartbeatTimeoutMs = message.heartbeatIntervalMs * 3
        armHeartbeatWatchdog()
        setStatus({ state: 'connected', connectionId, lastCursor: lastAppliedCursor })
        break
      case 'resource.changed':
        applyChange(message)
        break
      case 'heartbeat':
        if (message.direction === 'ping') {
          send({
            type: 'heartbeat',
            schemaVersion: 1,
            direction: 'pong',
            sentAt: new Date(options.now?.() ?? Date.now()).toISOString()
          })
        }
        break
      case 'resync.required':
        void runResync(message.reason)
        break
      case 'session.revoked':
        revoked = true
        setStatus({ state: 'revoked', reason: message.reason })
        options.onSessionRevoked?.(message.reason)
        clearTimers()
        socket?.close()
        socket = null
        break
      case 'connection.closing':
        if (message.reconnect) {
          dropSocketAndReconnect('server-closing')
        } else {
          stop()
        }
        break
      case 'presence.changed':
      case 'typing.changed':
        // Ephemeral collaboration signals: they carry no version and invalidate no
        // cache, so the Main connection validates them (above) and ignores them here.
        // Rendering presence/typing in the UI is a later renderer slice.
        break
    }
  }

  function connect(): void {
    if (stopped || revoked) {
      return
    }
    setStatus({ state: 'connecting', attempt })
    socket = socketFactory(
      options.url,
      {
        onOpen: () => {
          send({
            type: 'client.hello',
            schemaVersion: 1,
            protocolVersion: PIE_REALTIME_PROTOCOL_VERSION,
            instanceId: options.instanceId,
            organizationId: options.organizationId,
            lastCursor: lastAppliedCursor,
            ...(options.capabilities ? { capabilities: options.capabilities } : {})
          })
          armHeartbeatWatchdog()
        },
        onMessage: handleMessage,
        onClose: () => {
          if (stopped || revoked) {
            return
          }
          socket = null
          connectionId = null
          scheduleReconnect('socket-closed')
        },
        onError: (error) => {
          log(`[pie-realtime] socket error: ${String(error)}`)
        }
      },
      options.getAccessToken?.() ?? null
    )
  }

  return {
    start: () => {
      if (options.isDisabled?.()) {
        // Safe mode (or another gate) is active — never open a connection.
        setStatus({ state: 'disabled' })
        return
      }
      stopped = false
      revoked = false
      attempt = 0
      connect()
    },
    stop: () => {
      stopped = true
      clearTimers()
      if (socket) {
        const closing = socket
        socket = null
        closing.close()
      }
      connectionId = null
      setStatus({ state: 'stopped' })
    },
    getStatus: () => status
  }
}
