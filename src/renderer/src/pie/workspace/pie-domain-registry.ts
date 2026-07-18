import { PIE_DELIVERY_DOMAINS } from './pie-delivery-domains'
import { PIE_OPS_DOMAINS } from './pie-ops-domains'

export type {
  PieActionSpec,
  PieColumnSpec,
  PieDomainConfig,
  PieFieldSpec,
  PieFieldType
} from './pie-domain-types'

// Every Pie desktop domain surface, in nav order: project-scoped delivery first,
// then org-scoped operations. One generic screen renders any entry.
export const PIE_DOMAINS = [...PIE_DELIVERY_DOMAINS, ...PIE_OPS_DOMAINS]
