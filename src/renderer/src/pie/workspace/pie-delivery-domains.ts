import type { PieDomainConfig } from './pie-domain-types'
import { buildPieDeliveryPlanningDomains } from './pie-delivery-planning-domains'
import { buildPieDeliveryQualityDomains } from './pie-delivery-quality-domains'
import { buildPieDeliveryGovernanceDomains } from './pie-delivery-governance-domains'

// Project-scoped delivery/governance surfaces in nav order. Built lazily so
// translate() runs at render time (top-level translate() is disallowed) and
// re-resolves on locale switch. Split by area to stay under the file-size cap.
export function buildPieDeliveryDomains(): readonly PieDomainConfig[] {
  return [
    ...buildPieDeliveryPlanningDomains(),
    ...buildPieDeliveryQualityDomains(),
    ...buildPieDeliveryGovernanceDomains()
  ]
}
