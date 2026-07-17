// Endpoint-only framing carried INSIDE the E2EE seal. The relay never sees this
// (it only ferries the sealed ciphertext), so the host and viewer use a 1-byte
// kind prefix to tell a normal output chunk from the reattach snapshot and from
// the terminal-exit marker — all of which must ride the same `output` relay
// direction because view-only endpoints may never send a `control` frame.

export const PTY_STREAM_FRAME_KIND = {
  // A live PTY output chunk.
  data: 0,
  // The one-shot reattach snapshot sent first so a late viewer is not blank.
  snapshot: 1,
  // The terminal exited; no more output follows.
  exit: 2
} as const

export type PtyStreamFrameKind = (typeof PTY_STREAM_FRAME_KIND)[keyof typeof PTY_STREAM_FRAME_KIND]

const KIND_VALUES: ReadonlySet<number> = new Set(Object.values(PTY_STREAM_FRAME_KIND))

export function encodePtyStreamFrame(kind: PtyStreamFrameKind, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 1)
  framed[0] = kind
  framed.set(payload, 1)
  return framed
}

// Returns null on an unknown kind or empty buffer so a malformed inner frame is
// surfaced as an error rather than emitted as garbage terminal output.
export function decodePtyStreamFrame(
  framed: Uint8Array
): { kind: PtyStreamFrameKind; payload: Uint8Array } | null {
  if (framed.length === 0 || !KIND_VALUES.has(framed[0]!)) {
    return null
  }
  return { kind: framed[0] as PtyStreamFrameKind, payload: framed.subarray(1) }
}
