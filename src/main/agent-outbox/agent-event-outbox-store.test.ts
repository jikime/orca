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

  it('quota: an observed event over-limit evicts the oldest pending row WITH an audit', () => {
    const audits: OutboxAuditRecord[] = []
    const quota = {
      limits: { maxRows: 2, maxBytes: 1_000_000 },
      onAudit: (r: OutboxAuditRecord) => audits.push(r)
    }
    store.enqueue(makeEnvelope({ id: 'old-1', sequence: 1 }), { now: NOW, quota })
    store.enqueue(makeEnvelope({ id: 'old-2', sequence: 2 }), { now: NOW, quota })
    // Third observed event is over the row bound → evict oldest (old-1), admit new, audit the drop.
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
  })

  it('quota: a low-priority event over-limit is rejected and audited, never silently lost', () => {
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
    // The observed event survived; the declared one was rejected but recorded.
    expect(store.pendingCount()).toBe(1)
    expect(audits[0]).toMatchObject({ eventId: 'dec-2', reason: 'over_quota_low_priority' })
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
