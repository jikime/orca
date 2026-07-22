import { WebSocket } from 'ws'

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
  // The gateway verifies this Main-only token before subscribing the socket.
  authToken: string | null
) => RealtimeSocket

// Reuses the `ws` client already used by the relay transport in Main.
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
    send: (data) => {
      // Why: a stale callback must not crash Main through a replacement socket
      // that is still connecting.
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data)
      }
    },
    close: () => socket.close()
  }
}
