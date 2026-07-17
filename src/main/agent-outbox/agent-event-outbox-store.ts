import SyncDatabase from '../sqlite/sync-database'
import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import type { QuotaLimits, QuotaState } from './agent-event-outbox-quota'
import {
  computeQuotaStage,
  DEFAULT_QUOTA_THRESHOLDS,
  type QuotaStage,
  type QuotaThresholds
} from './agent-event-outbox-quota-stages'
import { applyQuotaDecision } from './agent-event-outbox-quota-executor'
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
  // A lower-value (declared/verified) row evicted to make room for an observed event.
  | 'over_quota_observed_evicted'
  // Non-observed refused because the outbox is paused (near cap) to keep headroom for evidence.
  | 'paused_non_observed'
  // Non-observed admitted but its payload body stripped to a metadata-only receipt.
  | 'degraded_metadata_only'
  // Observed event rejected at the absolute cap because no lower-value row could be evicted. Kept
  // as a durable record so evidence is never lost silently — it is rejected-with-record, not dropped.
  | 'over_quota_observed_capacity'
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

export type QuotaStageTransition = {
  from: QuotaStage
  to: QuotaStage
}

export type EnqueueQuota = {
  limits: QuotaLimits
  thresholds?: QuotaThresholds
  onAudit?: (record: OutboxAuditRecord) => void
  // Fired when the degradation stage changes across an enqueue (never carries payload content).
  onStageTransition?: (transition: QuotaStageTransition) => void
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
  // Last observed degradation stage + config, so the stage can be surfaced (quotaStage) and
  // transitions detected between enqueues without a clock.
  private lastStage: QuotaStage = 'normal'
  private lastQuotaLimits: QuotaLimits | null = null
  private lastQuotaThresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS

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

  /** Idempotent by eventId. When `quota` is supplied, applies the staged-degradation policy:
   *  under pressure non-observed payloads degrade to metadata-only then pause, while an `observed`
   *  event is admitted by evicting only lower-value rows — never another observed row. An event
   *  that cannot be admitted is rejected-with-record (audit + durable marker), never dropped. */
  enqueue(event: AgentEventEnvelope, opts: { now: number; quota?: EnqueueQuota }): EnqueueResult {
    const eventId = event.id
    if (this.stmts.existsEvent.get(eventId)) {
      return { inserted: false, duplicate: true, rejected: false }
    }
    let toStore = event
    let serialized = JSON.stringify(event)
    let byteSize = Buffer.byteLength(serialized, 'utf8')
    const assertion = event.data.assertion
    let rejected = false

    if (opts.quota) {
      const ctx = { stmts: this.stmts, readState: () => this.state() }
      const outcome = applyQuotaDecision(ctx, event, byteSize, opts.now, opts.quota)
      if (outcome.store) {
        toStore = outcome.envelope
        serialized = outcome.serialized
        byteSize = outcome.byteSize
      } else {
        rejected = true
      }
    }

    const result = rejected
      ? { changes: 0 }
      : this.stmts.insertEvent.run(
          eventId,
          toStore.piestream,
          toStore.piesequence,
          serialized,
          byteSize,
          assertion,
          opts.now
        )
    // Recompute the stage AFTER the row lands so surfacing/transitions reflect real usage.
    if (opts.quota) {
      this.updateStage(opts.quota)
    }
    if (rejected) {
      return { inserted: false, duplicate: false, rejected: true }
    }
    return { inserted: result.changes > 0, duplicate: result.changes === 0, rejected: false }
  }

  // Recompute the stage from current usage and fire a transition callback on change. Kept separate
  // from the decision so surfacing/telemetry never influences the pure admission logic.
  private updateStage(quota: EnqueueQuota): void {
    this.lastQuotaLimits = quota.limits
    this.lastQuotaThresholds = quota.thresholds ?? DEFAULT_QUOTA_THRESHOLDS
    const stage = computeQuotaStage(this.state(), this.lastQuotaLimits, this.lastQuotaThresholds)
    if (stage !== this.lastStage) {
      quota.onStageTransition?.({ from: this.lastStage, to: stage })
      this.lastStage = stage
    }
  }

  /** Current degradation stage (normal|warn|degraded|paused) from live usage, for the tracking
   *  service / UI. Returns 'normal' until a quota-bearing enqueue has established the limits. */
  quotaStage(): QuotaStage {
    if (!this.lastQuotaLimits) {
      return 'normal'
    }
    return computeQuotaStage(this.state(), this.lastQuotaLimits, this.lastQuotaThresholds)
  }

  /** True when capture is degrading (payloads stripped) or paused (non-observed refused). */
  captureDegraded(): boolean {
    const stage = this.quotaStage()
    return stage === 'degraded' || stage === 'paused'
  }

  /** Count of durable pressure markers recorded (degrade/pause/observed-cap). Survives restart. */
  pressureMarkerCount(): number {
    return Number((this.stmts.pressureMarkerCount.get() as { c: number }).c)
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
