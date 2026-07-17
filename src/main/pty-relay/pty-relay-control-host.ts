import { RELAY_PROTOCOL_VERSION, type RelayServerMessage } from './relay-wire-messages'
import { decodePtyControlFrame, PTY_CONTROL_FRAME_KIND } from './pty-control-frame'
import type { PtyFrameOpener } from './pty-relay-e2ee'
import type { RelayClientSocket, RelayConnect } from './relay-client-socket'
import type { RelayParticipant, TakeoverAuditSink } from './collab-driver-state-mirror'

// The host's control-input receiver (C3). For each `control`-direction frame it
// opens the E2EE seal, decodes the inner control frame, and writes stdin to the
// PTY ONLY IF the authorization gate passes. The gate is DEFENSE-IN-DEPTH and
// independent of the relay's own driver enforcement: even if a `control` frame
// somehow arrives from a non-driver (relay bug/compromise), this gate — keyed on
// the control-plane driver IDENTITY, not the relay-provided role — rejects it and
// writes nothing.

export type ControlInputGate = {
  // Re-checked PER FRAME so a cached "was driver" is never trusted; reboot,
  // user-switch and handoff must all re-validate here (principle 39).
  isAuthorizedDriver(sender: RelayParticipant): boolean
  // Consent active AND policy not expired. False → input blocked immediately.
  isInputAllowed(): boolean
}

export type PtyRelayControlHostConfig = {
  relayUrl: string
  sessionId: string
  streamId: string
  credential: string
  open: PtyFrameOpener
  connect: RelayConnect
  gate: ControlInputGate
  // Sink for the decoded stdin bytes — in the app this decodes to the daemon
  // router's write(sessionId, data). Injected, not a hard daemon dependency.
  write: (data: Uint8Array) => void
  audit: TakeoverAuditSink
  // Fired when input is blocked mid-session (consent revoke / policy expiry) so
  // the caller can tear the connection down (principle 7: block AND end).
  onConnectionShouldEnd?: () => void
  onError?: (message: string) => void
}

export type PtyRelayControlHost = {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createPtyRelayControlHost(config: PtyRelayControlHostConfig): PtyRelayControlHost {
  let socket: RelayClientSocket | null = null
  let stopped = false

  const handleFrame = (message: Extract<RelayServerMessage, { type: 'frame' }>): void => {
    if (message.dir !== 'control') {
      return
    }
    // 1. Consent/policy gate first — on revoke or expiry, drop immediately and ask
    //    to end the connection, even from the currently valid driver (principle 7).
    if (!config.gate.isInputAllowed()) {
      config.audit({ kind: 'control_rejected', reason: 'input_blocked', sender: message.sender })
      config.onConnectionShouldEnd?.()
      return
    }
    // 2. Driver-identity gate, independent of the relay-provided role.
    if (!config.gate.isAuthorizedDriver(message.sender)) {
      config.audit({ kind: 'control_rejected', reason: 'not_driver', sender: message.sender })
      return
    }
    // 3. Only now open + decode; a bad seal or unknown kind writes NOTHING.
    const sealed = Buffer.from(message.payload, 'base64')
    const plaintext = config.open(new Uint8Array(sealed), BigInt(message.seq))
    if (!plaintext) {
      config.audit({ kind: 'control_rejected', reason: 'malformed', sender: message.sender })
      config.onError?.(`failed to open control frame seq=${message.seq}`)
      return
    }
    const inner = decodePtyControlFrame(plaintext)
    if (!inner || inner.kind !== PTY_CONTROL_FRAME_KIND.input) {
      config.audit({ kind: 'control_rejected', reason: 'malformed', sender: message.sender })
      return
    }
    config.write(inner.payload)
  }

  const handleMessage = (raw: string): void => {
    let message: RelayServerMessage
    try {
      message = JSON.parse(raw) as RelayServerMessage
    } catch {
      return
    }
    if (message.type === 'frame') {
      handleFrame(message)
    } else if (message.type === 'error') {
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

  return { start, stop }
}
