import { RELAY_PROTOCOL_VERSION, type RelayServerMessage } from './relay-wire-messages'
import { encodePtyControlFrame, PTY_CONTROL_FRAME_KIND } from './pty-control-frame'
import type { PtyFrameSealer } from './pty-relay-e2ee'
import type { RelayClientSocket, RelayConnect } from './relay-client-socket'

// The driver side of the C3 bridge: it seals the operator's keystrokes and sends
// them as opaque `control`-direction frames. Mirrors the C1 host structure
// (injected connect/seal, monotonic seq counter) but for the reverse stdin path.
//
// It sends ONLY while it holds the driver role — every keystroke is gated on the
// injected hasDriverRole() (which reflects the control-plane A3 state via the
// driver-state mirror). On losing the role (handoff/revoke) that gate flips to
// false and sending stops immediately; there is no stale buffer to flush later.

export type PtyRelayDriverConfig = {
  relayUrl: string
  sessionId: string
  streamId: string
  // Driver-role admission credential (the relay independently enforces that only
  // a driver may send `control`; this client gate is the first line of defense).
  credential: string
  seal: PtyFrameSealer
  connect: RelayConnect
  // Reflects the current control-plane A3 driver decision; re-read per keystroke.
  hasDriverRole: () => boolean
  onError?: (message: string) => void
}

export type PtyRelayDriver = {
  start(): Promise<void>
  stop(): Promise<void>
  // Sends one stdin chunk; returns false if suppressed (not driver / not started).
  sendInput(data: Uint8Array): boolean
  // The relay-assigned participant id for this client, or null before join_ack.
  participantId(): string | null
  currentSeq(): number
}

export function createPtyRelayDriver(config: PtyRelayDriverConfig): PtyRelayDriver {
  let socket: RelayClientSocket | null = null
  let seq = 0
  let stopped = false
  let assignedParticipantId: string | null = null

  const sendInput = (data: Uint8Array): boolean => {
    if (!socket || stopped) {
      return false
    }
    // Gate EVERY keystroke on the current role: on handoff/revoke this is already
    // false, so nothing stale is sent after the driver right moves away.
    if (!config.hasDriverRole()) {
      return false
    }
    const framed = encodePtyControlFrame(PTY_CONTROL_FRAME_KIND.input, data)
    const sealed = config.seal(framed, BigInt(seq))
    socket.send(
      JSON.stringify({
        type: 'frame',
        streamId: config.streamId,
        seq,
        dir: 'control',
        payload: Buffer.from(sealed).toString('base64')
      })
    )
    seq += 1
    return true
  }

  const handleMessage = (raw: string): void => {
    let message: RelayServerMessage
    try {
      message = JSON.parse(raw) as RelayServerMessage
    } catch {
      return
    }
    if (message.type === 'error') {
      config.onError?.(message.message)
    }
  }

  const start = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      config.connect(config.relayUrl).then((connected) => {
        socket = connected
        let joined = false
        connected.onClose(() => {
          if (!joined) {
            reject(new Error('relay closed before join_ack'))
          }
        })
        connected.onMessage((raw) => {
          if (!joined) {
            let message: RelayServerMessage
            try {
              message = JSON.parse(raw) as RelayServerMessage
            } catch {
              return
            }
            if (message.type === 'join_ack') {
              joined = true
              assignedParticipantId = message.participantId
              resolve()
              return
            }
            if (message.type === 'error') {
              reject(new Error(`relay admission error: ${message.code}`))
              return
            }
            return
          }
          handleMessage(raw)
        })
        connected.send(
          JSON.stringify({
            type: 'join',
            protocolVersion: RELAY_PROTOCOL_VERSION,
            sessionId: config.sessionId,
            streamId: config.streamId,
            credential: config.credential
          })
        )
      }, reject)
    })

  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    stopped = true
    if (socket) {
      socket.send(JSON.stringify({ type: 'leave' }))
      socket.close()
    }
  }

  return {
    start,
    stop,
    sendInput,
    participantId: () => assignedParticipantId,
    currentSeq: () => seq
  }
}
