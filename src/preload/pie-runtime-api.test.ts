import { describe, expect, it, vi } from 'vitest'
import { PIE_RUNTIME_GET_HANDSHAKE_CHANNEL } from '../shared/pie-runtime-handshake-contract'
import { createPieRuntimePreloadApi } from './pie-runtime-api'

const validResponse = {
  type: 'runtime.welcome',
  requestId: '30000000-0000-4000-8000-000000000001',
  protocolVersion: '1.0',
  runtimeId: '30000000-0000-4000-8000-000000000003',
  runtimeVersion: '1.4.142-rc.3',
  host: {
    hostId: '30000000-0000-4000-8000-000000000004',
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
}

describe('Pie runtime preload API', () => {
  it('returns a validated handshake without accepting renderer input', async () => {
    const ipc = { invoke: vi.fn(async () => validResponse) }
    const api = createPieRuntimePreloadApi(ipc as never)
    await expect(api.getHandshake()).resolves.toEqual(validResponse)
    expect(ipc.invoke).toHaveBeenCalledWith(PIE_RUNTIME_GET_HANDSHAKE_CHANNEL)
  })

  it('rejects an invalid Runtime response', async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ ...validResponse, protocolVersion: '2.0' }))
    }
    const api = createPieRuntimePreloadApi(ipc as never)
    await expect(api.getHandshake()).rejects.toThrow()
  })
})
