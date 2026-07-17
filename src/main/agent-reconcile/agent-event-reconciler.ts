import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import { hookEventEnvelope } from './agent-hook-event-envelope'
import { turnKeyOf } from './agent-reconcile-envelope'
import { isTurnFinalizingRecord, transcriptEventEnvelope } from './agent-transcript-envelope'
import type {
  NormalizedHookEvent,
  NormalizedTranscriptRecord,
  ReconcileEnqueue,
  ReconcileResult,
  ReconciledTurn,
  ReconciledTurnSource,
  SequenceGap
} from './agent-reconcile-types'

export type ReconcileInput = {
  hookEvents: readonly NormalizedHookEvent[]
  transcriptRecords: readonly NormalizedTranscriptRecord[]
  enqueue: ReconcileEnqueue
}

// Deterministic merge of a hook stream + a transcript stream into one reconciled envelope stream.
// No clock/RNG: ordering is by (stream, sequence, id) and all ids are content-derived, so the same
// inputs always enqueue the identical events in the identical order.
export function reconcileAgentEvents(input: ReconcileInput): ReconcileResult {
  const emitted: AgentEventEnvelope[] = []
  const seen = new Set<string>()
  const emit = (envelope: AgentEventEnvelope): void => {
    // Replay is idempotent here (a re-read hook has the same content-derived id) and again in the
    // outbox, so a replayed hook never doubles a turn (CAP-003).
    if (seen.has(envelope.id)) {
      return
    }
    seen.add(envelope.id)
    emitted.push(envelope)
    input.enqueue(envelope)
  }

  // Tool calls already carried by a hook (pre/post_tool): the transcript's record for the SAME call
  // must fold into that one tool timeline, not add a second (CAP-003).
  const hookToolCalls = new Set<string>()
  for (const event of input.hookEvents) {
    if ((event.kind === 'pre_tool' || event.kind === 'post_tool') && event.toolCallRef) {
      hookToolCalls.add(
        toolCallId(event.provider, event.sessionId, event.turnRef, event.toolCallRef)
      )
    }
  }

  // Hooks first — they carry the real-time tool-start/stop timing the transcript lacks (CAP-002).
  const hookOrder = [...input.hookEvents].sort(compareHook)
  for (const event of hookOrder) {
    emit(hookEventEnvelope(event))
  }

  // Transcript next — recovers hook-missing turns (CAP-001) and finalizes content (CAP-002).
  const transcriptOrder = [...input.transcriptRecords].sort(compareTranscript)
  for (const record of transcriptOrder) {
    if (record.kind === 'tool_call' && record.toolCallRef) {
      const id = toolCallId(record.provider, record.sessionId, record.turnRef, record.toolCallRef)
      if (hookToolCalls.has(id)) {
        continue
      }
    }
    emit(transcriptEventEnvelope(record))
  }

  return {
    emitted,
    turns: buildTurns(input.hookEvents, input.transcriptRecords),
    gaps: detectGaps(emitted)
  }
}

function toolCallId(
  provider: string,
  sessionId: string,
  turnRef: string,
  toolCallRef: string
): string {
  return `${turnKeyOf(provider, sessionId, turnRef)}|${toolCallRef}`
}

function compareHook(a: NormalizedHookEvent, b: NormalizedHookEvent): number {
  if (a.sessionId !== b.sessionId) {
    return a.sessionId < b.sessionId ? -1 : 1
  }
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence
  }
  return a.providerRecordKey < b.providerRecordKey ? -1 : 1
}

function compareTranscript(a: NormalizedTranscriptRecord, b: NormalizedTranscriptRecord): number {
  if (a.sessionId !== b.sessionId) {
    return a.sessionId < b.sessionId ? -1 : 1
  }
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence
  }
  return a.providerRecordKey < b.providerRecordKey ? -1 : 1
}

type TurnAccumulator = {
  turnRef: string
  sessionId: string
  provider: string
  hasHook: boolean
  hasTranscript: boolean
  contentHash: string | null
  toolCallRefs: Set<string>
}

// Groups both streams by turnKey into one reconciled turn: content is finalized by the transcript
// contentHash (provisional→immutable), a hook-missing turn is flagged recovered (CAP-001), and the
// tool refs are a single deduped timeline (CAP-003).
function buildTurns(
  hookEvents: readonly NormalizedHookEvent[],
  transcriptRecords: readonly NormalizedTranscriptRecord[]
): ReconciledTurn[] {
  const turns = new Map<string, TurnAccumulator>()
  const keyOrder: string[] = []
  const ensure = (provider: string, sessionId: string, turnRef: string): TurnAccumulator => {
    const key = turnKeyOf(provider, sessionId, turnRef)
    let turn = turns.get(key)
    if (!turn) {
      turn = {
        turnRef,
        sessionId,
        provider,
        hasHook: false,
        hasTranscript: false,
        contentHash: null,
        toolCallRefs: new Set<string>()
      }
      turns.set(key, turn)
      keyOrder.push(key)
    }
    return turn
  }

  for (const event of hookEvents) {
    const turn = ensure(event.provider, event.sessionId, event.turnRef)
    turn.hasHook = true
    if (event.toolCallRef) {
      turn.toolCallRefs.add(event.toolCallRef)
    }
  }
  for (const record of transcriptRecords) {
    const turn = ensure(record.provider, record.sessionId, record.turnRef)
    turn.hasTranscript = true
    if (record.toolCallRef) {
      turn.toolCallRefs.add(record.toolCallRef)
    }
    if (isTurnFinalizingRecord(record)) {
      turn.contentHash = record.contentHash
    }
  }

  return keyOrder.map((key) => {
    const turn = turns.get(key) as TurnAccumulator
    const sources: ReconciledTurnSource[] = []
    if (turn.hasHook) {
      sources.push('hook')
    }
    if (turn.hasTranscript) {
      sources.push('transcript')
    }
    return {
      turnKey: key,
      turnRef: turn.turnRef,
      sessionId: turn.sessionId,
      provider: turn.provider,
      sources,
      finalized: turn.contentHash !== null,
      contentHash: turn.contentHash,
      recoveredFromTranscript: turn.hasTranscript && !turn.hasHook,
      toolCallRefs: [...turn.toolCallRefs].sort()
    }
  })
}

// Non-contiguous session sequences → gap markers, per stream. Marked, never filled with guessed
// content (doc 19): the reconciler reports the hole and the server's gap-aware ack sees it too.
function detectGaps(emitted: readonly AgentEventEnvelope[]): SequenceGap[] {
  const byStream = new Map<string, Set<number>>()
  for (const envelope of emitted) {
    const set = byStream.get(envelope.piestream) ?? new Set<number>()
    set.add(envelope.piesequence)
    byStream.set(envelope.piestream, set)
  }

  const gaps: SequenceGap[] = []
  for (const [streamId, set] of [...byStream.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const seqs = [...set].sort((a, b) => a - b)
    let expected = seqs[0]
    for (const seq of seqs) {
      if (seq > expected) {
        gaps.push({ streamId, from: expected, to: seq - 1 })
      }
      expected = seq + 1
    }
  }
  return gaps
}
