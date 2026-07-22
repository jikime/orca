import { describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createContractSchemaRegistry } from './contract-schema-registry'
import { loadDiscoveryConfig } from './discovery-config'

describe('instance discovery', () => {
  it('uses the desktop broker instance ID for local development', () => {
    expect(loadDiscoveryConfig({}).instanceId).toBe('local-desktop')
  })

  it('serves a contract-valid discovery document with honest values', async () => {
    const app = buildApp({ ping: async () => true, registry: createContractSchemaRegistry() })
    const response = await app.inject({ method: 'GET', url: '/.well-known/pie' })
    // A 200 means the served doc passed its own contract schema (the route 500s
    // otherwise).
    expect(response.statusCode).toBe(200)
    const doc = response.json()
    expect(doc.schemaVersion).toBe(1)
    expect(doc.protocol).toEqual({ api: '1.0', realtime: '1.0' })
    expect(doc.minimumClientVersion).toBe('0.1.0')
    // Implemented features true; unimplemented reported honestly false.
    expect(doc.capabilities.artifactUpload).toBe(true)
    expect(doc.capabilities.resourceChanges).toBe(true)
    expect(doc.capabilities.videoMeeting).toBe(false)
  })

  it('advertises meeting media only when LiveKit is configured', async () => {
    const app = buildApp({
      ping: async () => true,
      registry: createContractSchemaRegistry(),
      discoveryConfig: loadDiscoveryConfig({
        PIE_LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
        PIE_LIVEKIT_API_KEY: 'test-key',
        PIE_LIVEKIT_API_SECRET: 'test-secret'
      })
    })
    const response = await app.inject({ method: 'GET', url: '/.well-known/pie' })
    expect(response.statusCode).toBe(200)
    expect(response.json().mediaUrl).toBe('http://127.0.0.1:7880')
    expect(response.json().capabilities.videoMeeting).toBe(true)
  })
})
