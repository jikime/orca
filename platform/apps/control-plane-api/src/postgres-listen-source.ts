import pg from 'pg'

export type NotificationHandler = (channel: string, payload: string) => void

export type ListenSource = {
  start: (onNotification: NotificationHandler) => Promise<void>
  stop: () => Promise<void>
}

export type PostgresListenSourceOptions = {
  connectionString: string
  channels: string[]
  // Called after a dropped LISTEN connection is re-established, so the gateway
  // can run a cursor-based catch-up for the notifications it may have missed.
  onReconnect?: () => void
  reconnectDelayMs?: number
}

/**
 * A dedicated long-lived connection doing LISTEN. NOTIFY is lossy across a
 * disconnect, so on any drop we reconnect, re-LISTEN, and signal onReconnect for
 * a catch-up. Channel names are fixed constants (never user input), so issuing
 * `LISTEN <channel>` without a bind parameter is safe.
 */
export function createPostgresListenSource(options: PostgresListenSourceOptions): ListenSource {
  let client: pg.Client | null = null
  let handler: NotificationHandler | null = null
  let stopped = false

  const connect = async (): Promise<void> => {
    const next = new pg.Client({ connectionString: options.connectionString })
    next.on('notification', (message) => {
      if (message.payload != null && handler) {
        handler(message.channel, message.payload)
      }
    })
    next.on('error', () => {
      void reconnect()
    })
    await next.connect()
    for (const channel of options.channels) {
      await next.query(`listen ${channel}`)
    }
    client = next
  }

  const reconnect = async (): Promise<void> => {
    if (stopped) {
      return
    }
    try {
      await client?.end()
    } catch {
      // The connection is already gone; proceed to re-establish it.
    }
    client = null
    await new Promise((resolve) => setTimeout(resolve, options.reconnectDelayMs ?? 500))
    if (stopped) {
      return
    }
    try {
      await connect()
      options.onReconnect?.()
    } catch {
      void reconnect()
    }
  }

  return {
    start: async (onNotification) => {
      handler = onNotification
      await connect()
    },
    stop: async () => {
      stopped = true
      try {
        await client?.end()
      } catch {
        // Best effort on shutdown.
      }
      client = null
    }
  }
}
