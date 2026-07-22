import {
  PieRealtimeServerMessageSchema,
  type PieRealtimeEphemeral,
  type PieRealtimeResourceChanged
} from '../../shared/pie-realtime-contract'
import { cursorSequence } from './realtime-cursor-sequence'
import { buildClientHello } from './realtime-hello'
import {
  defaultRealtimeSocketFactory,
  type RealtimeSocket,
  type RealtimeSocketFactory
} from './realtime-socket'

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
  // Additive ephemeral presence/typing frames (not deduped against the cursor).
  onEphemeral?: (message: PieRealtimeEphemeral) => void
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

export function createRealtimeConnection(options: RealtimeConnectionOptions): RealtimeConnection {
  const socketFactory = options.socketFactory ?? defaultRealtimeSocketFactory
  const log = options.log ?? (() => {})
  const random = options.random ?? Math.random
  const baseMs = options.reconnect?.baseMs ?? 1000
  const maxMs = options.reconnect?.maxMs ?? 30_000
  const jitterRatio = options.reconnect?.jitterRatio ?? 0.25
  const defaultHeartbeatTimeoutMs = options.defaultHeartbeatTimeoutMs ?? 45_000

  let socket: RealtimeSocket | null = null
  let stopped = true
  let revoked = false
  let attempt = 0
  let nextSocketId = 0
  let activeSocketId: number | null = null
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
    if (stopped || revoked || reconnectTimer) {
      return
    }
    attempt += 1
    const backoff = delayMs ?? Math.min(maxMs, baseMs * 2 ** (attempt - 1))
    const jitter = backoff * jitterRatio * random()
    setStatus({ state: 'reconnecting', attempt, reason })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff + jitter)
    if (typeof reconnectTimer === 'object' && 'unref' in reconnectTimer) {
      reconnectTimer.unref()
    }
  }

  // Null the ref before closing so the onClose handler cannot re-enter reconnect
  // logic against a socket we are deliberately tearing down.
  function detachSocket(): void {
    if (socket) {
      const closing = socket
      socket = null
      activeSocketId = null
      closing.close()
    }
  }

  function dropSocketAndReconnect(reason: string): void {
    detachSocket()
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
        heartbeatTimeoutMs = message.heartbeatIntervalMs * 3
        armHeartbeatWatchdog()
        setStatus({ state: 'connected', connectionId, lastCursor: lastAppliedCursor })
        break
      case 'resource.changed':
        applyChange(message)
        break
      case 'heartbeat':
        // A heartbeat proves the connection survived beyond its handshake. Reset
        // backoff here so a repeatable post-welcome protocol failure cannot hot-loop.
        attempt = 0
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
        detachSocket()
        break
      case 'connection.closing':
        if (message.reconnect) {
          dropSocketAndReconnect('server-closing')
        } else {
          // Why: bare `stop()` is not in lexical scope (stop is only a method on
          // the returned object) — call the local closer to avoid a ReferenceError
          // that would crash Main on a non-reconnect close frame.
          stopConnection()
        }
        break
      case 'presence.changed':
      case 'typing.changed':
        // Validated above; surfaced additively for the chat renderer (no cache dedup).
        options.onEphemeral?.(message)
        break
      case 'remote_presence.changed':
      case 'remote_cursor.changed':
        // Why: all server protocol frames must be accepted even before a desktop
        // consumer exists, otherwise one remote-session event reconnect-loops chat.
        break
    }
  }

  function connect(): void {
    if (stopped || revoked) {
      return
    }
    const token = options.getAccessToken?.() ?? null
    setStatus({ state: 'connecting', attempt })
    if (!token) {
      // No access token yet (realtime starts at window-open, before sign-in). An
      // unauthenticated connect draws a NON-reconnect close that would stop us for
      // good; poll on a short delay until a token exists, then connect.
      scheduleReconnect('awaiting-token', 1000)
      return
    }
    const socketId = ++nextSocketId
    activeSocketId = socketId
    socket = socketFactory(
      options.url,
      {
        onOpen: () => {
          if (activeSocketId !== socketId) {
            return
          }
          send(buildClientHello(options, lastAppliedCursor))
          armHeartbeatWatchdog()
        },
        onMessage: (raw) => {
          if (activeSocketId === socketId) {
            handleMessage(raw)
          }
        },
        onClose: () => {
          if (stopped || revoked || activeSocketId !== socketId) {
            return
          }
          socket = null
          activeSocketId = null
          connectionId = null
          scheduleReconnect('socket-closed')
        },
        onError: (error) => {
          if (activeSocketId === socketId) {
            log(`[pie-realtime] socket error: ${String(error)}`)
          }
        }
      },
      token
    )
  }

  // Local closer shared by the public stop() and the non-reconnect
  // connection.closing frame, so both stop paths run identical teardown.
  function stopConnection(): void {
    stopped = true
    clearTimers()
    detachSocket()
    connectionId = null
    setStatus({ state: 'stopped' })
  }

  return {
    start: () => {
      if (options.isDisabled?.()) {
        // Safe mode (or another gate) is active — never open a connection.
        setStatus({ state: 'disabled' })
        return
      }
      if (!stopped && !revoked) {
        return
      }
      stopped = false
      revoked = false
      attempt = 0
      connect()
    },
    stop: stopConnection,
    getStatus: () => status
  }
}
