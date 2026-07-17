// CAP-003 bounded parser/guard. Pure. A malicious agent transcript can carry a
// multi-hundred-MB record, a single unbounded line, or a deeply nested JSON
// "decompression bomb". This guard enforces hard limits and QUARANTINES any
// offending record (returns a marker + reason, emits nothing) instead of ever
// throwing — one poison record must not crash the share or starve the stream.
//
// CAP-008 spirit: sizes are MEASURED from the actual encoded bytes, never trusted
// from an upstream-declared length. Depth is scanned by hand (never JSON.parse),
// because JSON.parse on a deeply nested payload can itself blow the stack.

export type TranscriptBoundsLimits = {
  // Max UTF-8 bytes for a single record.
  maxRecordBytes: number
  // Max UTF-8 bytes for any single line within a record.
  maxLineBytes: number
  // Max nesting depth if the record is (or claims to be) JSON.
  maxJsonDepth: number
}

export type BoundsQuarantineReason = 'record_too_large' | 'line_too_long' | 'json_too_deep'

export type BoundsResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: BoundsQuarantineReason }

export const DEFAULT_TRANSCRIPT_BOUNDS: TranscriptBoundsLimits = {
  maxRecordBytes: 256 * 1024,
  maxLineBytes: 64 * 1024,
  maxJsonDepth: 64
}

const encoder = new TextEncoder()

// Actual UTF-8 byte length. A lone surrogate (malformed UTF-8) encodes to the
// replacement character rather than throwing, so this never crashes on bad input.
export function measureUtf8ByteLength(text: string): number {
  return encoder.encode(text).length
}

// Scans for the deepest `{`/`[` nesting without parsing, respecting JSON string
// literals and escapes, and early-exits the moment the limit is exceeded. Returns
// true when the text stays within `maxDepth`.
function jsonDepthWithinLimit(text: string, maxDepth: number): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{' || char === '[') {
      depth += 1
      if (depth > maxDepth) {
        return false
      }
    } else if (char === '}' || char === ']') {
      if (depth > 0) {
        depth -= 1
      }
    }
  }
  return true
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

export function checkTranscriptBounds(text: string, limits: TranscriptBoundsLimits): BoundsResult {
  // Cheap char-length gate first: char count never exceeds byte count, so a string
  // longer than maxRecordBytes chars is already over budget — bail before the O(n)
  // byte measurement touches a multi-hundred-MB buffer.
  if (text.length > limits.maxRecordBytes) {
    return { ok: false, reason: 'record_too_large' }
  }
  const bytes = measureUtf8ByteLength(text)
  if (bytes > limits.maxRecordBytes) {
    return { ok: false, reason: 'record_too_large' }
  }
  // Line check is bounded by maxRecordBytes above, so splitting is safe here.
  for (const line of text.split('\n')) {
    if (measureUtf8ByteLength(line) > limits.maxLineBytes) {
      return { ok: false, reason: 'line_too_long' }
    }
  }
  if (looksLikeJson(text) && !jsonDepthWithinLimit(text, limits.maxJsonDepth)) {
    return { ok: false, reason: 'json_too_deep' }
  }
  return { ok: true, bytes }
}
