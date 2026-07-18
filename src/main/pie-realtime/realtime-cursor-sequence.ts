// The platform issues cursors as `cursor-<zero-padded sequence>`; decoding the
// sequence lets the connection dedupe an at-least-once stream numerically.
// Unparseable cursors fall back to exact-string dedupe (null return).
export function cursorSequence(cursor: string): number | null {
  const match = /^cursor-(\d+)$/.exec(cursor)
  return match ? Number(match[1]) : null
}
