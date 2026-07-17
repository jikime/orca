import type { RelayClientSocket, RelayConnect } from './relay-client-socket'

// A tiny in-memory test double of the relay that faithfully implements the ONE
// behavior the endpoint proofs depend on: an OPAQUE ferry. It forwards each
// frame's base64 `payload` VERBATIM to the other room members (never decoding,
// parsing, or mutating it) and rejects a `control` frame from a non-driver —
// exactly the routing contract of platform/apps/relay/src/relay-room.ts. It lets
// the host↔viewer data-path proofs run without crossing the workspace/build
// boundary into @pie/relay; the REAL relay is exercised by the platform-side
// pty-relay-bridge-e2e test.

type InMemoryMember = {
  connectionId: string
  role: 'driver' | 'viewer'
  deliver: (raw: string) => void
}

export function createInMemoryRelay(): { connect: RelayConnect } {
  let connectionCounter = 0
  const rooms = new Map<string, Set<InMemoryMember>>()

  const connect: RelayConnect = async () => {
    let member: InMemoryMember | null = null
    let streamId = ''
    let onMessage: (raw: string) => void = () => {}
    let onClose: () => void = () => {}

    const leave = (): void => {
      const room = rooms.get(streamId)
      if (room && member) {
        room.delete(member)
      }
    }

    const socket: RelayClientSocket = {
      send(data) {
        const message = JSON.parse(data) as {
          type: string
          sessionId?: string
          streamId?: string
          credential?: string
          seq?: number
          dir?: string
          payload?: string
        }
        if (message.type === 'join') {
          streamId = message.streamId ?? ''
          // Mirror the harness stub: a credential starting with "driver" is a
          // driver, everything else a viewer.
          const role = (message.credential ?? '').startsWith('driver') ? 'driver' : 'viewer'
          member = { connectionId: `conn-${(connectionCounter += 1)}`, role, deliver: onMessage }
          let room = rooms.get(streamId)
          if (!room) {
            room = new Set()
            rooms.set(streamId, room)
          }
          room.add(member)
          onMessage(
            JSON.stringify({
              type: 'join_ack',
              protocolVersion: '1.0',
              sessionId: message.sessionId,
              streamId,
              participantId: member.connectionId,
              role
            })
          )
        } else if (message.type === 'frame') {
          if (!member) {
            return
          }
          if (message.dir === 'control' && member.role !== 'driver') {
            onMessage(
              JSON.stringify({
                type: 'error',
                code: 'forbidden_control',
                message: 'only the driver may send control frames'
              })
            )
            return
          }
          const room = rooms.get(streamId)
          if (!room) {
            return
          }
          const outbound = JSON.stringify({
            type: 'frame',
            streamId: message.streamId,
            seq: message.seq,
            dir: message.dir,
            payload: message.payload, // verbatim — the relay stays opaque
            sender: { participantId: member.connectionId, role: member.role }
          })
          for (const other of room) {
            if (other !== member) {
              other.deliver(outbound)
            }
          }
        } else if (message.type === 'leave') {
          onMessage(JSON.stringify({ type: 'leave_ack' }))
          leave()
          onClose()
        }
      },
      onMessage(cb) {
        onMessage = cb
      },
      onClose(cb) {
        onClose = cb
      },
      close() {
        leave()
        onClose()
      }
    }
    return socket
  }

  return { connect }
}
