import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// contracts/manifests/entitlements.json is the source of truth for the plan
// catalog (6 entitlements, plans personal/team/enterprise). Enforcement and plan
// grants derive from here; the DB tables are a seeded, drift-detectable copy.
const MANIFESTS_DIR = fileURLToPath(new URL('../../../../contracts/manifests', import.meta.url))

export type EntitlementDefinition = {
  id: string
  unit: string
  enforcement: 'limit' | 'boolean'
}

// A plan's grant for one entitlement: a numeric limit, null (unlimited), or a
// boolean (for boolean-enforced entitlements).
export type PlanGrantValue = number | boolean | null

export type PlanDefinition = {
  id: string
  deploymentTypes: string[]
  grants: Record<string, PlanGrantValue>
}

export type EntitlementManifestCatalog = {
  entitlements: EntitlementDefinition[]
  plans: PlanDefinition[]
  checksum: string
  enforcementOf: (entitlementId: string) => 'limit' | 'boolean' | null
  grantsForPlan: (planId: string) => Record<string, PlanGrantValue> | null
}

let cached: EntitlementManifestCatalog | null = null

export function loadEntitlementManifestCatalog(): EntitlementManifestCatalog {
  if (cached) {
    return cached
  }
  const raw = readFileSync(`${MANIFESTS_DIR}/entitlements.json`, 'utf-8')
  const doc = JSON.parse(raw) as { entitlements: EntitlementDefinition[]; plans: PlanDefinition[] }
  const checksum = createHash('sha256')
    .update(JSON.stringify({ entitlements: doc.entitlements, plans: doc.plans }))
    .digest('hex')
  const enforcementById = new Map(doc.entitlements.map((e) => [e.id, e.enforcement]))
  const grantsByPlan = new Map(doc.plans.map((p) => [p.id, p.grants]))
  cached = {
    entitlements: doc.entitlements,
    plans: doc.plans,
    checksum,
    enforcementOf: (entitlementId) => enforcementById.get(entitlementId) ?? null,
    grantsForPlan: (planId) => grantsByPlan.get(planId) ?? null
  }
  return cached
}
