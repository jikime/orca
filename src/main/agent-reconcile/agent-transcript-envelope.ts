import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import { composeAgentEventEnvelope, transcriptEventId, turnKeyOf } from './agent-reconcile-envelope'
import type { NormalizedTranscriptRecord, TranscriptRecordKind } from './agent-reconcile-types'

const TRANSCRIPT_EVENT_TYPE: Record<TranscriptRecordKind, string> = {
  user_prompt: 'ai.pielab.agent.turn.prompt.v1',
  assistant_message: 'ai.pielab.agent.turn.finalized.v1',
  tool_call: 'ai.pielab.agent.tool.recorded.v1',
  turn_end: 'ai.pielab.agent.turn.finalized.v1'
}

// Pure mapper: a normalized transcript record → the s2 AgentEvent envelope. `source:'transcript'`
// (via producer.type), `assertion:'observed'`. `contentHash` finalizes the turn; turnKey is derived
// from the same turnRef the hook stream uses, so both sources reconcile onto one turn.
export function transcriptEventEnvelope(record: NormalizedTranscriptRecord): AgentEventEnvelope {
  const turnKey = turnKeyOf(record.provider, record.sessionId, record.turnRef)
  const eventId = transcriptEventId({
    provider: record.provider,
    sessionId: record.sessionId,
    providerRecordKey: record.providerRecordKey,
    contentHash: record.contentHash
  })

  return composeAgentEventEnvelope({
    eventId,
    producerType: 'transcript_reconciler',
    provider: record.provider,
    sessionId: record.sessionId,
    turnKey,
    sequence: record.sequence,
    occurredAt: record.occurredAt,
    capturedAt: record.capturedAt,
    orgId: record.orgId,
    hostId: record.hostId,
    type: TRANSCRIPT_EVENT_TYPE[record.kind],
    payload: {
      sourceKind: 'transcript',
      kind: record.kind,
      turnKey,
      turnRef: record.turnRef,
      providerRecordKey: record.providerRecordKey,
      sequence: record.sequence,
      contentHash: record.contentHash,
      ...(record.toolName ? { toolName: record.toolName } : {}),
      ...(record.toolCallRef ? { toolCallRef: record.toolCallRef } : {})
    }
  })
}

// True when this transcript record finalizes a turn's content (an assistant message or turn end
// carries the confirmed contentHash). Tool-call records do not finalize a turn.
export function isTurnFinalizingRecord(record: NormalizedTranscriptRecord): boolean {
  return record.kind === 'assistant_message' || record.kind === 'turn_end'
}
