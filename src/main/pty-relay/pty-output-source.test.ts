import { describe, expect, test } from 'vitest'
import { createDaemonPtyOutputSource, type DaemonPtyOutputRouter } from './pty-output-source'
import {
  decodePtyStreamFrame,
  encodePtyStreamFrame,
  PTY_STREAM_FRAME_KIND
} from './pty-stream-frame'

// Minimal fake with the same shape as DaemonPtyRouter so the adapter is testable
// without the daemon stack.
function createFakeRouter(
  snapshot: { data: string; scrollbackAnsi: string } | null
): DaemonPtyOutputRouter & {
  emitData(id: string, data: string): void
  emitExit(id: string, code: number): void
} {
  const dataCbs: ((p: { id: string; data: string }) => void)[] = []
  const exitCbs: ((p: { id: string; code: number }) => void)[] = []
  return {
    onData(cb) {
      dataCbs.push(cb)
      return () => {
        const i = dataCbs.indexOf(cb)
        if (i !== -1) {
          dataCbs.splice(i, 1)
        }
      }
    },
    onExit(cb) {
      exitCbs.push(cb)
      return () => {
        const i = exitCbs.indexOf(cb)
        if (i !== -1) {
          exitCbs.splice(i, 1)
        }
      }
    },
    async getBufferSnapshot() {
      return snapshot
    },
    emitData(id, data) {
      for (const cb of dataCbs) {
        cb({ id, data })
      }
    },
    emitExit(id, code) {
      for (const cb of exitCbs) {
        cb({ id, code })
      }
    }
  }
}

describe('createDaemonPtyOutputSource', () => {
  test('forwards only the target session output, re-encoded to UTF-8 bytes', () => {
    const router = createFakeRouter(null)
    const source = createDaemonPtyOutputSource(router, 'session-A')
    const received: Uint8Array[] = []
    source.onData((chunk) => received.push(chunk))

    router.emitData('session-B', 'other-session') // filtered out
    router.emitData('session-A', 'hello')

    expect(received).toHaveLength(1)
    expect(new TextDecoder().decode(received[0])).toBe('hello')
  })

  test('fires exit only for the target session', () => {
    const router = createFakeRouter(null)
    const source = createDaemonPtyOutputSource(router, 'session-A')
    let exits = 0
    source.onExit(() => {
      exits += 1
    })

    router.emitExit('session-B', 0) // filtered out
    router.emitExit('session-A', 0)

    expect(exits).toBe(1)
  })

  test('snapshot() returns the refreshed daemon buffer as scrollback+screen bytes', async () => {
    const router = createFakeRouter({ scrollbackAnsi: 'past\n', data: 'now' })
    const source = createDaemonPtyOutputSource(router, 'session-A')

    expect(source.snapshot()).toBeNull() // not primed yet
    await source.refreshSnapshot()

    expect(new TextDecoder().decode(source.snapshot()!)).toBe('past\nnow')
  })

  test('snapshot() stays null when the daemon has no buffer', async () => {
    const source = createDaemonPtyOutputSource(createFakeRouter(null), 'session-A')
    await source.refreshSnapshot()
    expect(source.snapshot()).toBeNull()
  })
})

describe('pty-stream-frame', () => {
  test('round-trips a kind + payload', () => {
    const payload = new TextEncoder().encode('chunk')
    const framed = encodePtyStreamFrame(PTY_STREAM_FRAME_KIND.data, payload)
    const decoded = decodePtyStreamFrame(framed)
    expect(decoded?.kind).toBe(PTY_STREAM_FRAME_KIND.data)
    expect(new TextDecoder().decode(decoded!.payload)).toBe('chunk')
  })

  test('rejects an empty or unknown-kind frame', () => {
    expect(decodePtyStreamFrame(new Uint8Array(0))).toBeNull()
    expect(decodePtyStreamFrame(new Uint8Array([99, 1, 2]))).toBeNull()
  })
})
