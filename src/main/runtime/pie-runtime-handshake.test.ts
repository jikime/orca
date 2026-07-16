import { describe, expect, it } from 'vitest'
import { PieRuntimeHandshakeEndpoint } from './pie-runtime-handshake'

const capability = 'synthetic-runtime-capability-not-a-real-credential'
const runtimeId = '30000000-0000-4000-8000-000000000003'
const hostId = '30000000-0000-4000-8000-000000000004'
const sessionContext = {
  instanceId: 'local-desktop',
  sessionId: null,
  organizationId: null
}

function endpoint(platform: NodeJS.Platform = 'darwin') {
  return new PieRuntimeHandshakeEndpoint({
    runtime: { getRuntimeId: () => runtimeId },
    runtimeVersion: '1.4.142-rc.3',
    getSessionContext: () => sessionContext,
    capability,
    hostId,
    sqliteVersion: '3.50.4',
    platform
  })
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: 'runtime.handshake',
    requestId: '30000000-0000-4000-8000-000000000001',
    mainVersion: '1.4.142-rc.3',
    supportedProtocolVersions: ['1.0'],
    sessionContext,
    capability,
    ...overrides
  }
}

describe('PieRuntimeHandshakeEndpoint', () => {
  it('negotiates protocol and bounded capabilities without returning the secret', () => {
    const response = endpoint().negotiate(request())
    expect(response).toEqual({
      type: 'runtime.welcome',
      requestId: '30000000-0000-4000-8000-000000000001',
      protocolVersion: '1.0',
      runtimeId,
      runtimeVersion: '1.4.142-rc.3',
      host: {
        hostId,
        type: 'native',
        platform: 'darwin',
        pathStyle: 'posix',
        caseSensitivePaths: false
      },
      sqliteVersion: '3.50.4',
      git: { baseline: '2.25', version: null, capabilities: [] },
      providerParsers: {},
      capabilities: ['runtime.handshake_v1', 'runtime.bounded_streams'],
      limits: {
        maxRequestBytes: 1_048_576,
        maxFrameBytes: 262_144,
        maxConcurrentStreams: 16
      }
    })
    expect(JSON.stringify(response)).not.toContain(capability)
  })

  it('reports Windows path semantics for a native Windows host', () => {
    expect(endpoint('win32').negotiate(request()).host).toEqual(
      expect.objectContaining({ platform: 'win32', pathStyle: 'windows' })
    )
  })

  it('rejects wrong capabilities, contexts, protocols, and unknown fields', () => {
    expect(() =>
      endpoint().negotiate(
        request({ capability: 'different-runtime-capability-not-a-real-credential' })
      )
    ).toThrow('PIE_RUNTIME_CAPABILITY_DENIED')
    expect(() =>
      endpoint().negotiate(
        request({ sessionContext: { ...sessionContext, instanceId: 'other-instance' } })
      )
    ).toThrow('PIE_RUNTIME_SESSION_CONTEXT_MISMATCH')
    expect(() => endpoint().negotiate(request({ supportedProtocolVersions: ['2.0'] }))).toThrow(
      'PIE_RUNTIME_PROTOCOL_UNSUPPORTED'
    )
    expect(() => endpoint().negotiate({ ...request(), unexpected: true })).toThrow(
      'PIE_RUNTIME_INVALID_HANDSHAKE'
    )
  })
})
