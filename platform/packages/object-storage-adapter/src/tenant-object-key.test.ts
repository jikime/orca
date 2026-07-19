import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTenantObjectKeyBuilder, organizationIdFromStorageKey } from './tenant-object-key'

describe('tenant object key builder', () => {
  it('namespaces every key by the bound organization', () => {
    const orgId = randomUUID()
    const builder = createTenantObjectKeyBuilder(orgId)
    const { storageKey } = builder.newKey('artifacts')
    expect(storageKey.startsWith(`org/${orgId}/artifacts/`)).toBe(true)
    expect(organizationIdFromStorageKey(storageKey)).toBe(orgId)
  })

  it('cannot produce a key in another tenant’s namespace', () => {
    const orgA = randomUUID()
    const orgB = randomUUID()
    const builderA = createTenantObjectKeyBuilder(orgA)
    // There is no API to target another org; every key stays under orgA.
    for (const zone of ['artifacts', 'transcripts', 'attachments', 'recordings'] as const) {
      const { storageKey } = builderA.newKey(zone)
      expect(storageKey.startsWith(`org/${orgA}/`)).toBe(true)
      expect(storageKey.startsWith(`org/${orgB}/`)).toBe(false)
    }
    // keyForObject is likewise bound to orgA.
    const objectId = randomUUID()
    expect(builderA.keyForObject('artifacts', objectId)).toBe(`org/${orgA}/artifacts/${objectId}`)
  })

  it('separates zones so one zone cannot address another', () => {
    const orgId = randomUUID()
    const builder = createTenantObjectKeyBuilder(orgId)
    const objectId = randomUUID()
    expect(builder.keyForObject('artifacts', objectId)).toContain('/artifacts/')
    expect(builder.keyForObject('transcripts', objectId)).toContain('/transcripts/')
    expect(builder.keyForObject('artifacts', objectId)).not.toContain('/transcripts/')
    expect(builder.keyForObject('recordings', objectId)).toContain('/recordings/')
  })

  it('rejects a non-UUID organization', () => {
    expect(() => createTenantObjectKeyBuilder('../escape')).toThrow()
  })
})
