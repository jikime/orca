// R6 slice 3: the PURE, DETERMINISTIC SLA computation for service tickets (doc 14 §R6 SLA). No
// ambient clock — every function that needs "now" takes it as an argument, so a test can pin the
// clock and the result is reproducible. Two things are computed here and nowhere else:
//   1. the due timestamps at ticket create (created_at + the priority's target minutes), and
//   2. the per-ticket SLA phase (on_track | at_risk | breached) for response and resolution.
//
// SIMPLIFICATION (stated seam): due = created_at + target in CALENDAR time. Business-hours / SLA
// calendars (skip nights/weekends/holidays) are a deliberate future refinement — the target-minutes
// model and the injected `now` make it a drop-in replacement (compute due over a business calendar
// instead of raw addition) without changing callers.

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export type SlaPhase = 'on_track' | 'at_risk' | 'breached'

// Per-priority targets in MINUTES: time-to-first-response and time-to-resolution.
export type PriorityTargets = { responseTargetMinutes: number; resolutionTargetMinutes: number }
export type SlaTargets = Record<TicketPriority, PriorityTargets>

export const TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']

// The fallback SLA used when a ticket names no policy. Higher priority → tighter targets.
export const DEFAULT_SLA_TARGETS: SlaTargets = {
  urgent: { responseTargetMinutes: 30, resolutionTargetMinutes: 4 * 60 },
  high: { responseTargetMinutes: 60, resolutionTargetMinutes: 8 * 60 },
  normal: { responseTargetMinutes: 4 * 60, resolutionTargetMinutes: 24 * 60 },
  low: { responseTargetMinutes: 8 * 60, resolutionTargetMinutes: 72 * 60 }
}

// A ticket enters `at_risk` this many minutes before its due time (an unmet, not-yet-breached target
// whose deadline is imminent). A single lead window keeps the phase deterministic without needing the
// window size — calendar refinement can later derive it from the target instead.
export const DEFAULT_AT_RISK_LEAD_MINUTES = 60

const MINUTE_MS = 60_000

/** Default-deny: an unrecognized priority is treated as the tightest tier so a malformed value never
 *  widens the SLA window. */
export function normalizePriority(raw: string | null | undefined): TicketPriority {
  return raw === 'low' || raw === 'normal' || raw === 'high' || raw === 'urgent' ? raw : 'urgent'
}

/** due = base + target minutes (calendar-time; see the business-hours seam above). */
export function computeDueAt(base: Date, targetMinutes: number): Date {
  return new Date(base.getTime() + targetMinutes * MINUTE_MS)
}

/** The response + resolution due timestamps for a ticket created at `createdAt` at `priority`. */
export function computeTicketDueAt(
  createdAt: Date,
  priority: TicketPriority,
  targets: SlaTargets = DEFAULT_SLA_TARGETS
): { firstResponseDueAt: Date; resolutionDueAt: Date } {
  const target = targets[priority]
  return {
    firstResponseDueAt: computeDueAt(createdAt, target.responseTargetMinutes),
    resolutionDueAt: computeDueAt(createdAt, target.resolutionTargetMinutes)
  }
}

/**
 * The SLA phase for a single target. `breached` is the load-bearing definition: now is past due AND
 * the target was not met (met = metAt is set on or before due). A target met LATE (metAt after due) is
 * also `breached` — the deadline was missed. Otherwise `at_risk` when the deadline is within the lead
 * window, else `on_track`. Deterministic given the passed `now`.
 */
export function slaPhase(
  now: Date,
  dueAt: Date | null,
  metAt: Date | null,
  atRiskLeadMinutes: number = DEFAULT_AT_RISK_LEAD_MINUTES
): SlaPhase {
  // No due target set → nothing to breach (treat as on_track).
  if (!dueAt) {
    return 'on_track'
  }
  if (metAt) {
    return metAt.getTime() <= dueAt.getTime() ? 'on_track' : 'breached'
  }
  if (now.getTime() > dueAt.getTime()) {
    return 'breached'
  }
  const leadMs = atRiskLeadMinutes * MINUTE_MS
  return dueAt.getTime() - now.getTime() <= leadMs ? 'at_risk' : 'on_track'
}

export type TicketSlaTimestamps = {
  firstResponseDueAt: Date | null
  resolutionDueAt: Date | null
  firstRespondedAt: Date | null
  resolvedAt: Date | null
}

export type TicketSlaStatus = { response: SlaPhase; resolution: SlaPhase }

/** The response + resolution SLA phases for a ticket, given the injected `now`. */
export function computeTicketSlaStatus(
  now: Date,
  times: TicketSlaTimestamps,
  atRiskLeadMinutes: number = DEFAULT_AT_RISK_LEAD_MINUTES
): TicketSlaStatus {
  return {
    response: slaPhase(now, times.firstResponseDueAt, times.firstRespondedAt, atRiskLeadMinutes),
    resolution: slaPhase(now, times.resolutionDueAt, times.resolvedAt, atRiskLeadMinutes)
  }
}

/** Reads a stored policy `targets` jsonb into a full SlaTargets, falling back per-priority to the
 *  defaults so a partial or empty policy is always complete and deterministic. */
export function resolveSlaTargets(raw: unknown): SlaTargets {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const resolved = {} as SlaTargets
  for (const priority of TICKET_PRIORITIES) {
    const entry = source[priority]
    const fallback = DEFAULT_SLA_TARGETS[priority]
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      resolved[priority] = {
        responseTargetMinutes:
          typeof record.responseTargetMinutes === 'number'
            ? record.responseTargetMinutes
            : fallback.responseTargetMinutes,
        resolutionTargetMinutes:
          typeof record.resolutionTargetMinutes === 'number'
            ? record.resolutionTargetMinutes
            : fallback.resolutionTargetMinutes
      }
    } else {
      resolved[priority] = fallback
    }
  }
  return resolved
}
