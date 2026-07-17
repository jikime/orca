// The seam between the PTY daemon and the relay host. The host subscribes to a
// PtyOutputSource and never touches the daemon directly, so its seal→frame→send
// logic is testable with a hand-rolled fake source (no real PTY required).

export type PtyOutputSource = {
  // Subscribe to live output chunks. Returns an unsubscribe function.
  onData(cb: (chunk: Uint8Array) => void): () => void
  // Fired once when the underlying PTY exits.
  onExit(cb: () => void): () => void
  // Current catch-up seed for a late joiner (the terminal's rendered screen
  // state), or null when there is nothing to catch up on. This is the mosaic
  // snapshot, NOT a replay of the whole byte history.
  snapshot(): Uint8Array | null
}

// Narrow structural view of `DaemonPtyRouter` (src/main/daemon/daemon-pty-router.ts).
// The real router satisfies this by shape, so we adapt it without importing the
// daemon stack — keeping the bridge decoupled and the fake-router unit test small.
export type DaemonPtyOutputRouter = {
  onData(cb: (payload: { id: string; data: string }) => void): () => void
  onExit(cb: (payload: { id: string; code: number }) => void): () => void
  getBufferSnapshot(
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{ data: string; scrollbackAnsi: string } | null>
}

// Re-reads the daemon's authoritative buffer snapshot into the cache that
// snapshot() returns. Async because the daemon snapshot is an RPC; the host
// primes it before (re)connecting so the sync snapshot() has a value.
export type DaemonPtyOutputSource = PtyOutputSource & {
  refreshSnapshot(): Promise<void>
}

// Adapts the real daemon router: filters its multiplexed output/exit streams to
// one session, re-encodes the daemon's decoded string output back to UTF-8 bytes
// for the E2EE seal, and surfaces the reattach snapshot as the late-joiner seed.
export function createDaemonPtyOutputSource(
  router: DaemonPtyOutputRouter,
  sessionId: string
): DaemonPtyOutputSource {
  const encoder = new TextEncoder()
  let cachedSnapshot: Uint8Array | null = null

  return {
    onData(cb) {
      return router.onData((payload) => {
        if (payload.id !== sessionId) {
          return
        }
        cb(encoder.encode(payload.data))
      })
    },
    onExit(cb) {
      return router.onExit((payload) => {
        if (payload.id !== sessionId) {
          return
        }
        cb()
      })
    },
    snapshot() {
      return cachedSnapshot
    },
    async refreshSnapshot() {
      const snapshot = await router.getBufferSnapshot(sessionId)
      if (!snapshot) {
        cachedSnapshot = null
        return
      }
      // Scrollback first, then the visible screen — the same order the renderer
      // reseeds a reattached terminal with (daemon-pty-adapter reattach payload).
      const seed = snapshot.scrollbackAnsi + snapshot.data
      cachedSnapshot = seed.length > 0 ? encoder.encode(seed) : null
    }
  }
}
