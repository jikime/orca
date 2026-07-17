import { describe, expect, it } from 'vitest'
import { evaluateEnqueue, type QuotaLimits } from './agent-event-outbox-quota'

const LIMITS: QuotaLimits = { maxRows: 3, maxBytes: 1000 }

describe('agent-event-outbox-quota', () => {
  it('admits when both bounds have room', () => {
    const decision = evaluateEnqueue(
      { rowCount: 1, byteSize: 100 },
      { byteSize: 100, assertion: 'observed' },
      LIMITS
    )
    expect(decision).toEqual({ kind: 'admit' })
  })

  it('rejects a low-priority event over the row bound (never evict evidence for it)', () => {
    const decision = evaluateEnqueue(
      { rowCount: 3, byteSize: 100 },
      { byteSize: 10, assertion: 'declared' },
      LIMITS
    )
    expect(decision).toEqual({ kind: 'reject', reason: 'over_quota_low_priority' })
  })

  it('rejects a low-priority event over the byte bound', () => {
    const decision = evaluateEnqueue(
      { rowCount: 1, byteSize: 950 },
      { byteSize: 100, assertion: 'declared' },
      LIMITS
    )
    expect(decision).toEqual({ kind: 'reject', reason: 'over_quota_low_priority' })
  })

  it('admits an observed event over quota by evicting (observed evidence is never lost)', () => {
    const decision = evaluateEnqueue(
      { rowCount: 3, byteSize: 100 },
      { byteSize: 10, assertion: 'observed' },
      LIMITS
    )
    expect(decision).toEqual({ kind: 'admit_evicting', reason: 'over_quota_observed' })
  })
})
