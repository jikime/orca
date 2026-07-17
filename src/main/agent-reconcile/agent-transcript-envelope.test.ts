import { describe, expect, it } from 'vitest'
import { AgentEventEnvelopeSchema } from '../../shared/agent-event-batch-contract'
import { transcriptEventEnvelope } from './agent-transcript-envelope'
import { transcriptRecord } from './__fixtures__/agent-reconcile-fixture'

describe('transcriptEventEnvelope', () => {
  it('produces an envelope valid against the s2 wire contract', () => {
    const envelope = transcriptEventEnvelope(transcriptRecord({ sequence: 1 }))
    expect(() => AgentEventEnvelopeSchema.parse(envelope)).not.toThrow()
    expect(envelope.data.producer.type).toBe('transcript_reconciler')
    expect(envelope.data.assertion).toBe('observed')
    expect(envelope.data.payload?.contentHash).toBe('hash-1')
  })

  it('re-scan of the same record is idempotent (same key + hash → same id)', () => {
    const a = transcriptEventEnvelope(transcriptRecord({ sequence: 1 }))
    const b = transcriptEventEnvelope(transcriptRecord({ sequence: 1 }))
    expect(b.id).toBe(a.id)
  })

  it('edited content (new hash, same record key) yields a distinct id', () => {
    const a = transcriptEventEnvelope(transcriptRecord({ sequence: 1, contentHash: 'h1' }))
    const b = transcriptEventEnvelope(transcriptRecord({ sequence: 1, contentHash: 'h2' }))
    expect(b.id).not.toBe(a.id)
  })

  it('lines up with the hook stream on turnKey for the same turnRef', () => {
    const txn = transcriptEventEnvelope(transcriptRecord({ sequence: 1, turnRef: 'turn-x' }))
    const txn2 = transcriptEventEnvelope(transcriptRecord({ sequence: 2, turnRef: 'turn-x' }))
    expect(txn.subject).toBe(txn2.subject)
  })
})
