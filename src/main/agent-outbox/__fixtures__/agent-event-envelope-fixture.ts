import { randomUUID } from 'node:crypto'
import type { AgentEventEnvelope } from '../../../shared/agent-event-batch-contract'

// Synthetic AgentEventEnvelope for outbox tests (the real producer arrives in R5 s3). Mirrors the
// CloudEvents wire shape the s1 ingest accepts (see agent-event-ingest-vertical.test.ts).

export type EnvelopeOverrides = {
  id?: string
  streamId?: string
  sequence?: number
  assertion?: AgentEventEnvelope['data']['assertion']
  pieorgid?: string
  agentSessionId?: string
  contentHash?: string
}

export function makeEnvelope(overrides: EnvelopeOverrides = {}): AgentEventEnvelope {
  const payload: Record<string, unknown> = { note: 'streamed' }
  if (overrides.contentHash) {
    payload.contentHash = overrides.contentHash
  }
  return {
    id: overrides.id ?? randomUUID(),
    source: 'urn:pie:client:installation',
    type: 'ai.pielab.agent.turn.streamed.v1',
    subject: 'agent-run',
    time: '2026-07-16T10:00:00.000Z',
    pieorgid: overrides.pieorgid ?? '20000000-0000-4000-8000-000000000001',
    piestream: overrides.streamId ?? 'stream-a',
    piesequence: overrides.sequence ?? 1,
    data: {
      context: {
        projectId: null,
        workItemId: null,
        workspaceId: null,
        hostId: '30000000-0000-4000-8000-000000000009',
        launchId: null,
        agentSessionId: overrides.agentSessionId ?? '40000000-0000-4000-8000-00000000000a',
        agentRunId: null,
        turnId: null
      },
      producer: {
        type: 'hook',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: 'client_observed'
      },
      assertion: overrides.assertion ?? 'observed',
      classification: 'internal',
      visibility: 'internal',
      payload,
      capturedAt: '2026-07-16T10:00:00.500Z'
    }
  }
}
