import type { AgentEventAssertion } from './agent-event-outbox-store'
import {
  computeQuotaStage,
  DEFAULT_QUOTA_THRESHOLDS,
  type QuotaStage,
  type QuotaThresholds
} from './agent-event-outbox-quota-stages'

// Outbox quota policy (R5 s2, hardened for SYN-002). Bounds the durable outbox by total bytes
// and/or row count so a long offline window cannot fill the disk. The policy is pure and
// deterministic (no clock); the store executes the decision. Core invariant: an `observed` event is
// real evidence and is NEVER silently dropped. Eviction may reclaim space ONLY from lower-value
// (declared/verified) rows — an `observed` row is never evicted to admit another event. If the cap
// can only be met by dropping an `observed` row, we do NOT: the store rejects the new enqueue and
// records the pressure (audit + a durable marker), so nothing observed is lost unrecorded.

export type QuotaLimits = {
  maxRows: number
  maxBytes: number
}

export type QuotaState = {
  rowCount: number
  byteSize: number
}

export type QuotaIncoming = {
  byteSize: number
  assertion: AgentEventAssertion
}

export type QuotaConfig = {
  limits: QuotaLimits
  thresholds?: QuotaThresholds
}

// Value ordering: `observed` is the protected tier; everything else is lower value and may be
// degraded (payload stripped) or rejected under pressure to keep room for evidence.
function isObserved(assertion: AgentEventAssertion): boolean {
  return assertion === 'observed'
}

export type QuotaAction =
  | { kind: 'admit'; stage: QuotaStage }
  | { kind: 'admit_metadata_only'; stage: QuotaStage; reason: 'degrade_non_observed' }
  | { kind: 'admit_evicting'; stage: QuotaStage; reason: 'over_quota_observed' }
  | { kind: 'reject'; stage: QuotaStage; reason: 'over_quota_low_priority' | 'paused_non_observed' }

function fitsUnderCap(state: QuotaState, incomingBytes: number, limits: QuotaLimits): boolean {
  return state.rowCount + 1 <= limits.maxRows && state.byteSize + incomingBytes <= limits.maxBytes
}

/**
 * Pure staged-degradation decision for one incoming event. Returns the current stage plus the
 * admission action. Observed events are protected (admitted, evicting only lower-value rows if
 * over cap — never dropping evidence). Non-observed events degrade to metadata-only at the degrade
 * stage and are rejected-with-record once paused, so the queue keeps headroom for evidence.
 */
export function decideQuotaAction(
  state: QuotaState,
  incoming: QuotaIncoming,
  config: QuotaConfig
): QuotaAction {
  const thresholds = config.thresholds ?? DEFAULT_QUOTA_THRESHOLDS
  const stage = computeQuotaStage(state, config.limits, thresholds)
  const fits = fitsUnderCap(state, incoming.byteSize, config.limits)

  if (isObserved(incoming.assertion)) {
    // Evidence: admit when it fits; otherwise reclaim space from lower-value rows only. The store
    // rejects-with-record if no lower-value row can free enough — it never evicts an observed row.
    return fits
      ? { kind: 'admit', stage }
      : { kind: 'admit_evicting', stage, reason: 'over_quota_observed' }
  }

  // Non-observed (declared/verified): protect evidence headroom under pressure.
  if (stage === 'paused') {
    return { kind: 'reject', stage, reason: 'paused_non_observed' }
  }
  if (stage === 'degraded') {
    // Strip the payload body (keep envelope + contentHash) so the queue accepts more before full.
    return { kind: 'admit_metadata_only', stage, reason: 'degrade_non_observed' }
  }
  if (!fits) {
    return { kind: 'reject', stage, reason: 'over_quota_low_priority' }
  }
  return { kind: 'admit', stage }
}
