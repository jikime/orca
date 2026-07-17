import {
  checkTranscriptBounds,
  type BoundsQuarantineReason,
  type TranscriptBoundsLimits
} from './agent-transcript-bounds'
import {
  encodeTranscriptRecord,
  encodeTranscriptSnapshot,
  type AgentTranscriptRecordType,
  type RawAgentTranscriptRecord,
  type ShareableTranscriptRecord
} from './agent-transcript-record'
import type { ViewerPolicy } from './agent-transcript-visibility'
import type { PtyOutputSource } from './pty-output-source'

// The agent-transcript seam for doc 34 C5, analogous to the C1 PtyOutputSource:
// the host subscribes to an AgentTranscriptSource and never touches the concrete
// hook service directly, so the share pipeline is testable with a hand-rolled
// fake source. `createShareableAgentTranscriptSource` wraps a RAW source and, for
// EACH record, applies bounds → visibility → redaction and re-checks
// `isSharingAuthorized()` right before emitting, so the shareable stream the relay
// host seals can never carry an over-budget, hidden, unredacted, or
// no-longer-authorized record.

export type AgentTranscriptSource = {
  onRecord(cb: (record: RawAgentTranscriptRecord) => void): () => void
  onEnd(cb: () => void): () => void
  // Catch-up seed of recent records for a late joiner (bounded — see the hook
  // adapter). Returns the RAW records; the shareable wrapper filters/redacts them.
  snapshot(): RawAgentTranscriptRecord[]
}

export type ShareableAgentTranscriptSource = {
  onRecord(cb: (record: ShareableTranscriptRecord) => void): () => void
  onEnd(cb: () => void): () => void
  snapshot(): ShareableTranscriptRecord[]
}

// An audit event NEVER carries raw content — only safe metadata (type, reason,
// counts) — so the audit trail itself cannot become a secret-leak channel.
export type TranscriptAuditEvent =
  | { kind: 'quarantined'; recordType: AgentTranscriptRecordType; reason: BoundsQuarantineReason }
  | { kind: 'hidden'; recordType: AgentTranscriptRecordType }
  | { kind: 'blocked_unauthorized'; recordType: AgentTranscriptRecordType }
  | { kind: 'redacted'; recordType: AgentTranscriptRecordType; redactionCount: number }

export type TranscriptRedactor = (text: string) => { text: string; redactionCount: number }

export type ShareableTranscriptOptions = {
  viewerPolicy: ViewerPolicy
  redaction: TranscriptRedactor
  bounds: TranscriptBoundsLimits
  // Re-checked PER RECORD, right before emit (CAP-006): a viewer whose visibility
  // was revoked must not receive queued/subsequent transcript.
  isSharingAuthorized: () => boolean
  onAudit?: (event: TranscriptAuditEvent) => void
}

// Projects one raw record to its shareable form, or null when it must not be
// shared. Order is fixed: bounds → visibility → redaction → auth re-check.
function projectRecord(
  record: RawAgentTranscriptRecord,
  options: ShareableTranscriptOptions
): ShareableTranscriptRecord | null {
  const bounds = checkTranscriptBounds(record.text, options.bounds)
  if (!bounds.ok) {
    options.onAudit?.({ kind: 'quarantined', recordType: record.type, reason: bounds.reason })
    return null
  }
  const visibility = options.viewerPolicy(record.type)
  if (visibility === 'hidden') {
    options.onAudit?.({ kind: 'hidden', recordType: record.type })
    return null
  }
  let text = record.text
  if (visibility === 'redact') {
    const redacted = options.redaction(record.text)
    text = redacted.text
    options.onAudit?.({
      kind: 'redacted',
      recordType: record.type,
      redactionCount: redacted.redactionCount
    })
  }
  // Auth re-check LAST, immediately before emit: even a bounded/redacted record is
  // withheld if sharing was revoked while we processed it.
  if (!options.isSharingAuthorized()) {
    options.onAudit?.({ kind: 'blocked_unauthorized', recordType: record.type })
    return null
  }
  return { type: record.type, text }
}

export function createShareableAgentTranscriptSource(
  rawSource: AgentTranscriptSource,
  options: ShareableTranscriptOptions
): ShareableAgentTranscriptSource {
  return {
    onRecord(cb) {
      return rawSource.onRecord((record) => {
        const shareable = projectRecord(record, options)
        if (shareable) {
          cb(shareable)
        }
      })
    },
    onEnd(cb) {
      return rawSource.onEnd(cb)
    },
    snapshot() {
      // A late joiner's catch-up is re-projected through the SAME pipeline, so the
      // accumulated backlog is bounded/filtered/redacted and re-authorized too.
      const out: ShareableTranscriptRecord[] = []
      for (const record of rawSource.snapshot()) {
        const shareable = projectRecord(record, options)
        if (shareable) {
          out.push(shareable)
        }
      }
      return out
    }
  }
}

// Adapts a shareable transcript source into the byte-oriented PtyOutputSource the
// existing C1 relay host seals and forwards — so transcript sharing REUSES the
// whole seal→frame→relay data path with no @pie/relay fork. Each shareable record
// becomes one UTF-8 JSON chunk; the late-joiner snapshot becomes a single JSON
// array (null when empty, so the host skips the seed frame).
export function createTranscriptByteOutputSource(
  shareableSource: ShareableAgentTranscriptSource
): PtyOutputSource {
  return {
    onData(cb) {
      return shareableSource.onRecord((record) => cb(encodeTranscriptRecord(record)))
    },
    onExit(cb) {
      return shareableSource.onEnd(cb)
    },
    snapshot() {
      const records = shareableSource.snapshot()
      return records.length > 0 ? encodeTranscriptSnapshot(records) : null
    }
  }
}

// Narrow structural view of an agent hook-event stream (src/main/claude/hook-service
// and src/main/devin/hook-service). Adapted by SHAPE — mirroring
// createDaemonPtyOutputSource — so the transcript source never imports the concrete
// hook service and stays decoupled from its transport.
export type AgentHookEventStream = {
  onHookEvent(cb: (event: { hookEventName: string; text: string }) => void): () => void
  onSessionEnd(cb: () => void): () => void
}

// Claude/Devin hook event names → transcript record types. Unmapped events fall
// through to `system`, which the default viewer policy hides from viewers.
const HOOK_EVENT_TO_RECORD_TYPE: Record<string, AgentTranscriptRecordType> = {
  UserPromptSubmit: 'user_prompt',
  PreToolUse: 'tool_call',
  PostToolUse: 'tool_output',
  PostToolUseFailure: 'tool_output',
  Stop: 'assistant_msg',
  StopFailure: 'assistant_msg'
}

export type AgentHookTranscriptSourceOptions = {
  // Bounded ring of recent records kept for late-joiner catch-up, so the snapshot
  // can never grow host memory without bound.
  maxSnapshotRecords: number
}

export function createAgentHookTranscriptSource(
  stream: AgentHookEventStream,
  options: AgentHookTranscriptSourceOptions
): AgentTranscriptSource {
  const recent: RawAgentTranscriptRecord[] = []
  const recordListeners: ((record: RawAgentTranscriptRecord) => void)[] = []
  const endListeners: (() => void)[] = []

  stream.onHookEvent((event) => {
    const record: RawAgentTranscriptRecord = {
      type: HOOK_EVENT_TO_RECORD_TYPE[event.hookEventName] ?? 'system',
      text: event.text
    }
    recent.push(record)
    if (recent.length > options.maxSnapshotRecords) {
      recent.shift()
    }
    for (const listener of recordListeners.slice()) {
      listener(record)
    }
  })
  stream.onSessionEnd(() => {
    for (const listener of endListeners.slice()) {
      listener()
    }
  })

  return {
    onRecord(cb) {
      recordListeners.push(cb)
      return () => {
        const idx = recordListeners.indexOf(cb)
        if (idx !== -1) {
          recordListeners.splice(idx, 1)
        }
      }
    },
    onEnd(cb) {
      endListeners.push(cb)
      return () => {
        const idx = endListeners.indexOf(cb)
        if (idx !== -1) {
          endListeners.splice(idx, 1)
        }
      }
    },
    snapshot() {
      return recent.map((record) => ({ ...record }))
    }
  }
}
