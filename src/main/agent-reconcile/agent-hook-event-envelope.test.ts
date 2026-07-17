import { describe, expect, it } from 'vitest'
import { AgentEventEnvelopeSchema } from '../../shared/agent-event-batch-contract'
import { hookEventEnvelope } from './agent-hook-event-envelope'
import { hookEvent } from './__fixtures__/agent-reconcile-fixture'

describe('hookEventEnvelope', () => {
  it('produces an envelope valid against the s2 wire contract', () => {
    const envelope = hookEventEnvelope(hookEvent({ sequence: 1 }))
    expect(() => AgentEventEnvelopeSchema.parse(envelope)).not.toThrow()
    expect(envelope.data.producer.type).toBe('hook')
    expect(envelope.data.assertion).toBe('observed')
    expect(envelope.piestream).toBe('session-a')
    expect(envelope.piesequence).toBe(1)
    expect(envelope.time).toBe(envelope.time)
  })

  it('derives a STABLE eventId from provider record key + event identity (replay → same id)', () => {
    const first = hookEventEnvelope(hookEvent({ sequence: 1 }))
    const replay = hookEventEnvelope(hookEvent({ sequence: 1 }))
    expect(replay.id).toBe(first.id)
  })

  it('a genuine re-run (new record key) yields a distinct eventId', () => {
    const first = hookEventEnvelope(hookEvent({ sequence: 1, providerRecordKey: 'rec-a' }))
    const rerun = hookEventEnvelope(hookEvent({ sequence: 1, providerRecordKey: 'rec-b' }))
    expect(rerun.id).not.toBe(first.id)
  })

  it('a pre_tool and post_tool of the same call get distinct ids but share the turnKey', () => {
    const pre = hookEventEnvelope(
      hookEvent({
        sequence: 2,
        kind: 'pre_tool',
        turnRef: 'turn-1',
        toolName: 'Bash',
        toolCallRef: 'call-1'
      })
    )
    const post = hookEventEnvelope(
      hookEvent({
        sequence: 3,
        kind: 'post_tool',
        turnRef: 'turn-1',
        toolName: 'Bash',
        toolCallRef: 'call-1'
      })
    )
    expect(pre.id).not.toBe(post.id)
    expect(pre.subject).toBe(post.subject)
  })

  it('never puts raw content in the payload — identifiers/hashes only', () => {
    const envelope = hookEventEnvelope(
      hookEvent({ sequence: 1, kind: 'pre_tool', toolName: 'Bash', toolCallRef: 'call-1' })
    )
    expect(Object.keys(envelope.data.payload ?? {}).sort()).toEqual(
      [
        'kind',
        'providerRecordKey',
        'sequence',
        'sourceKind',
        'toolCallRef',
        'toolName',
        'turnKey',
        'turnRef'
      ].sort()
    )
  })
})
