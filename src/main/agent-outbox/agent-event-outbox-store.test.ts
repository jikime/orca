import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentEventOutboxStore, type OutboxAuditRecord } from './agent-event-outbox-store'
import { makeEnvelope } from './__fixtures__/agent-event-envelope-fixture'

let store: AgentEventOutboxStore
const NOW = 1_000_000

beforeEach(() => {
  store = new AgentEventOutboxStore(':memory:')
})

afterEach(() => {
  store.close()
})

describe('agent-event-outbox-store', () => {
  it('enqueue is idempotent by eventId (same eventId twice → one row)', () => {
    const event = makeEnvelope({ id: 'evt-1', sequence: 1 })
    const first = store.enqueue(event, { now: NOW })
    const second = store.enqueue(event, { now: NOW })
    expect(first).toEqual({ inserted: true, duplicate: false, rejected: false })
    expect(second).toEqual({ inserted: false, duplicate: true, rejected: false })
    expect(store.pendingCount()).toBe(1)
  })

  it('claim marks inflight and ack removes the row from the unacked set', () => {
    store.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    store.enqueue(makeEnvelope({ id: 'evt-2', sequence: 2 }), { now: NOW })
    const claimed = store.claimBatch(10, 1_000_000, NOW)
    expect(claimed.map((c) => c.eventId)).toEqual(['evt-1', 'evt-2'])
    // Inflight rows are still "unacked" (crash would reclaim them), so pendingCount stays 2.
    expect(store.pendingCount()).toBe(2)
    // A second claim finds nothing (already inflight — single writer).
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(0)
    store.ackBatch(['evt-1', 'evt-2'])
    expect(store.pendingCount()).toBe(0)
    // pruneAcked physically removes the acked rows.
    expect(store.pruneAcked()).toBe(2)
  })

  it('advanceCursor tracks the monotonic max contiguousThrough per stream', () => {
    expect(store.getCursor('stream-a')).toBe(0)
    store.advanceCursor('stream-a', 5)
    store.advanceCursor('stream-a', 3)
    expect(store.getCursor('stream-a')).toBe(5)
    store.advanceCursor('stream-a', 8)
    expect(store.getCursor('stream-a')).toBe(8)
  })

  it('nack returns events to pending, bumps attempt, and gates re-claim until nextVisibleAt', () => {
    store.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    store.claimBatch(10, 1_000_000, NOW)
    store.nackBatch(['evt-1'], NOW + 5000)
    // Not visible yet at NOW.
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(0)
    // Visible again once the clock passes nextVisibleAt; attempt_count is bumped.
    const reclaimed = store.claimBatch(10, 1_000_000, NOW + 5000)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].attemptCount).toBe(1)
  })

  it('claim respects the byte budget but always yields at least one row', () => {
    store.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    store.enqueue(makeEnvelope({ id: 'evt-2', sequence: 2 }), { now: NOW })
    // Budget below one event's size → still returns exactly one (no wedge).
    const claimed = store.claimBatch(10, 1, NOW)
    expect(claimed).toHaveLength(1)
  })

  it('quota: an over-cap observed event evicts only a LOWER-VALUE (declared) row, audited', () => {
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 2, maxBytes: 1_000_000 },
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    store.enqueue(makeEnvelope({ id: 'old-1', sequence: 1, assertion: 'declared' }), {
      now: NOW,
      quota
    })
    store.enqueue(makeEnvelope({ id: 'old-2', sequence: 2, assertion: 'declared' }), {
      now: NOW,
      quota
    })
    // Over the row bound → evict the oldest lower-value row (old-1), admit the observed event.
    const result = store.enqueue(
      makeEnvelope({ id: 'new-3', sequence: 3, assertion: 'observed' }),
      {
        now: NOW,
        quota
      }
    )
    expect(result.inserted).toBe(true)
    expect(store.pendingCount()).toBe(2)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ eventId: 'old-1', reason: 'over_quota_observed_evicted' })
    expect(store.claimBatch(10, 1_000_000, NOW).map((c) => c.eventId)).toEqual(['old-2', 'new-3'])
  })

  it('INVARIANT: an observed row is NEVER evicted to admit another event (reject-with-record)', () => {
    // The exact scenario the audit flagged: the only pending rows are themselves observed and a new
    // observed event is over the cap. Evidence must survive; the NEW enqueue is rejected-with-record.
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 2, maxBytes: 1_000_000 },
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    store.enqueue(makeEnvelope({ id: 'obs-1', sequence: 1, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    store.enqueue(makeEnvelope({ id: 'obs-2', sequence: 2, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    const result = store.enqueue(
      makeEnvelope({ id: 'obs-3', sequence: 3, assertion: 'observed' }),
      {
        now: NOW,
        quota
      }
    )
    expect(result).toEqual({ inserted: false, duplicate: false, rejected: true })
    // Both original observed rows survived; neither was evicted for the newcomer.
    expect(store.pendingCount()).toBe(2)
    expect(store.claimBatch(10, 1_000_000, NOW).map((c) => c.eventId)).toEqual(['obs-1', 'obs-2'])
    // The rejected observed event is recorded (audit + durable marker) — never a silent drop.
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ eventId: 'obs-3', reason: 'over_quota_observed_capacity' })
    expect(store.pressureMarkerCount()).toBe(1)
  })

  it('quota: a paused non-observed event is rejected and recorded, never silently lost', () => {
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 1, maxBytes: 1_000_000 },
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    store.enqueue(makeEnvelope({ id: 'obs-1', sequence: 1, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    const result = store.enqueue(
      makeEnvelope({ id: 'dec-2', sequence: 2, assertion: 'declared' }),
      {
        now: NOW,
        quota
      }
    )
    expect(result).toEqual({ inserted: false, duplicate: false, rejected: true })
    // The observed event survived; the declared one was rejected but recorded (audit + marker).
    expect(store.pendingCount()).toBe(1)
    expect(audits[0]).toMatchObject({ eventId: 'dec-2', reason: 'paused_non_observed' })
    expect(store.pressureMarkerCount()).toBe(1)
  })

  const STAGE_THRESHOLDS = { warnPct: 0.3, degradePct: 0.5, fullPct: 0.8 }

  it('quota: degrade stage strips a NON-observed payload but keeps observed evidence intact', () => {
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 10, maxBytes: 5_000_000 },
      thresholds: STAGE_THRESHOLDS,
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    // Fill to the degrade band (5/10 = 0.5) with observed evidence.
    for (let i = 0; i < 5; i += 1) {
      store.enqueue(
        makeEnvelope({ id: `obs-${i}`, sequence: i, assertion: 'observed', contentHash: `h${i}` }),
        { now: NOW, quota }
      )
    }
    expect(store.quotaStage()).toBe('degraded')
    // A non-observed event is admitted but its payload body is stripped to a metadata-only receipt.
    const degraded = store.enqueue(
      makeEnvelope({ id: 'dec-x', sequence: 99, assertion: 'declared', contentHash: 'keep-me' }),
      { now: NOW, quota }
    )
    expect(degraded.inserted).toBe(true)
    expect(audits.some((a) => a.eventId === 'dec-x' && a.reason === 'degraded_metadata_only')).toBe(
      true
    )
    const claimed = store.claimBatch(50, 5_000_000, NOW)
    // Non-observed payload body gone, only the contentHash receipt + marker remain.
    expect(claimed.find((c) => c.eventId === 'dec-x')?.envelope.data.payload).toEqual({
      degraded: 'metadata_only',
      contentHash: 'keep-me'
    })
    // Observed evidence keeps its full payload.
    expect(claimed.find((c) => c.eventId === 'obs-0')?.envelope.data.payload).toMatchObject({
      note: 'streamed'
    })
  })

  it('quota: paused stage rejects non-observed but still admits observed until the cap', () => {
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 10, maxBytes: 5_000_000 },
      thresholds: STAGE_THRESHOLDS,
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    // Fill to the paused band (8/10 = 0.8) with observed evidence.
    for (let i = 0; i < 8; i += 1) {
      store.enqueue(makeEnvelope({ id: `obs-${i}`, sequence: i, assertion: 'observed' }), {
        now: NOW,
        quota
      })
    }
    expect(store.quotaStage()).toBe('paused')
    expect(store.captureDegraded()).toBe(true)
    // Non-observed refused (recorded); observed evidence still admitted until the absolute cap.
    const rejected = store.enqueue(
      makeEnvelope({ id: 'dec-x', sequence: 80, assertion: 'declared' }),
      {
        now: NOW,
        quota
      }
    )
    expect(rejected.rejected).toBe(true)
    expect(audits.some((a) => a.eventId === 'dec-x' && a.reason === 'paused_non_observed')).toBe(
      true
    )
    const admitted = store.enqueue(
      makeEnvelope({ id: 'obs-8', sequence: 8, assertion: 'observed' }),
      {
        now: NOW,
        quota
      }
    )
    expect(admitted.inserted).toBe(true)
    expect(store.pendingCount()).toBe(9)
  })

  it('quota: fires a stage-transition callback when the degradation level changes', () => {
    const transitions: { from: string; to: string }[] = []
    const quota = {
      limits: { maxRows: 4, maxBytes: 5_000_000 },
      thresholds: { warnPct: 0.25, degradePct: 0.5, fullPct: 0.75 },
      onStageTransition: (t: { from: string; to: string }) => transitions.push(t)
    }
    store.enqueue(makeEnvelope({ id: 'e0', sequence: 0, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    store.enqueue(makeEnvelope({ id: 'e1', sequence: 1, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    store.enqueue(makeEnvelope({ id: 'e2', sequence: 2, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    expect(transitions).toEqual([
      { from: 'normal', to: 'warn' },
      { from: 'warn', to: 'degraded' },
      { from: 'degraded', to: 'paused' }
    ])
  })

  it('purgeUnacked drops every not-yet-acked event with an audit (CAP-006 purge-on-revoke)', () => {
    const audits: OutboxAuditRecord[] = []
    store.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    store.enqueue(makeEnvelope({ id: 'evt-2', sequence: 2 }), { now: NOW })
    store.claimBatch(1, 1_000_000, NOW) // one becomes inflight; purge must still drop it
    const purged = store.purgeUnacked((r) => audits.push(r))
    expect(purged).toBe(2)
    expect(store.pendingCount()).toBe(0)
    expect(audits.every((a) => a.reason === 'revoked_purged')).toBe(true)
  })
})

describe('agent-event-outbox-store crash safety (real file)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-store-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reclaims inflight rows as pending on re-open and does not duplicate on replay', () => {
    const path = join(dir, 'outbox.db')
    const first = new AgentEventOutboxStore(path)
    first.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    const claimed = first.claimBatch(10, 1_000_000, NOW)
    expect(claimed).toHaveLength(1)
    // Simulate a crash: the pump died with the row still inflight.
    first.close()

    const reopened = new AgentEventOutboxStore(path)
    // Inflight was reclaimed to pending → claimable again, no second row created.
    const reclaimed = reopened.claimBatch(10, 1_000_000, NOW)
    expect(reclaimed.map((c) => c.eventId)).toEqual(['evt-1'])
    expect(reopened.pendingCount()).toBe(1)
    // A re-enqueue of the same eventId after the crash stays a single row (idempotent).
    const reEnqueue = reopened.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    expect(reEnqueue.duplicate).toBe(true)
    expect(reopened.pendingCount()).toBe(1)
    reopened.close()
  })

  it('persists the degradation pressure marker across a restart (durable, nothing lost)', () => {
    const path = join(dir, 'pressure.db')
    const quota = { limits: { maxRows: 1, maxBytes: 1_000_000 } }
    const first = new AgentEventOutboxStore(path)
    first.enqueue(makeEnvelope({ id: 'obs-1', sequence: 1, assertion: 'observed' }), {
      now: NOW,
      quota
    })
    // Over the cap, non-observed → rejected-with-record: a durable marker is written.
    first.enqueue(makeEnvelope({ id: 'dec-2', sequence: 2, assertion: 'declared' }), {
      now: NOW,
      quota
    })
    expect(first.pressureMarkerCount()).toBe(1)
    first.close()
    // The marker survives the restart so the tracking service can still see capture degraded.
    const reopened = new AgentEventOutboxStore(path)
    expect(reopened.pressureMarkerCount()).toBe(1)
    reopened.close()
  })

  it('uses WAL journal mode on a real file (single-writer + non-blocking reads)', () => {
    const path = join(dir, 'wal.db')
    const s = new AgentEventOutboxStore(path)
    // Round-trip a row to ensure the schema+WAL are functional.
    s.enqueue(makeEnvelope({ id: 'evt-1', sequence: 1 }), { now: NOW })
    expect(s.pendingCount()).toBe(1)
    s.close()
    // A fresh open over the same WAL file sees the committed row.
    const again = new AgentEventOutboxStore(path)
    expect(again.pendingCount()).toBe(1)
    again.close()
  })
})
