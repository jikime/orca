import SyncDatabase from '../sqlite/sync-database'
import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import { evaluateEnqueue, type QuotaLimits, type QuotaState } from './agent-event-outbox-quota'
import {
  OUTBOX_DDL,
  prepareOutboxStatements,
  type OutboxRow,
  type OutboxStatements,
  type UnackedRow
} from './agent-event-outbox-schema'

export type AgentEventAssertion = AgentEventEnvelope['data']['assertion']

// SINGLE-WRITER INVARIANT: exactly one upload pump owns writes to this store. `claimBatch`
// marks rows inflight and no second claimer may run concurrently, so the oldest-first claim and
// the inflight→acked/pending transitions never race. WAL lets that single writer commit without
// blocking reads. Crash recovery relies on this too: on open, any `inflight` row is reclaimed to
// `pending` (its owning pump died), so a batch that was mid-upload is safely re-sent. Because the
// server ingest is idempotent per (org, eventId), a re-send of an already-ingested event is a
// no-op `duplicate`, so replay never duplicates a session/turn/Artifact.

export type OutboxAuditReason =
  | 'over_quota_low_priority'
  | 'over_quota_observed_evicted'
  | 'revoked_purged'
  | 'permanent_rejected'

export type OutboxAuditRecord = {
  eventId: string
  streamId: string
  sequence: number
  byteSize: number
  assertion: AgentEventAssertion
  reason: OutboxAuditReason
}

export type ClaimedOutboxItem = {
  eventId: string
  streamId: string
  sequence: number
  byteSize: number
  attemptCount: number
  assertion: AgentEventAssertion
  envelope: AgentEventEnvelope
}

export type EnqueueResult = {
  inserted: boolean
  duplicate: boolean
  rejected: boolean
}

export type EnqueueQuota = {
  limits: QuotaLimits
  onAudit?: (record: OutboxAuditRecord) => void
}

export type OutboxStoreOptions = {
  // Checkpoint cadence: after this many acked rows OR this many acked bytes, run a WAL
  // checkpoint(TRUNCATE) and prune acked rows so the WAL and outbox file stay bounded.
  checkpointEveryAcks?: number
  checkpointByteThreshold?: number
}

const DEFAULT_CHECKPOINT_ACKS = 200
const DEFAULT_CHECKPOINT_BYTES = 8 * 1024 * 1024

export class AgentEventOutboxStore {
  private readonly db: SyncDatabase
  private readonly checkpointEveryAcks: number
  private readonly checkpointByteThreshold: number
  private acksSinceCheckpoint = 0
  private ackedBytesSinceCheckpoint = 0

  private readonly stmts: OutboxStatements

  constructor(path: string | ':memory:', options: OutboxStoreOptions = {}) {
    this.db = new SyncDatabase(path)
    // WAL keeps the single writer from blocking readers; NORMAL sync trades a tiny durability
    // window for throughput (the server ingest is idempotent, so a lost tail replays safely).
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.checkpointEveryAcks = options.checkpointEveryAcks ?? DEFAULT_CHECKPOINT_ACKS
    this.checkpointByteThreshold = options.checkpointByteThreshold ?? DEFAULT_CHECKPOINT_BYTES
    this.db.exec(OUTBOX_DDL)
    // Crash recovery: a prior pump that died left rows in `inflight`; reclaim them to `pending`
    // so they are re-claimed and re-sent (idempotent on the server → no duplicate).
    this.db.exec("UPDATE agent_event_outbox SET state = 'pending' WHERE state = 'inflight'")
    this.stmts = prepareOutboxStatements(this.db)
  }

  private state(): QuotaState {
    const count = this.stmts.unackedCount.get() as { c: number }
    const bytes = this.stmts.unackedBytes.get() as { b: number }
    return { rowCount: Number(count.c), byteSize: Number(bytes.b) }
  }

  /** Idempotent by eventId. When `quota` is supplied, applies the bound-the-outbox policy:
   *  a low-priority new event is rejected over quota; an `observed` event evicts the oldest
   *  pending row (audited) rather than being silently lost. */
  enqueue(event: AgentEventEnvelope, opts: { now: number; quota?: EnqueueQuota }): EnqueueResult {
    const eventId = event.id
    if (this.stmts.existsEvent.get(eventId)) {
      return { inserted: false, duplicate: true, rejected: false }
    }
    const serialized = JSON.stringify(event)
    const byteSize = Buffer.byteLength(serialized, 'utf8')
    const assertion = event.data.assertion

    if (opts.quota) {
      const decision = evaluateEnqueue(this.state(), { byteSize, assertion }, opts.quota.limits)
      if (decision.kind === 'reject') {
        // Never silently drop: the rejection of a low-priority event is recorded.
        opts.quota.onAudit?.({
          eventId,
          streamId: event.piestream,
          sequence: event.piesequence,
          byteSize,
          assertion,
          reason: 'over_quota_low_priority'
        })
        return { inserted: false, duplicate: false, rejected: true }
      }
      if (decision.kind === 'admit_evicting') {
        this.evictOldestPending(byteSize, opts.quota.limits, opts.quota.onAudit)
      }
    }

    const result = this.stmts.insertEvent.run(
      eventId,
      event.piestream,
      event.piesequence,
      serialized,
      byteSize,
      assertion,
      opts.now
    )
    return { inserted: result.changes > 0, duplicate: result.changes === 0, rejected: false }
  }

  // Make room for one incoming observed event by dropping the oldest pending rows. Only pending
  // rows are evictable — an inflight row may be mid-upload under the single writer's await, so
  // dropping it could lose a row the server is about to accept. Each drop is audited.
  private evictOldestPending(
    incomingBytes: number,
    limits: QuotaLimits,
    onAudit?: (record: OutboxAuditRecord) => void
  ): void {
    let guard = 0
    while (guard < limits.maxRows + 1) {
      guard += 1
      const state = this.state()
      const fits =
        state.rowCount + 1 <= limits.maxRows && state.byteSize + incomingBytes <= limits.maxBytes
      if (fits) {
        return
      }
      const victim = this.stmts.oldestPending.get(1) as
        | {
            event_id: string
            stream_id: string
            sequence: number
            byte_size: number
            assertion: AgentEventAssertion
          }
        | undefined
      if (!victim) {
        // Only inflight rows remain; admit the observed event over quota rather than lose it.
        return
      }
      this.stmts.deleteEvent.run(victim.event_id)
      onAudit?.({
        eventId: victim.event_id,
        streamId: victim.stream_id,
        sequence: victim.sequence,
        byteSize: victim.byte_size,
        assertion: victim.assertion,
        reason: 'over_quota_observed_evicted'
      })
    }
  }

  /** Oldest-first claim of pending, currently-visible rows, bounded by count and byte budget.
   *  Marks the claimed rows inflight (single-writer). Always returns at least one row if any is
   *  claimable, so a single oversized event cannot wedge the pump. */
  claimBatch(limit: number, maxBytes: number, now: number): ClaimedOutboxItem[] {
    const rows = this.stmts.claimSelect.all(now, limit) as OutboxRow[]
    const claimed: ClaimedOutboxItem[] = []
    let bytes = 0
    for (const row of rows) {
      if (claimed.length > 0 && bytes + row.byte_size > maxBytes) {
        break
      }
      const marked = this.stmts.markInflight.run(row.event_id)
      if (marked.changes === 0) {
        continue
      }
      bytes += row.byte_size
      claimed.push({
        eventId: row.event_id,
        streamId: row.stream_id,
        sequence: row.sequence,
        byteSize: row.byte_size,
        attemptCount: row.attempt_count,
        assertion: row.assertion,
        envelope: JSON.parse(row.envelope) as AgentEventEnvelope
      })
    }
    return claimed
  }

  /** Mark events acked (server confirmed ingest). Runs the checkpoint/prune policy when the
   *  cadence threshold is crossed. */
  ackBatch(eventIds: string[]): void {
    if (eventIds.length === 0) {
      return
    }
    const ackedBytesBefore = Number((this.stmts.ackedByteSum.get() as { b: number }).b)
    for (const eventId of eventIds) {
      this.stmts.setAcked.run(eventId)
    }
    const ackedBytesAfter = Number((this.stmts.ackedByteSum.get() as { b: number }).b)
    this.acksSinceCheckpoint += eventIds.length
    this.ackedBytesSinceCheckpoint += Math.max(0, ackedBytesAfter - ackedBytesBefore)
    if (
      this.acksSinceCheckpoint >= this.checkpointEveryAcks ||
      this.ackedBytesSinceCheckpoint >= this.checkpointByteThreshold
    ) {
      this.checkpoint()
    }
  }

  /** Return events to pending for retry, bumping attempt_count and gating re-claim until
   *  `nextVisibleAt` (caller computes the backoff). */
  nackBatch(eventIds: string[], nextVisibleAt: number): void {
    for (const eventId of eventIds) {
      this.stmts.nack.run(nextVisibleAt, eventId)
    }
  }

  pendingCount(): number {
    return Number((this.stmts.unackedCount.get() as { c: number }).c)
  }

  byteSize(): number {
    return Number((this.stmts.unackedBytes.get() as { b: number }).b)
  }

  pruneAcked(): number {
    return Number(this.stmts.pruneAcked.run().changes)
  }

  /** CAP-006 purge-on-revoke: after a permission revoke, drop every not-yet-acked event so
   *  sensitive data captured before the revoke is never uploaded later. Each drop is audited so
   *  no observed event is lost silently. Acked rows are already ingested and are left alone. */
  purgeUnacked(onAudit?: (record: OutboxAuditRecord) => void): number {
    const rows = this.stmts.selectUnacked.all() as UnackedRow[]
    for (const row of rows) {
      this.stmts.deleteEvent.run(row.event_id)
      onAudit?.({
        eventId: row.event_id,
        streamId: row.stream_id,
        sequence: row.sequence,
        byteSize: row.byte_size,
        assertion: row.assertion,
        reason: 'revoked_purged'
      })
    }
    return rows.length
  }

  /** Advance the gap-aware progress cursor for a stream to at least `contiguousThrough`. */
  advanceCursor(streamId: string, contiguousThrough: number): void {
    this.stmts.upsertCursor.run(streamId, contiguousThrough)
  }

  getCursor(streamId: string): number {
    const row = this.stmts.getCursor.get(streamId) as { c: number } | undefined
    return row ? Number(row.c) : 0
  }

  // WAL checkpoint cadence: prune acked rows then TRUNCATE the WAL so neither the outbox file nor
  // the WAL grows without bound during a long sync. Cheap and safe under the single writer.
  private checkpoint(): void {
    this.pruneAcked()
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.acksSinceCheckpoint = 0
    this.ackedBytesSinceCheckpoint = 0
  }

  close(): void {
    this.db.close()
  }
}
