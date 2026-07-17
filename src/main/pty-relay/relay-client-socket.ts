import { WebSocket } from 'ws'

// Transport seam for a relay client (host or viewer). Injecting `connect` lets
// tests wrap the real `ws` client to record outbound traffic (view-only proof)
// while still driving a real relay server. The bridge is transport-agnostic, so
// nothing here assumes a local-only connection — it works over SSH-forwarded or
// remote relays just the same.
export type RelayClientSocket = {
  send(data: string): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

export type RelayConnect = (url: string) => Promise<RelayClientSocket>

// Real `ws`-backed connector. Resolves once the socket is open so the caller can
// immediately send `join`.
export const connectWsRelayClientSocket: RelayConnect = (url) =>
  new Promise<RelayClientSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    const onOpenError = (error: Error): void => reject(error)
    ws.once('error', onOpenError)
    ws.once('open', () => {
      ws.off('error', onOpenError)
      resolve({
        send: (data) => ws.send(data),
        onMessage: (cb) => ws.on('message', (raw) => cb(String(raw))),
        onClose: (cb) => ws.on('close', () => cb()),
        close: () => ws.close()
      })
    })
  })
