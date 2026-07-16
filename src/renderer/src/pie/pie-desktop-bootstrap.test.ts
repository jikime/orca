import { describe, expect, it, vi } from 'vitest'
import { bootstrapPieDesktopBoundary } from './pie-desktop-bootstrap'

const session = { status: 'signed_out' as const, instanceId: 'local-desktop' }
const runtime = {
  type: 'runtime.welcome' as const,
  requestId: '30000000-0000-4000-8000-000000000001',
  protocolVersion: '1.0' as const,
  runtimeId: '30000000-0000-4000-8000-000000000003',
  runtimeVersion: '1.4.142-rc.3',
  host: {
    hostId: '30000000-0000-4000-8000-000000000004',
    type: 'native' as const,
    platform: 'darwin' as const,
    pathStyle: 'posix' as const,
    caseSensitivePaths: false
  },
  sqliteVersion: '3.50.4',
  git: { baseline: '2.25' as const, version: null, capabilities: [] },
  providerParsers: {},
  capabilities: ['runtime.handshake_v1'],
  limits: {
    maxRequestBytes: 1_048_576,
    maxFrameBytes: 262_144,
    maxConcurrentStreams: 16
  }
}

describe('bootstrapPieDesktopBoundary', () => {
  it('reads the session and Runtime handshake as one startup boundary', async () => {
    const getState = vi.fn(async () => session)
    const getHandshake = vi.fn(async () => runtime)

    await expect(
      bootstrapPieDesktopBoundary({
        session: { getState, onChanged: vi.fn() },
        runtime: { getHandshake }
      })
    ).resolves.toEqual({ runtime, session })
    expect(getState).toHaveBeenCalledOnce()
    expect(getHandshake).toHaveBeenCalledOnce()
  })

  it('fails the probe when either privileged boundary fails', async () => {
    await expect(
      bootstrapPieDesktopBoundary({
        session: {
          getState: vi.fn(async () => {
            throw new Error('PIE_IPC_UNTRUSTED_SENDER')
          }),
          onChanged: vi.fn()
        },
        runtime: { getHandshake: vi.fn(async () => runtime) }
      })
    ).rejects.toThrow('PIE_IPC_UNTRUSTED_SENDER')
  })
})
