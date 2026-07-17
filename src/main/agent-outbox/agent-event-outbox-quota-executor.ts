import type { AgentEventEnvelope } from '../../shared/agent-event-batch-contract'
import { decideQuotaAction, type QuotaLimits, type QuotaState } from './agent-event-outbox-quota'
import type { QuotaStage } from './agent-event-outbox-quota-stages'
import { stripEnvelopeToMetadata } from './agent-event-metadata-only-envelope'
import type { OutboxStatements } from './agent-event-outbox-schema'
import type {
  AgentEventAssertion,
  EnqueueQuota,
  OutboxAuditReason,
  OutboxAuditRecord
} from './agent-event-outbox-store'

// Executor for the staged-quota decision (SYN-002). Kept separate from the store so the store file
// stays focused on schema/lifecycle. Operates over the prepared statements + a live usage reader,
// applying the pure decision from agent-event-outbox-quota.ts and recording pressure durably.

export type QuotaExecutorContext = {
  stmts: OutboxStatements
  readState: () => QuotaState
}

export type QuotaAdmitOutcome =
  | { store: false }
  | { store: true; envelope: AgentEventEnvelope; serialized: string; byteSize: number }

type LowValueVictim = {
  event_id: string
  stream_id: string
  sequence: number
  byte_size: number
  assertion: AgentEventAssertion
}

function fitsUnderCap(
  readState: () => QuotaState,
  incomingBytes: number,
  limits: QuotaLimits
): boolean {
  const state = readState()
  return state.rowCount + 1 <= limits.maxRows && state.byteSize + incomingBytes <= limits.maxBytes
}

// Make room for one incoming observed event by dropping only the oldest LOWER-VALUE (non-observed)
// pending rows — an observed row is never a victim, so evidence is never evicted to admit another
// event. Only pending rows are evictable (an inflight row may be mid-upload). Returns whether the
// observed event now fits; false means the caller must reject-with-record instead of dropping it.
function evictLowerValueForObserved(
  ctx: QuotaExecutorContext,
  incomingBytes: number,
  limits: QuotaLimits,
  onAudit?: (record: OutboxAuditRecord) => void
): boolean {
  let guard = 0
  while (guard < limits.maxRows + 1) {
    guard += 1
    if (fitsUnderCap(ctx.readState, incomingBytes, limits)) {
      return true
    }
    const victim = ctx.stmts.oldestPendingLowValue.get(1) as LowValueVictim | undefined
    if (!victim) {
      // No lower-value pending row left to reclaim (only observed and/or inflight rows remain).
      return false
    }
    ctx.stmts.deleteEvent.run(victim.event_id)
    onAudit?.({
      eventId: victim.event_id,
      streamId: victim.stream_id,
      sequence: victim.sequence,
      byteSize: victim.byte_size,
      assertion: victim.assertion,
      reason: 'over_quota_observed_evicted'
    })
  }
  return fitsUnderCap(ctx.readState, incomingBytes, limits)
}

// Record quota pressure both durably (a marker row that survives restart) and via the audit
// callback, so a degraded/paused/rejected event is never lost unrecorded. Never stores payload.
function recordPressure(
  ctx: QuotaExecutorContext,
  event: AgentEventEnvelope,
  stage: QuotaStage,
  reason: OutboxAuditReason,
  now: number,
  quota: EnqueueQuota
): void {
  const byteSize = Buffer.byteLength(JSON.stringify(event), 'utf8')
  ctx.stmts.insertPressureMarker.run(
    stage,
    reason,
    event.id,
    event.piestream,
    event.piesequence,
    byteSize,
    event.data.assertion,
    now
  )
  quota.onAudit?.({
    eventId: event.id,
    streamId: event.piestream,
    sequence: event.piesequence,
    byteSize,
    assertion: event.data.assertion,
    reason
  })
}

/**
 * Resolve the staged-quota decision into either a (possibly degraded) envelope to store or a
 * recorded rejection. `fullByteSize` is the size of the verbatim envelope used for the decision.
 */
export function applyQuotaDecision(
  ctx: QuotaExecutorContext,
  event: AgentEventEnvelope,
  fullByteSize: number,
  now: number,
  quota: EnqueueQuota
): QuotaAdmitOutcome {
  const assertion = event.data.assertion
  const config = { limits: quota.limits, thresholds: quota.thresholds }
  const decision = decideQuotaAction(ctx.readState(), { byteSize: fullByteSize, assertion }, config)

  if (decision.kind === 'admit') {
    return {
      store: true,
      envelope: event,
      serialized: JSON.stringify(event),
      byteSize: fullByteSize
    }
  }
  if (decision.kind === 'admit_metadata_only') {
    const stripped = stripEnvelopeToMetadata(event)
    const serialized = JSON.stringify(stripped)
    const byteSize = Buffer.byteLength(serialized, 'utf8')
    // Even the metadata receipt must fit; if not, reject-with-record rather than drop silently.
    if (!fitsUnderCap(ctx.readState, byteSize, quota.limits)) {
      recordPressure(ctx, event, decision.stage, 'over_quota_low_priority', now, quota)
      return { store: false }
    }
    recordPressure(ctx, event, decision.stage, 'degraded_metadata_only', now, quota)
    return { store: true, envelope: stripped, serialized, byteSize }
  }
  if (decision.kind === 'admit_evicting') {
    const freed = evictLowerValueForObserved(ctx, fullByteSize, quota.limits, quota.onAudit)
    if (!freed) {
      // Cap reached and no lower-value row to evict: reject the observed event WITH a durable record
      // rather than evict another observed row. Evidence is never lost unrecorded.
      recordPressure(ctx, event, decision.stage, 'over_quota_observed_capacity', now, quota)
      return { store: false }
    }
    return {
      store: true,
      envelope: event,
      serialized: JSON.stringify(event),
      byteSize: fullByteSize
    }
  }
  recordPressure(ctx, event, decision.stage, decision.reason, now, quota)
  return { store: false }
}
