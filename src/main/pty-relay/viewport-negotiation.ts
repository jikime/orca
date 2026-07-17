import { isValidPtySize, normalizePtySize } from '../daemon/daemon-pty-size'

// Pure size negotiator for a multi-viewer PTY. A single PTY can only be one size,
// so when several participants view it at different terminal sizes the effective
// size must be the element-wise MIN (cols and rows independently) across all live
// participants — that way NO viewer ever sees wrapped or truncated output. The
// host counts as a participant too. Deterministic, no I/O, no timers.

export type PtyViewport = { cols: number; rows: number }

export type ViewportNegotiatorConfig = {
  // Size to use when NO participant has a valid viewport, so the PTY is never
  // driven to a zero/negative size.
  hostFallback: PtyViewport
}

export type ViewportNegotiator = {
  setViewport(participantId: string, viewport: PtyViewport): void
  removeParticipant(participantId: string): void
  effectiveSize(): PtyViewport
  onEffectiveSizeChanged(cb: (size: PtyViewport) => void): () => void
}

export function createViewportNegotiator(config: ViewportNegotiatorConfig): ViewportNegotiator {
  // Normalize the fallback once so a bad config can never yield a zero size.
  const fallback = normalizePtySize(config.hostFallback.cols, config.hostFallback.rows)
  const viewports = new Map<string, PtyViewport>()
  const listeners: ((size: PtyViewport) => void)[] = []

  const compute = (): PtyViewport => {
    let cols = Infinity
    let rows = Infinity
    for (const viewport of viewports.values()) {
      // A participant with no/invalid size is ignored rather than shrinking
      // everyone to a bogus size; it simply doesn't constrain the min.
      if (!isValidPtySize(viewport.cols, viewport.rows)) {
        continue
      }
      cols = Math.min(cols, viewport.cols)
      rows = Math.min(rows, viewport.rows)
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return fallback
    }
    return normalizePtySize(cols, rows)
  }

  let lastEmitted = compute()

  const recompute = (): void => {
    const next = compute()
    // Dedupe: fire only when the effective size actually changes, so a larger
    // participant joining behind the current min never triggers a redundant
    // PTY resize.
    if (next.cols === lastEmitted.cols && next.rows === lastEmitted.rows) {
      return
    }
    lastEmitted = next
    for (const listener of listeners.slice()) {
      listener(next)
    }
  }

  return {
    setViewport(participantId, viewport) {
      viewports.set(participantId, viewport)
      recompute()
    },
    removeParticipant(participantId) {
      if (viewports.delete(participantId)) {
        recompute()
      }
    },
    effectiveSize: () => lastEmitted,
    onEffectiveSizeChanged(cb) {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx !== -1) {
          listeners.splice(idx, 1)
        }
      }
    }
  }
}
