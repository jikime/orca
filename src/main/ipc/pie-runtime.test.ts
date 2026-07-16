import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getVersionMock, handleMock, removeHandlerMock } = vi.hoisted(() => ({
  getVersionMock: vi.fn(() => '1.4.142-rc.3'),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: getVersionMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import { PIE_RUNTIME_GET_HANDSHAKE_CHANNEL } from '../../shared/pie-runtime-handshake-contract'
import { InMemoryDesktopSessionBroker } from '../pie-session/desktop-session-broker'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'
import { registerPieRuntimeHandlers } from './pie-runtime'

function invokeEvent(id = 17) {
  const mainFrame = { url: 'file:///app/index.html' }
  return {
    sender: {
      id,
      getType: () => 'window',
      isDestroyed: () => false,
      mainFrame
    },
    senderFrame: mainFrame
  }
}

function registeredHandler(): (event: unknown, input?: unknown) => unknown {
  const call = handleMock.mock.calls.find(
    ([channel]) => channel === PIE_RUNTIME_GET_HANDSHAKE_CHANNEL
  )
  if (!call) {
    throw new Error('Pie runtime handler was not registered')
  }
  return call[1]
}

describe('Pie runtime IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    setTrustedPieRendererWebContentsId(17)
    registerPieRuntimeHandlers(
      { getRuntimeId: () => '30000000-0000-4000-8000-000000000003' },
      new InMemoryDesktopSessionBroker()
    )
  })

  it('performs the internal handshake for the trusted renderer', () => {
    expect(registeredHandler()(invokeEvent())).toEqual(
      expect.objectContaining({
        type: 'runtime.welcome',
        protocolVersion: '1.0',
        runtimeId: '30000000-0000-4000-8000-000000000003',
        capabilities: ['runtime.handshake_v1', 'runtime.bounded_streams']
      })
    )
  })

  it('rejects stale renderers and renderer-supplied handshake payloads', () => {
    expect(() => registeredHandler()(invokeEvent(18))).toThrow('PIE_IPC_UNTRUSTED_SENDER')
    expect(() => registeredHandler()(invokeEvent(), { capability: 'renderer-secret' })).toThrow(
      'PIE_IPC_INVALID_REQUEST'
    )
  })
})
