import { RELAY_PROTOCOL_VERSION, type RelayServerMessage } from './relay-wire-messages'
import type { PtyOutputSource } from './pty-output-source'
import { encodePtyStreamFrame, PTY_STREAM_FRAME_KIND } from './pty-stream-frame'
import type { PtyFrameSealer } from './pty-relay-e2ee'
import type { RelayClientSocket, RelayConnect } from './relay-client-socket'

// The host side of the C1 bridge: it joins the relay, seals every PTY output
// chunk with the endpoint E2EE key, and forwards it as an opaque `output` frame.
// It holds NO plaintext buffer of its own — sending goes straight to the socket,
// and the relay's bounded per-consumer queue is the only backpressure buffer, so
// a slow viewer can never grow host memory without bound (relay signals lag via
// `stream_lagged`, surfaced through onLagged).

export type PtyRelayHostConfig = {
  outputSource: PtyOutputSource
  relayUrl: string
  sessionId: string
  streamId: string
  // Opaque admission credential. For view-only C1 the host joins as a viewer
  // too (any role may send `output`; only `control` needs the driver role).
  credential: string
  seal: PtyFrameSealer
  connect: RelayConnect
  // Backpressure signal from the relay that this producer outran a consumer.
  onLagged?: (droppedFrames: number) => void
  onError?: (message: string) => void
}

export type PtyRelayHost = {
  start(): Promise<void>
  stop(): Promise<void>
  currentSeq(): number
}

export function createPtyRelayHost(config: PtyRelayHostConfig): PtyRelayHost {
  let socket: RelayClientSocket | null = null
  let seq = 0
  let unsubscribeData: (() => void) | null = null
  let unsubscribeExit: (() => void) | null = null
  let stopped = false

  // Seal `payload` under the current seq (== E2EE counter) and forward it as one
  // opaque `output` frame, advancing the seq.
  const sendSealed = (payload: Uint8Array): void => {
    if (!socket || stopped) {
      return
    }
    const sealed = config.seal(payload, BigInt(seq))
    const wirePayload = Buffer.from(sealed).toString('base64')
    socket.send(
      JSON.stringify({
        type: 'frame',
        streamId: config.streamId,
        seq,
        dir: 'output',
        payload: wirePayload
      })
    )
    seq += 1
  }

  const handleMessage = (raw: string): void => {
    let message: RelayServerMessage
    try {
      message = JSON.parse(raw) as RelayServerMessage
    } catch {
      return
    }
    if (message.type === 'stream_lagged') {
      config.onLagged?.(message.droppedFrames)
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
              onJoined()
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

  // Runs once join_ack lands: emit the catch-up snapshot first (seq 0) so a late
  // viewer is not blank, THEN subscribe to live output so ordering is preserved.
  const onJoined = (): void => {
    const snapshot = config.outputSource.snapshot()
    if (snapshot && snapshot.length > 0) {
      sendSealed(encodePtyStreamFrame(PTY_STREAM_FRAME_KIND.snapshot, snapshot))
    }
    unsubscribeData = config.outputSource.onData((chunk) => {
      sendSealed(encodePtyStreamFrame(PTY_STREAM_FRAME_KIND.data, chunk))
    })
    unsubscribeExit = config.outputSource.onExit(() => {
      // Final marker so the viewer learns the PTY ended, then leave the room.
      sendSealed(encodePtyStreamFrame(PTY_STREAM_FRAME_KIND.exit, new Uint8Array(0)))
      void stop()
    })
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    stopped = true
    unsubscribeData?.()
    unsubscribeExit?.()
    if (socket) {
      socket.send(JSON.stringify({ type: 'leave' }))
      socket.close()
    }
  }

  return {
    start,
    stop,
    currentSeq: () => seq
  }
}
