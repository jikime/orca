import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const clientMocks = vi.hoisted(() => ({
  applyChannelRetention: vi.fn(),
  exportChannel: vi.fn(),
  listChannelAudit: vi.fn()
}))

vi.mock('../pie-chat/chat-channel-governance-client', () => clientMocks)

import {
  PIE_CHAT_APPLY_CHANNEL_RETENTION_CHANNEL,
  PIE_CHAT_EXPORT_CHANNEL_CHANNEL,
  PIE_CHAT_LIST_CHANNEL_AUDIT_CHANNEL
} from '../../shared/pie-chat-ipc-channels'
import { registerPieChatGovernanceHandlers } from './pie-chat-governance'
import type { PieChatHandlerDeps } from './pie-chat-ipc-shared'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'

function trustedEvent(): unknown {
  const mainFrame = { url: 'file:///app/index.html' }
  return {
    sender: { id: 42, getType: () => 'window', isDestroyed: () => false, mainFrame },
    senderFrame: mainFrame
  }
}

function handlerFor(channel: string): (event: unknown, input: unknown) => unknown {
  const call = handleMock.mock.calls.find(([name]) => name === channel)
  if (!call) {
    throw new Error(`handler not registered for ${channel}`)
  }
  return call[1]
}

describe('Pie chat governance IPC', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    Object.values(clientMocks).forEach((mock) => mock.mockReset())
    setTrustedPieRendererWebContentsId(42)
    const deps: PieChatHandlerDeps = {
      getApiBaseUrl: () => 'https://cp.example/v1',
      getAccessToken: () => 'token-123',
      getOrganizationId: () => ORG
    }
    registerPieChatGovernanceHandlers(deps)
  })

  it('routes audit, export, and retention through Main-owned authentication', async () => {
    clientMocks.listChannelAudit.mockResolvedValue([])
    clientMocks.exportChannel.mockResolvedValue({})
    clientMocks.applyChannelRetention.mockResolvedValue(0)
    const input = { channelId: CHANNEL }
    await handlerFor(PIE_CHAT_LIST_CHANNEL_AUDIT_CHANNEL)(trustedEvent(), input)
    await handlerFor(PIE_CHAT_EXPORT_CHANNEL_CHANNEL)(trustedEvent(), input)
    await handlerFor(PIE_CHAT_APPLY_CHANNEL_RETENTION_CHANNEL)(trustedEvent(), input)

    for (const mock of [clientMocks.listChannelAudit, clientMocks.exportChannel]) {
      expect(mock).toHaveBeenCalledWith(
        'https://cp.example/v1',
        'token-123',
        ORG,
        CHANNEL,
        expect.any(Function)
      )
    }
    expect(clientMocks.applyChannelRetention).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      { idempotencyKey: expect.any(String) },
      expect.any(Function)
    )
  })

  it('rejects malformed channel ids before calling the client', () => {
    expect(() =>
      handlerFor(PIE_CHAT_EXPORT_CHANNEL_CHANNEL)(trustedEvent(), { channelId: 'bad' })
    ).toThrow('PIE_CHAT_INVALID_REQUEST')
    expect(clientMocks.exportChannel).not.toHaveBeenCalled()
  })
})
