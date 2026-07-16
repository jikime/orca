import { randomUUID } from 'node:crypto'

// Isolation zones (ADR-0006): objects of different purposes live under distinct
// key-prefix zones so lifecycle/retention/policy can differ per zone and one zone
// can never address another's objects.
export const OBJECT_STORAGE_ZONES = ['artifacts', 'transcripts', 'attachments'] as const
export type ObjectStorageZone = (typeof OBJECT_STORAGE_ZONES)[number]

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type NewObjectKey = {
  objectId: string
  storageKey: string
}

/**
 * A key builder BOUND to one organization. Every key it produces is namespaced by
 * that org (ADR-0006 §3), and there is NO method to build a key for another org —
 * so cross-tenant key access is structurally impossible through this API.
 */
export type TenantObjectKeyBuilder = {
  readonly organizationId: string
  newKey: (zone: ObjectStorageZone) => NewObjectKey
  keyForObject: (zone: ObjectStorageZone, objectId: string) => string
}

export function createTenantObjectKeyBuilder(organizationId: string): TenantObjectKeyBuilder {
  if (!UUID_PATTERN.test(organizationId)) {
    throw new Error('createTenantObjectKeyBuilder requires a UUID organizationId')
  }
  const zonePrefix = (zone: ObjectStorageZone): string => `org/${organizationId}/${zone}`
  return {
    organizationId,
    newKey: (zone) => {
      const objectId = randomUUID()
      return { objectId, storageKey: `${zonePrefix(zone)}/${objectId}` }
    },
    keyForObject: (zone, objectId) => {
      if (!UUID_PATTERN.test(objectId)) {
        throw new Error('keyForObject requires a UUID objectId')
      }
      return `${zonePrefix(zone)}/${objectId}`
    }
  }
}

/** Extracts the owning org from a storage key so access paths can assert that the
 *  key belongs to the caller's tenant before touching the object. */
export function organizationIdFromStorageKey(storageKey: string): string | null {
  const match = /^org\/([0-9a-f-]{36})\//i.exec(storageKey)
  return match ? match[1]! : null
}
