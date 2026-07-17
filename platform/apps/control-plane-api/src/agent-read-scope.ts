import {
  authorizeSubjectForOrg,
  narrowerScope,
  normalizeScope,
  type PieDatabase,
  type VisibilityScope
} from '@pie/persistence'
import type { VerifiedPrincipal } from './keycloak-token-verifier'

// R5 slice 5a: resolve the VISIBILITY SCOPE a principal may read a session/evidence at (doc 19
// :327, doc 24 CAP-002). The base `agent_session.read` gate is checked by the caller; this layers
// the scope on top. The elevated `agent_turn.read_raw` permission is the signal that a principal
// may see Pie-internal content — without it a reader is capped at `project` and can never see
// `internal` turns or tool output. A `scope` query param can only ever NARROW the view (clamp to
// the caller's maximum), never widen it, so requesting `scope=internal` without read_raw still
// yields `project`.

/**
 * The effective read scope = the narrower of the caller's maximum scope (internal if they hold
 * agent_turn.read_raw, else project) and any requested `scope` param. This is a scope determination
 * only — it never records a denial or sends a response.
 */
export async function resolveReadScope(
  db: PieDatabase,
  principal: VerifiedPrincipal,
  organizationId: string,
  requestedScope: string | undefined
): Promise<VisibilityScope> {
  const { decision } = await authorizeSubjectForOrg(
    db,
    { issuer: principal.issuer, subject: principal.subject },
    organizationId,
    'agent_turn.read_raw'
  )
  const maxScope: VisibilityScope = decision.allowed ? 'internal' : 'project'
  const requested = normalizeScope(requestedScope)
  return requested ? narrowerScope(requested, maxScope) : maxScope
}
