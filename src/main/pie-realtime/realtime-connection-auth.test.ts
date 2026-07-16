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

  it('passes null when signed out', () => {
    let capturedToken: string | null | undefined = 'unset'
    connection = createRealtimeConnection({
      url: 'ws://127.0.0.1:9/realtime',
      instanceId: 'pie-desktop-test',
      organizationId: '11111111-1111-4111-8111-111111111111',
      getAccessToken: () => null,
      socketFactory: (_url, _handlers, authToken) => {
        capturedToken = authToken
        return { send: () => {}, close: () => {} }
      }
    })
    connection.start()
    expect(capturedToken).toBeNull()
  })
})
