import { buildPieDeliveryDomains } from './pie-delivery-domains'
import { buildPieOpsDomains } from './pie-ops-domains'

export type {
  PieActionSpec,
  PieColumnSpec,
  PieDomainConfig,
  PieFieldSpec,
  PieFieldType
} from './pie-domain-types'

// Every Pie desktop domain surface, in nav order: project-scoped delivery first,
// then org-scoped operations. One generic screen renders any entry. Built lazily
// so localized labels resolve at render time.
export function buildPieDomains() {
  return [...buildPieDeliveryDomains(), ...buildPieOpsDomains()]
}
