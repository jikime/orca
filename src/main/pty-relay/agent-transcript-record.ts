// Shared record shapes for agent-session transcript sharing (doc 34 C5), plus the
// endpoint-only wire codec that turns a shareable record into the opaque bytes the
// C1 relay host seals. Kept as a leaf module so the source, visibility, and host
// adapter can share these types without an import cycle.

export type AgentTranscriptRecordType =
  | 'user_prompt'
  | 'assistant_msg'
  | 'tool_call'
  | 'tool_output'
  | 'system'

// A raw transcript record as produced by the agent (before any bounds/visibility/
// redaction). `declaredBytes` is a self-reported size from the upstream producer
// that the bounds guard IGNORES — actual bytes are always measured (CAP-008).
export type RawAgentTranscriptRecord = {
  type: AgentTranscriptRecordType
  text: string
  declaredBytes?: number
}

// The bounded, visibility-filtered, redacted projection that is safe to share.
export type ShareableTranscriptRecord = {
  type: AgentTranscriptRecordType
  text: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeTranscriptRecord(record: ShareableTranscriptRecord): Uint8Array {
  return encoder.encode(JSON.stringify(record))
}

// Returns null on malformed bytes / wrong shape so a corrupt payload surfaces as
// an error instead of being emitted as a garbage record.
export function decodeTranscriptRecord(bytes: Uint8Array): ShareableTranscriptRecord | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ShareableTranscriptRecord).type === 'string' &&
      typeof (parsed as ShareableTranscriptRecord).text === 'string'
    ) {
      return {
        type: (parsed as ShareableTranscriptRecord).type,
        text: (parsed as ShareableTranscriptRecord).text
      }
    }
    return null
  } catch {
    return null
  }
}

export function encodeTranscriptSnapshot(
  records: readonly ShareableTranscriptRecord[]
): Uint8Array {
  return encoder.encode(JSON.stringify(records))
}

export function decodeTranscriptSnapshot(bytes: Uint8Array): ShareableTranscriptRecord[] | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    const records: ShareableTranscriptRecord[] = []
    for (const entry of parsed) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ShareableTranscriptRecord).type === 'string' &&
        typeof (entry as ShareableTranscriptRecord).text === 'string'
      ) {
        records.push({
          type: (entry as ShareableTranscriptRecord).type,
          text: (entry as ShareableTranscriptRecord).text
        })
      }
    }
    return records
  } catch {
    return null
  }
}
