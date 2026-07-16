export type WorkerRuntime = {
  stop: () => Promise<void>
}

export type StartWorkerDeps = {
  ping: () => Promise<boolean>
  heartbeatIntervalMs: number
  log?: (message: string) => void
  // Test seam: invoked on every heartbeat tick.
  onHeartbeat?: () => void
}

/**
 * Boots the worker liveness runtime: verifies the database is reachable, then
 * emits a periodic heartbeat log. The SKIP LOCKED outbox claim loop runs
 * alongside this (wired in index.ts), not inside it.
 */
export async function startWorker(deps: StartWorkerDeps): Promise<WorkerRuntime> {
  const log = deps.log ?? ((message: string) => console.log(message))

  const reachable = await deps.ping()
  if (!reachable) {
    throw new Error('control-plane-worker cannot reach the database')
  }
  log('[control-plane-worker] connected; heartbeat running (claim loop wired in index.ts)')

  const timer = setInterval(() => {
    log('[control-plane-worker] heartbeat')
    deps.onHeartbeat?.()
  }, deps.heartbeatIntervalMs)
  // Why: the heartbeat must not keep the event loop alive on its own during a
  // graceful shutdown.
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }

  return {
    stop: async () => {
      clearInterval(timer)
    }
  }
}
