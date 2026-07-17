import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'

// Normalized inputs the reconciler consumes. The LIVE managed-hook receiver and the transcript
// watcher (TODO(pie-r5-s3-live)) push these; tests push fixtures. Both are deterministic: no clock
// or RNG lives here — occurred/captured times and every id-seed come from the record itself.

export type HookEventKind = 'user_prompt' | 'pre_tool' | 'post_tool' | 'stop'

// A single managed-hook emission, already flattened by the receiver. `providerRecordKey` is the
// provider's unique key for THIS emission: identical on a replay (app restart re-reads the same
// hook), fresh on a genuine re-run — this is what tells replay from re-run apart (CAP-003).
export type NormalizedHookEvent = {
  provider: string
  sessionId: string
  kind: HookEventKind
  providerRecordKey: string
  // Identity of the turn this event belongs to (the turn's user-prompt record key). Every hook and
  // transcript record of one turn shares it, so the two sources line up on the same turnKey.
  turnRef: string
  // Session-global monotonic ordinal for gap detection; a dropped hook shows as a sequence hole.
  sequence: number
  occurredAt: string
  capturedAt: string
  orgId: string
  hostId: string
  toolName?: string
  // Identity of the tool call, so a pre/post_tool hook reconciles with the transcript's tool
  // record for the SAME call into one tool timeline (CAP-003), not two.
  toolCallRef?: string
}

export type TranscriptRecordKind = 'user_prompt' | 'assistant_message' | 'tool_call' | 'turn_end'

// A finalized transcript entry. `contentHash` is over the FINALIZED content (never the raw text —
// content is hashed upstream and never logged). It both finalizes a turn (provisional→immutable)
// and distinguishes a same-text re-run (new providerRecordKey) from a re-scan (same key + hash).
export type NormalizedTranscriptRecord = {
  provider: string
  sessionId: string
  kind: TranscriptRecordKind
  providerRecordKey: string
  turnRef: string
  sequence: number
  contentHash: string
  occurredAt: string
  capturedAt: string
  orgId: string
  hostId: string
  toolName?: string
  toolCallRef?: string
}

// Injected outbox seam. The real store's `enqueue(event, { now })` is idempotent by eventId; the
// reconciler only needs the one-arg form and never touches the DB directly.
export type ReconcileEnqueue = (event: AgentEventEnvelope) => void

// A maximal run of missing session-sequence ordinals. Marked, never silently filled: the server's
// gap-aware ack sees the hole via piesequence and the caller sees it here.
export type SequenceGap = {
  streamId: string
  from: number
  to: number
}

export type ReconciledTurnSource = 'hook' | 'transcript'

export type ReconciledTurn = {
  turnKey: string
  turnRef: string
  sessionId: string
  provider: string
  sources: ReconciledTurnSource[]
  // A turn is final once the transcript confirms its contentHash (matches s1's provisional→immutable
  // projection). Until then it is a provisional, hook-only turn.
  finalized: boolean
  contentHash: string | null
  // CAP-001: the hook stream missed this turn entirely; it is recovered from the transcript.
  recoveredFromTranscript: boolean
  // One reconciled tool timeline per turn — hook and transcript tool records for the same call fold
  // to a single ref (CAP-003).
  toolCallRefs: string[]
}

export type ReconcileResult = {
  emitted: AgentEventEnvelope[]
  turns: ReconciledTurn[]
  gaps: SequenceGap[]
}
