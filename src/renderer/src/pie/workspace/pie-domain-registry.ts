import { buildPiePortalPlanningDomains } from './pie-portal-planning-domains'
import { buildPiePortalQualityDomains } from './pie-portal-quality-domains'
import { buildPiePortalGovernanceDomains } from './pie-portal-governance-domains'
import { buildPieCustomerDomains } from './pie-customer-domains'
import { buildPieSupportDomains } from './pie-support-domains'
import { buildPieCommunicationDomains } from './pie-communication-domains'
import { buildPieAdminDomains } from './pie-admin-domains'
import type { PieDomainConfig } from './pie-domain-types'

export type {
  PieActionSpec,
  PieColumnSpec,
  PieDomainConfig,
  PieFieldSpec,
  PieFieldType
} from './pie-domain-types'

// Work Portal groups the project-execution surfaces (delivery, quality, governance).
export function buildPiePortalDomains(): readonly PieDomainConfig[] {
  return [
    ...buildPiePortalPlanningDomains(),
    ...buildPiePortalQualityDomains(),
    ...buildPiePortalGovernanceDomains()
  ]
}

export {
  buildPieCustomerDomains,
  buildPieSupportDomains,
  buildPieCommunicationDomains,
  buildPieAdminDomains
}
