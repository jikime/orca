import { createViewportNegotiator, type PtyViewport } from './viewport-negotiation'

// Composes viewport negotiation onto the host bridge (C1 forwards output; this
// handles the C2 multi-viewer min-size). The host is a participant too, so its
// own terminal size joins the MIN negotiation, and every effective-size change
// drives the injected `resize` — in the app that calls the daemon router's
// resize(sessionId, cols, rows). The resize is injected, not a hard daemon
// dependency, exactly like C1 injects connect/seal.

export type PtyRelayHostViewportConfig = {
  // Stable id for the host's own terminal viewport participant.
  hostParticipantId: string
  hostViewport: PtyViewport
  resize: (cols: number, rows: number) => void
}

export type PtyRelayHostViewport = {
  reportViewerViewport(participantId: string, viewport: PtyViewport): void
  dropViewer(participantId: string): void
  effectiveSize(): PtyViewport
}

export function createPtyRelayHostViewport(
  config: PtyRelayHostViewportConfig
): PtyRelayHostViewport {
  const negotiator = createViewportNegotiator({ hostFallback: config.hostViewport })
  negotiator.onEffectiveSizeChanged((size) => {
    config.resize(size.cols, size.rows)
  })
  // Registering the host at the fallback size does not fire a resize (it equals
  // the current effective size); the PTY already renders at the host's size.
  negotiator.setViewport(config.hostParticipantId, config.hostViewport)

  return {
    // TODO(pie-c2): viewer→host viewport reports arrive through this injected
    // ingress seam. The relay/control-plane transport that carries them
    // end-to-end lands with C3's control channel — the @pie/relay wire contract
    // has no viewer-safe non-frame message today, and a viewer may not send
    // `control` frames, so adding one is a B-layer change out of scope for C2.
    reportViewerViewport(participantId, viewport) {
      negotiator.setViewport(participantId, viewport)
    },
    dropViewer(participantId) {
      negotiator.removeParticipant(participantId)
    },
    effectiveSize: () => negotiator.effectiveSize()
  }
}
