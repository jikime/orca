import type { QuotaLimits, QuotaState } from './agent-event-outbox-quota'

// Staged outbox degradation (SYN-002 "offline outbox fills disk"). Rather than a single hard cap
// that drops events at the wall, usage is graded into stages so capture degrades gracefully and the
// queue keeps room for `observed` evidence as long as possible. Stage is a pure function of usage
// vs the cap — no clock, no timers — so it is deterministic and testable.

export type QuotaStage = 'normal' | 'warn' | 'degraded' | 'paused'

// Fractions of the absolute cap (max of the row- and byte-usage ratios) at which each stage begins.
// warn: emit a warning fact. degrade: strip NON-observed payload bodies to metadata-only so the
// queue accepts observed evidence longer. paused: refuse new NON-observed events entirely; observed
// events are still admitted (up to the absolute cap) so evidence is never turned away early.
export type QuotaThresholds = {
  warnPct: number
  degradePct: number
  fullPct: number
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  warnPct: 0.75,
  degradePct: 0.9,
  fullPct: 0.97
}

function usageFraction(state: QuotaState, limits: QuotaLimits): number {
  const rowFraction = limits.maxRows > 0 ? state.rowCount / limits.maxRows : 0
  const byteFraction = limits.maxBytes > 0 ? state.byteSize / limits.maxBytes : 0
  return Math.max(rowFraction, byteFraction)
}

/** Current degradation stage from usage vs the cap. Pure/deterministic (no clock). */
export function computeQuotaStage(
  state: QuotaState,
  limits: QuotaLimits,
  thresholds: QuotaThresholds = DEFAULT_QUOTA_THRESHOLDS
): QuotaStage {
  const fraction = usageFraction(state, limits)
  if (fraction >= thresholds.fullPct) {
    return 'paused'
  }
  if (fraction >= thresholds.degradePct) {
    return 'degraded'
  }
  if (fraction >= thresholds.warnPct) {
    return 'warn'
  }
  return 'normal'
}
