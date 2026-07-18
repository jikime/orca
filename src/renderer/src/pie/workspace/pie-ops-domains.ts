import type { PieDomainConfig } from './pie-domain-types'
import { buildPieOpsKnowledgeDomains } from './pie-ops-knowledge-domains'
import { buildPieOpsBillingDomains } from './pie-ops-billing-domains'

// Org-scoped operations surfaces in nav order (no project selector). Built lazily
// so translate() runs at render time and re-resolves on locale switch. Split by
// area to stay under the file-size cap.
export function buildPieOpsDomains(): readonly PieDomainConfig[] {
  return [...buildPieOpsKnowledgeDomains(), ...buildPieOpsBillingDomains()]
}
