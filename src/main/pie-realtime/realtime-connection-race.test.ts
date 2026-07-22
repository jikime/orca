import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createRealtimeConnection, type RealtimeConnection } from './realtime-connection'
import type { RealtimeSocketHandlers } from './realtime-socket'

type FakeSocket = {
  handlers: RealtimeSocketHandlers
  open: boolean
  sent: string[]
}

let connection: RealtimeConnection | null = null

afterEach(() => {
  connection?.stop()
  connection = null
})

describe('realtime connection socket races', () => {
  it('deduplicates reconnects and never sends a stale open through a connecting socket', async () => {
    const sockets: FakeSocket[] = []
    connection = createRealtimeConnection({
      url: 'ws://127.0.0.1:9/realtime',
      instanceId: 'pie-desktop-test',
      organizationId: '11111111-1111-4111-8111-111111111111',
      getAccessToken: () => 'test-token',
      reconnect: { baseMs: 5, maxMs: 5, jitterRatio: 0 },
      socketFactory: (_url, handlers) => {
        const fake: FakeSocket = { handlers, open: false, sent: [] }
        sockets.push(fake)
        return {
          send: (data) => {
            if (!fake.open) {
              throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
            }
            fake.sent.push(data)
          },
          // Reproduce ws close delivery during deliberate reconnect teardown.
          close: () => handlers.onClose()
        }
      }
    })

    connection.start()
    sockets[0]!.open = true
    sockets[0]!.handlers.onOpen()
    sockets[0]!.handlers.onMessage('{}')
    await delay(30)

    // A deliberate close and its close callback must share one reconnect timer.
    expect(sockets).toHaveLength(2)
    sockets[1]!.open = true
    expect(() => sockets[1]!.handlers.onOpen()).not.toThrow()
    expect(sockets[1]!.sent).toHaveLength(1)
  })
})
