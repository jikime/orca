import { afterEach, describe, expect, it } from 'vitest'
import { createRealtimeConnection, type RealtimeConnection } from './realtime-connection'

let connection: RealtimeConnection | null = null

afterEach(() => {
  connection?.stop()
  connection = null
})

describe('realtime connection WS auth (R3)', () => {
  it('passes the access token from getAccessToken to the socket factory', () => {
    let capturedToken: string | null | undefined
    connection = createRealtimeConnection({
      url: 'ws://127.0.0.1:9/realtime',
      instanceId: 'pie-desktop-test',
      organizationId: '11111111-1111-4111-8111-111111111111',
      getAccessToken: () => 'ws-access-token',
      socketFactory: (_url, _handlers, authToken) => {
        capturedToken = authToken
        return { send: () => {}, close: () => {} }
      }
    })
    connection.start()
    expect(capturedToken).toBe('ws-access-token')
  })

  it('defers connecting while signed out — never opens an unauthenticated socket', () => {
    let socketOpened = false
    connection = createRealtimeConnection({
      url: 'ws://127.0.0.1:9/realtime',
      instanceId: 'pie-desktop-test',
      organizationId: '11111111-1111-4111-8111-111111111111',
      getAccessToken: () => null,
      reconnect: { baseMs: 10, maxMs: 10, jitterRatio: 0 },
      socketFactory: () => {
        socketOpened = true
        return { send: () => {}, close: () => {} }
      }
    })
    connection.start()
    // An unauthenticated connect draws a NON-reconnect close from the gateway that
    // would stop realtime permanently; with no token we wait instead of connecting.
    expect(socketOpened).toBe(false)
  })
})
