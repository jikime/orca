import { describe, expect, it } from 'vitest'
import { decideQuotaAction, type QuotaConfig } from './agent-event-outbox-quota'
import { computeQuotaStage } from './agent-event-outbox-quota-stages'

// maxBytes drives the stage fraction here (maxRows kept high so rows never dominate).
const CONFIG: QuotaConfig = { limits: { maxRows: 1000, maxBytes: 1000 } }

describe('computeQuotaStage', () => {
  const limits = { maxRows: 1000, maxBytes: 1000 }

  it('grades usage into normal/warn/degraded/paused at the default thresholds', () => {
    expect(computeQuotaStage({ rowCount: 1, byteSize: 700 }, limits)).toBe('normal')
    expect(computeQuotaStage({ rowCount: 1, byteSize: 750 }, limits)).toBe('warn')
    expect(computeQuotaStage({ rowCount: 1, byteSize: 900 }, limits)).toBe('degraded')
    expect(computeQuotaStage({ rowCount: 1, byteSize: 970 }, limits)).toBe('paused')
  })

  it('uses the max of the row- and byte-usage ratios', () => {
    // Rows at 98% dominate even though bytes are near-empty.
    expect(computeQuotaStage({ rowCount: 980, byteSize: 1 }, limits)).toBe('paused')
  })
})

describe('decideQuotaAction', () => {
  it('admits when both bounds have room (normal stage)', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 100 },
      { byteSize: 100, assertion: 'observed' },
      CONFIG
    )
    expect(decision).toEqual({ kind: 'admit', stage: 'normal' })
  })

  it('rejects a non-observed event that would exceed the cap in a normal stage', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 100 },
      { byteSize: 950, assertion: 'declared' },
      CONFIG
    )
    expect(decision).toEqual({ kind: 'reject', stage: 'normal', reason: 'over_quota_low_priority' })
  })

  it('degrades a non-observed event to metadata-only at the degrade stage', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 900 },
      { byteSize: 10, assertion: 'declared' },
      CONFIG
    )
    expect(decision).toEqual({
      kind: 'admit_metadata_only',
      stage: 'degraded',
      reason: 'degrade_non_observed'
    })
  })

  it('pauses non-observed events once the outbox is near the cap', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 980 },
      { byteSize: 10, assertion: 'declared' },
      CONFIG
    )
    expect(decision).toEqual({ kind: 'reject', stage: 'paused', reason: 'paused_non_observed' })
  })

  it('still admits observed evidence while paused, as long as it fits under the cap', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 980 },
      { byteSize: 10, assertion: 'observed' },
      CONFIG
    )
    expect(decision).toEqual({ kind: 'admit', stage: 'paused' })
  })

  it('signals evict-lower-value (never drop evidence) when observed does not fit', () => {
    const decision = decideQuotaAction(
      { rowCount: 1, byteSize: 995 },
      { byteSize: 20, assertion: 'observed' },
      CONFIG
    )
    expect(decision).toEqual({
      kind: 'admit_evicting',
      stage: 'paused',
      reason: 'over_quota_observed'
    })
  })

  it('is deterministic: identical inputs yield identical decisions', () => {
    const state = { rowCount: 1, byteSize: 900 }
    const incoming = { byteSize: 10, assertion: 'declared' as const }
    const first = decideQuotaAction(state, incoming, CONFIG)
    const second = decideQuotaAction(state, incoming, CONFIG)
    expect(second).toEqual(first)
  })
})
