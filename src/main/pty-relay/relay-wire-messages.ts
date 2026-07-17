// Client-side view of the relay wire protocol. This is the minimal subset the
// PTY bridge builds (inbound) and parses (outbound); it deliberately mirrors the
// relay's source-of-truth contract at platform/apps/relay/src/relay-wire-contract.ts.
//
// Why a local copy instead of importing that file: the relay is a separate pnpm
// workspace (@pie/relay, its own zod), and the Electron client is a composite
// TS project — importing across that build boundary is not allowed. Keeping a
// dependency-free type mirror here is the standard client pattern and carries no
// zod/runtime coupling. If the relay contract changes, update this in lockstep.

export const RELAY_PROTOCOL_VERSION = '1.0'

export type RelayFrameDirection = 'output' | 'control'

// ── Client -> relay (built by the bridge) ────────────────────────────────────
export type RelayJoinMessage = {
  type: 'join'
  protocolVersion: typeof RELAY_PROTOCOL_VERSION
  sessionId: string
  streamId: string
  credential: string
}

export type RelayFrameOutbound = {
  type: 'frame'
  streamId: string
  seq: number
  dir: RelayFrameDirection
  payload: string
}

export type RelayLeaveMessage = { type: 'leave' }

export type RelayClientMessage = RelayJoinMessage | RelayFrameOutbound | RelayLeaveMessage

// ── Relay -> client (parsed by the bridge) ───────────────────────────────────
export type RelayServerMessage =
  | {
      type: 'join_ack'
      protocolVersion: typeof RELAY_PROTOCOL_VERSION
      sessionId: string
      streamId: string
      participantId: string
      role: 'driver' | 'viewer'
    }
  | {
      type: 'frame'
      streamId: string
      seq: number
      dir: RelayFrameDirection
      payload: string
      sender: { participantId: string; role: 'driver' | 'viewer' }
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'stream_lagged'; streamId: string; droppedFrames: number; dir: RelayFrameDirection }
  | { type: 'leave_ack' }
