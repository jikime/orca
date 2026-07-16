import { describe, expect, it, vi } from 'vitest'
import { startWorker } from './worker-runtime'

describe('startWorker', () => {
  it('boots when the database is reachable and emits heartbeats', async () => {
    const onHeartbeat = vi.fn()
    const runtime = await startWorker({
      ping: async () => true,
      heartbeatIntervalMs: 5,
      log: () => {},
      onHeartbeat
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await runtime.stop()
    expect(onHeartbeat).toHaveBeenCalled()
  })

  it('refuses to start when the database is unreachable', async () => {
    await expect(
      startWorker({ ping: async () => false, heartbeatIntervalMs: 5, log: () => {} })
    ).rejects.toThrow(/cannot reach the database/i)
  })

  it('stops cleanly and halts heartbeats', async () => {
    const onHeartbeat = vi.fn()
    const runtime = await startWorker({
      ping: async () => true,
      heartbeatIntervalMs: 5,
      log: () => {},
      onHeartbeat
    })
    await runtime.stop()
    const countAfterStop = onHeartbeat.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onHeartbeat.mock.calls.length).toBe(countAfterStop)
  })
})
