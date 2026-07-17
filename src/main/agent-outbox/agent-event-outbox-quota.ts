import type { AgentEventAssertion } from './agent-event-outbox-store'

// Outbox quota policy (R5 s2). Bounds the durable outbox by total bytes and/or row count so a
// long offline window cannot grow it without limit. The policy is pure and deterministic; the
// store executes the decision. The invariant: an `observed` event (real evidence) is NEVER
// silently lost — if it must be admitted over quota, an equal-or-lower-value older row is
// dropped WITH an audit record. A non-observed (declared/inferred) new event is rejected at the
// door when over quota rather than evicting evidence to fit it.

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

export type QuotaDecision =
  | { kind: 'admit' }
  | { kind: 'reject'; reason: 'over_quota_low_priority' }
  | { kind: 'admit_evicting'; reason: 'over_quota_observed' }

function wouldExceed(state: QuotaState, incoming: QuotaIncoming, limits: QuotaLimits): boolean {
  return state.rowCount + 1 > limits.maxRows || state.byteSize + incoming.byteSize > limits.maxBytes
}

export function evaluateEnqueue(
  state: QuotaState,
  incoming: QuotaIncoming,
  limits: QuotaLimits
): QuotaDecision {
  if (!wouldExceed(state, incoming, limits)) {
    return { kind: 'admit' }
  }
  // Over quota. Observed events are evidence and must survive: admit and evict the oldest to
  // make room (the eviction is audited by the store). Lower-priority events are rejected so we
  // never discard evidence to keep a declared/inferred event.
  if (incoming.assertion === 'observed') {
    return { kind: 'admit_evicting', reason: 'over_quota_observed' }
  }
  return { kind: 'reject', reason: 'over_quota_low_priority' }
}
