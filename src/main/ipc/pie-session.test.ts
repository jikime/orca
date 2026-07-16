import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fromIdMock, handleMock, removeHandlerMock } = vi.hoisted(() => ({
  fromIdMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  },
  webContents: {
    fromId: fromIdMock
  }
}))

import {
  PIE_SESSION_CHANGED_CHANNEL,
  PIE_SESSION_GET_STATE_CHANNEL,
  PieSessionGetRequestSchema
} from '../../shared/pie-session-contract'
import { InMemoryDesktopSessionBroker } from '../pie-session/desktop-session-broker'
import { registerPieSessionHandlers } from './pie-session'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

function request() {
  return PieSessionGetRequestSchema.parse({
    requestId: '20000000-0000-4000-8000-000000000001',
    method: 'session.getState',
    protocolVersion: '1.0',
    sessionContext: {
      instanceId: 'local-desktop',
      sessionId: null,
      organizationId: null
    },
    payload: {}
  })
}

function invokeEvent(
  overrides: { id?: number; type?: string; destroyed?: boolean; subframe?: boolean } = {}
) {
  const mainFrame = { url: 'file:///app/index.html' }
  return {
    sender: {
      id: overrides.id ?? 17,
      getType: () => overrides.type ?? 'window',
      isDestroyed: () => overrides.destroyed ?? false,
      mainFrame
    },
    senderFrame: overrides.subframe ? { url: 'https://untrusted.example' } : mainFrame
  }
}

function registeredHandler(): (event: unknown, input: unknown) => unknown {
  const call = handleMock.mock.calls.find(([channel]) => channel === PIE_SESSION_GET_STATE_CHANNEL)
  if (!call) {
    throw new Error('Pie session handler was not registered')
  }
  return call[1]
}

describe('Pie session IPC', () => {
  let broker: InMemoryDesktopSessionBroker

  beforeEach(() => {
    fromIdMock.mockReset()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    setTrustedPieRendererWebContentsId(17)
    broker = new InMemoryDesktopSessionBroker()
    registerPieSessionHandlers(broker)
  })

  it('returns the signed-out state to the trusted main frame', () => {
    expect(registeredHandler()(invokeEvent(), request())).toEqual({
      requestId: '20000000-0000-4000-8000-000000000001',
      protocolVersion: '1.0',
      ok: true,
      result: { status: 'signed_out', instanceId: 'local-desktop' }
    })
  })

  it.each([
    ['stale window', { id: 18 }],
    ['webview', { type: 'webview' }],
    ['destroyed window', { destroyed: true }],
    ['subframe', { subframe: true }]
  ])('rejects a %s sender', (_label, overrides) => {
    expect(() => registeredHandler()(invokeEvent(overrides), request())).toThrow(
      'PIE_IPC_UNTRUSTED_SENDER'
    )
  })

  it('rejects unknown fields, protocol mismatch, and asserted session context', () => {
    expect(() => registeredHandler()(invokeEvent(), { ...request(), unexpected: true })).toThrow(
      'PIE_IPC_INVALID_REQUEST'
    )
    expect(() =>
      registeredHandler()(invokeEvent(), { ...request(), protocolVersion: '2.0' })
    ).toThrow('PIE_IPC_INVALID_REQUEST')
    expect(() =>
      registeredHandler()(invokeEvent(), {
        ...request(),
        sessionContext: {
          ...request().sessionContext,
          organizationId: '20000000-0000-4000-8000-000000000002'
        }
      })
    ).toThrow('PIE_IPC_SESSION_CONTEXT_MISMATCH')
  })

  it('publishes changes only to the current trusted renderer', () => {
    const send = vi.fn()
    fromIdMock.mockReturnValue({ isDestroyed: () => false, send })
    broker.replaceSession({
      session: {
        status: 'signed_in',
        instanceId: 'local-desktop',
        userId: '20000000-0000-4000-8000-000000000002',
        displayName: 'Pie User',
        organizationId: '20000000-0000-4000-8000-000000000003',
        permissions: ['project.read'],
        expiresAt: '2026-07-16T01:00:00.000Z'
      },
      sessionId: '20000000-0000-4000-8000-000000000004'
    })

    expect(fromIdMock).toHaveBeenCalledWith(17)
    expect(send).toHaveBeenCalledWith(
      PIE_SESSION_CHANGED_CHANNEL,
      expect.objectContaining({ sequence: 1 })
    )
  })
})
