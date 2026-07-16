import type { PlanGrantValue } from './entitlement-manifest-catalog'

// Pure entitlement evaluation (doc 11). Separate axis from RBAC: a shortfall means
// the ORGANIZATION hasn't purchased/activated the capacity, which is a DISTINCT
// outcome (and audit code) from a user permission denial.

export type EntitlementDecision =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: 'entitlement_shortfall' }

export type EntitlementInput = {
  enforcement: 'limit' | 'boolean'
  // The plan's grant for this entitlement: a numeric limit, null (unlimited, e.g.
  // the enterprise plan), or a boolean.
  grantValue: PlanGrantValue
  // Current usage for a limit-enforced entitlement (ignored for boolean).
  currentUsage: number
  // Units being consumed by this operation (default 1).
  increment?: number
}

/**
 * Judges whether the org may consume one more unit of an entitlement. null limit =
 * unlimited. A boolean entitlement is allowed only when granted true. Default-deny:
 * an unknown/missing grant is a shortfall.
 */
export function evaluateEntitlement(input: EntitlementInput): EntitlementDecision {
  if (input.enforcement === 'boolean') {
    return input.grantValue === true
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'entitlement_shortfall' }
  }
  // limit enforcement
  if (input.grantValue === null) {
    return { allowed: true, reason: 'allowed' }
  }
  if (typeof input.grantValue !== 'number') {
    return { allowed: false, reason: 'entitlement_shortfall' }
  }
  const projected = input.currentUsage + (input.increment ?? 1)
  return projected <= input.grantValue
    ? { allowed: true, reason: 'allowed' }
    : { allowed: false, reason: 'entitlement_shortfall' }
}
