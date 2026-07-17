// R5 slice 5a: the deterministic per-scope VISIBILITY + classification REDACTION core (doc 19
// :327, doc 24 CAP-002). Two orthogonal controls decide what a read may return:
//   • visibility  → whether a record is PRESENT at all for the requested scope (absence, not
//     redaction). The containment is internal ⊃ project ⊃ customer: an `internal`-visibility
//     record is the most sensitive (Pie-internal prompts / restricted tool output), a `customer`
//     record is the widest (external evidence). A reader at scope S sees a record iff the record's
//     audience is at least as wide as S.
//   • classification → whether a PRESENT record's payload/preview is REDACTED before it leaves the
//     API (server-side, on the read projection — never by mutating the append-only event).
// Both default-deny: an unrecognized visibility is treated as the most restrictive (`internal`)
// and an unrecognized classification as the most sensitive (`restricted`), so a malformed or
// legacy value can never widen exposure.

export type VisibilityScope = 'internal' | 'project' | 'customer'
export type SensitivityClassification =
  | 'public'
  | 'internal'
  | 'project_confidential'
  | 'restricted'

export const REDACTED_PLACEHOLDER = '‹redacted›'

// Privilege rank: a higher rank sees strictly more. internal(2) ⊃ project(1) ⊃ customer(0).
const SCOPE_RANK: Record<VisibilityScope, number> = { customer: 0, project: 1, internal: 2 }

/** Default-deny: an unknown visibility becomes the most restrictive audience (`internal`). */
export function normalizeVisibility(raw: string): VisibilityScope {
  return raw === 'internal' || raw === 'project' || raw === 'customer' ? raw : 'internal'
}

/** Default-deny: an unknown scope request becomes the most restrictive audience (`customer`). */
export function normalizeScope(raw: string | null | undefined): VisibilityScope | null {
  if (raw === undefined || raw === null) {
    return null
  }
  return raw === 'internal' || raw === 'project' || raw === 'customer' ? raw : 'customer'
}

/** Default-deny: an unknown classification becomes the most sensitive tier (`restricted`). */
export function normalizeClassification(raw: string): SensitivityClassification {
  return raw === 'public' || raw === 'internal' || raw === 'project_confidential'
    ? raw
    : 'restricted'
}

/** The narrower (less privileged) of two scopes — used to clamp a requested scope to the
 *  caller's maximum so a request can only ever NARROW what is returned, never widen it. */
export function narrowerScope(a: VisibilityScope, b: VisibilityScope): VisibilityScope {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b
}

/** True when a record of `visibility` is present for a reader at `scope` (record audience wide
 *  enough). A customer-scoped reader sees only `customer` records; an internal-scoped reader sees
 *  everything. */
export function visibleAtScope(visibility: VisibilityScope, scope: VisibilityScope): boolean {
  return SCOPE_RANK[visibility] <= SCOPE_RANK[scope]
}

/** The set of record visibilities a reader at `scope` may see — the IN-list for a SQL filter so
 *  above-scope rows are absent (never fetched), not merely hidden in the projection. */
export function allowedVisibilitiesForScope(scope: VisibilityScope): VisibilityScope[] {
  return (['internal', 'project', 'customer'] as const).filter((v) => visibleAtScope(v, scope))
}

/**
 * Whether a present record's payload must be redacted before it leaves the API. `restricted`
 * (secret) is ALWAYS redacted on read — the raw stays only in the append-only event, never in an
 * Evidence/search projection (CAP-002 defense-in-depth). `internal` / `project_confidential` are
 * redacted only when surfaced to the widest `customer` scope. `public` is never redacted.
 */
export function requiresRedaction(
  classification: SensitivityClassification,
  scope: VisibilityScope
): boolean {
  if (classification === 'restricted') {
    return true
  }
  if (classification === 'internal' || classification === 'project_confidential') {
    return scope === 'customer'
  }
  return false
}

/**
 * The redacted-on-read preview for a stored payload. Deterministic: a redacted record yields the
 * placeholder with NO derived snippet, so restricted/above-scope content never leaks through a
 * preview or a search snippet. A visible record yields a bounded, single-line text preview.
 */
export function payloadPreview(
  payload: unknown,
  classification: SensitivityClassification,
  scope: VisibilityScope,
  maxLength = 280
): { preview: string; redacted: boolean } {
  if (requiresRedaction(classification, scope)) {
    return { preview: REDACTED_PLACEHOLDER, redacted: true }
  }
  const text = payload === null || payload === undefined ? '' : JSON.stringify(payload)
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return {
    preview: collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed,
    redacted: false
  }
}
