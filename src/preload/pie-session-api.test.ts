import { describe, expect, it, vi } from 'vitest'
import {
  PIE_SESSION_CHANGED_CHANNEL,
  PIE_SESSION_GET_STATE_CHANNEL
} from '../shared/pie-session-contract'
import { createPieSessionPreloadApi } from './pie-session-api'

function createIpc(response: unknown) {
  const listeners = new Set<(event: unknown, input: unknown) => void>()
  return {
    invoke: vi.fn(async () => response),
    on: vi.fn((_channel: string, listener: (event: unknown, input: unknown) => void) => {
      listeners.add(listener)
    }),
    removeListener: vi.fn(
      (_channel: string, listener: (event: unknown, input: unknown) => void) => {
        listeners.delete(listener)
      }
    ),
    emit: (input: unknown): void => {
      listeners.forEach((listener) => listener({}, input))
    }
  }
}

const requestId = '20000000-0000-4000-8000-000000000001'

describe('Pie session preload API', () => {
  it('constructs the private request envelope and returns only session state', async () => {
    const ipc = createIpc({
      requestId,
      protocolVersion: '1.0',
      ok: true,
      result: { status: 'signed_out', instanceId: 'local-desktop' }
    })
    const api = createPieSessionPreloadApi(ipc as never, () => requestId)

    await expect(api.getState()).resolves.toEqual({
      status: 'signed_out',
      instanceId: 'local-desktop'
    })
    expect(ipc.invoke).toHaveBeenCalledWith(PIE_SESSION_GET_STATE_CHANNEL, {
      requestId,
      method: 'session.getState',
      protocolVersion: '1.0',
      sessionContext: {
        instanceId: 'local-desktop',
        sessionId: null,
        organizationId: null
      },
      payload: {}
    })
  })

  it('rejects a response that leaks an authentication token', async () => {
    const ipc = createIpc({
      requestId,
      protocolVersion: '1.0',
      ok: true,
      result: {
        status: 'signed_out',
        instanceId: 'local-desktop',
        refreshToken: 'secret'
      }
    })
    const api = createPieSessionPreloadApi(ipc as never, () => requestId)
    await expect(api.getState()).rejects.toThrow()
  })

  it('validates events and unregisters its listener', () => {
    const ipc = createIpc({})
    const api = createPieSessionPreloadApi(ipc as never, () => requestId)
    const callback = vi.fn()
    const unsubscribe = api.onChanged(callback)

    ipc.emit({
      type: 'session.changed',
      protocolVersion: '1.0',
      sequence: 1,
      session: { status: 'signed_out', instanceId: 'local-desktop' }
    })
    ipc.emit({
      type: 'session.changed',
      protocolVersion: '1.0',
      sequence: 2,
      session: { status: 'signed_out', instanceId: 'local-desktop', accessToken: 'secret' }
    })

    expect(callback).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(
      PIE_SESSION_CHANGED_CHANNEL,
      expect.any(Function)
    )
  })
})
