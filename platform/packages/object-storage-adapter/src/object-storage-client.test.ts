import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createObjectStorage, type ObjectStorage } from './object-storage-client'
import { startObjectStorageHarness, type ObjectStorageHarness } from './object-storage-test-harness'

let harness: ObjectStorageHarness | null = null
let storage: ObjectStorage

beforeAll(async () => {
  try {
    harness = await startObjectStorageHarness()
  } catch (error) {
    console.warn(`SKIPPED object storage: Docker/S3 unavailable — ${String(error)}`)
    return
  }
  storage = createObjectStorage(harness)
  await storage.ensureBucket()
}, 180_000)

afterAll(async () => {
  await harness?.stop()
})

describe('object storage presign round-trip', () => {
  it('presigns a PUT, uploads via the URL, then HEADs the object', async (ctx) => {
    if (!harness) return ctx.skip()
    const key = 'org/00000000-0000-4000-8000-000000000000/artifacts/probe.txt'
    const body = 'hello pie object storage'
    const url = await storage.presignPut(key, { contentType: 'text/plain' })
    const put = await fetch(url, {
      method: 'PUT',
      body,
      headers: { 'content-type': 'text/plain' }
    })
    expect(put.ok).toBe(true)
    const head = await storage.head(key)
    expect(head.exists).toBe(true)
    if (head.exists) {
      expect(head.sizeBytes).toBe(Buffer.byteLength(body))
    }
    expect(new TextDecoder().decode(await storage.getObjectBytes(key))).toBe(body)
  })

  it('reports a missing object as not existing', async (ctx) => {
    if (!harness) return ctx.skip()
    const head = await storage.head('org/00000000-0000-4000-8000-000000000000/artifacts/absent')
    expect(head.exists).toBe(false)
  })
})
