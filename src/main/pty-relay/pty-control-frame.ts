// Endpoint-only framing carried INSIDE the E2EE seal for the `control` relay
// direction — the driver→host stdin path (C3). It is separate from
// pty-stream-frame.ts (the output-only direction) so the two directions can never
// alias: a control frame and an output frame have independent kind namespaces and
// ride opposite E2EE directions. Like the stream frame it uses a 1-byte kind
// prefix and stays extensible (handoff hints, paste markers, etc. can be added as
// new kinds without a wire break).

export const PTY_CONTROL_FRAME_KIND = {
  // Raw stdin bytes the driver typed, destined for the host PTY's input.
  input: 0
} as const

export type PtyControlFrameKind =
  (typeof PTY_CONTROL_FRAME_KIND)[keyof typeof PTY_CONTROL_FRAME_KIND]

const KIND_VALUES: ReadonlySet<number> = new Set(Object.values(PTY_CONTROL_FRAME_KIND))

export function encodePtyControlFrame(kind: PtyControlFrameKind, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 1)
  framed[0] = kind
  framed.set(payload, 1)
  return framed
}

// Returns null on an unknown kind or empty buffer so a malformed control frame is
// dropped by the host and never written to the PTY as stdin.
export function decodePtyControlFrame(
  framed: Uint8Array
): { kind: PtyControlFrameKind; payload: Uint8Array } | null {
  if (framed.length === 0 || !KIND_VALUES.has(framed[0]!)) {
    return null
  }
  return { kind: framed[0] as PtyControlFrameKind, payload: framed.subarray(1) }
}
