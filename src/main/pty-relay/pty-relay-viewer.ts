import { RELAY_PROTOCOL_VERSION, type RelayServerMessage } from './relay-wire-messages'
import { decodePtyStreamFrame, PTY_STREAM_FRAME_KIND } from './pty-stream-frame'
import type { PtyFrameOpener } from './pty-relay-e2ee'
import type { RelayClientSocket, RelayConnect } from './relay-client-socket'

// The viewer side of the C1 bridge. VIEW-ONLY: it only ever sends `join` and
// `leave` — never a frame, and never a `control`-direction frame (the relay
// would reject it anyway, since a viewer is not the driver). It opens each sealed
// `output` frame with the endpoint E2EE key and emits the plaintext chunks. If a
// frame fails to open (tamper / wrong key), it surfaces an error and emits
// nothing — no garbage reaches the terminal.

export type PtyRelayViewerConfig = {
  relayUrl: string
  sessionId: string
  streamId: string
  credential: string
  open: PtyFrameOpener
  connect: RelayConnect
}

export type PtyRelayViewer = {
  start(): Promise<void>
  stop(): Promise<void>
  onData(cb: (chunk: Uint8Array) => void): () => void
  onExit(cb: () => void): () => void
  onError(cb: (message: string) => void): () => void
  // Readable interface: every plaintext chunk emitted so far, in order.
  received(): Uint8Array[]
}

export function createPtyRelayViewer(config: PtyRelayViewerConfig): PtyRelayViewer {
  let socket: RelayClientSocket | null = null
  let stopped = false
  const dataListeners: ((chunk: Uint8Array) => void)[] = []
  const exitListeners: (() => void)[] = []
  const errorListeners: ((message: string) => void)[] = []
  const receivedChunks: Uint8Array[] = []

  // slice() copies so a listener that unsubscribes during dispatch is safe.
  const emitData = (chunk: Uint8Array): void => {
    receivedChunks.push(chunk)
    for (const listener of dataListeners.slice()) {
      listener(chunk)
    }
  }
  const emitExit = (): void => {
    for (const listener of exitListeners.slice()) {
      listener()
    }
  }
  const emitError = (message: string): void => {
    for (const listener of errorListeners.slice()) {
      listener(message)
    }
  }

  // Open one sealed `output` frame and dispatch by its inner endpoint kind.
  const handleFrame = (message: Extract<RelayServerMessage, { type: 'frame' }>): void => {
    if (message.dir !== 'output') {
      return
    }
    const sealed = Buffer.from(message.payload, 'base64')
    const plaintext = config.open(new Uint8Array(sealed), BigInt(message.seq))
    if (!plaintext) {
      // Authenticated open failed (tamper / wrong key / replay). Surface it; do
      // NOT emit anything, so no garbage bytes reach the terminal.
      emitError(`failed to open frame seq=${message.seq}`)
      return
    }
    const inner = decodePtyStreamFrame(plaintext)
    if (!inner) {
      emitError(`malformed inner frame seq=${message.seq}`)
      return
    }
    if (inner.kind === PTY_STREAM_FRAME_KIND.exit) {
      emitExit()
      return
    }
    // data and snapshot are both plaintext output the terminal renders; snapshot
    // is simply the catch-up seed delivered first.
    emitData(inner.payload)
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
      emitError(message.message)
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

  return {
    start,
    stop,
    onData(cb) {
      dataListeners.push(cb)
      return () => {
        const idx = dataListeners.indexOf(cb)
        if (idx !== -1) {
          dataListeners.splice(idx, 1)
        }
      }
    },
    onExit(cb) {
      exitListeners.push(cb)
      return () => {
        const idx = exitListeners.indexOf(cb)
        if (idx !== -1) {
          exitListeners.splice(idx, 1)
        }
      }
    },
    onError(cb) {
      errorListeners.push(cb)
      return () => {
        const idx = errorListeners.indexOf(cb)
        if (idx !== -1) {
          errorListeners.splice(idx, 1)
        }
      }
    },
    received: () => receivedChunks
  }
}
