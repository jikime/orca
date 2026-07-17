import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const clientMocks = vi.hoisted(() => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  listPins: vi.fn()
}))

vi.mock('../pie-chat/chat-message-actions-client', () => clientMocks)

import {
  PIE_CHAT_ADD_REACTION_CHANNEL,
  PIE_CHAT_LIST_PINS_CHANNEL,
  PIE_CHAT_UNPIN_MESSAGE_CHANNEL
} from '../../shared/pie-chat-contract'
import { registerPieChatActionHandlers } from './pie-chat-actions'
import type { PieChatHandlerDeps } from './pie-chat-ipc-shared'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '20000000-0000-4000-8000-000000000003'

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

describe('Pie chat action IPC', () => {
  let deps: PieChatHandlerDeps

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    Object.values(clientMocks).forEach((mock) => mock.mockReset())
    setTrustedPieRendererWebContentsId(42)
    deps = {
      getApiBaseUrl: () => 'https://cp.example/v1',
      getAccessToken: () => 'token-123',
      getOrganizationId: () => ORG
    }
    registerPieChatActionHandlers(deps)
  })

  it('delegates a reaction with resolved auth and a fresh Idempotency-Key', async () => {
    clientMocks.addReaction.mockResolvedValue({})
    await handlerFor(PIE_CHAT_ADD_REACTION_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      messageId: MESSAGE,
      emoji: '👍'
    })

    const args = clientMocks.addReaction.mock.calls[0]
    expect(args[0]).toBe('https://cp.example/v1')
    expect(args[1]).toBe('token-123')
    expect(args[2]).toBe(ORG)
    expect(args[3]).toBe(CHANNEL)
    expect(args[4]).toBe(MESSAGE)
    expect(args[5]).toEqual({ emoji: '👍', idempotencyKey: expect.any(String) })
    expect(args[5].idempotencyKey.length).toBeGreaterThan(0)
  })

  it('generates a distinct Idempotency-Key on each reaction call', async () => {
    clientMocks.addReaction.mockResolvedValue({})
    const handler = handlerFor(PIE_CHAT_ADD_REACTION_CHANNEL)
    await handler(trustedEvent(), { channelId: CHANNEL, messageId: MESSAGE, emoji: '👍' })
    await handler(trustedEvent(), { channelId: CHANNEL, messageId: MESSAGE, emoji: '👍' })
    const first = clientMocks.addReaction.mock.calls[0][5].idempotencyKey
    const second = clientMocks.addReaction.mock.calls[1][5].idempotencyKey
    expect(first).not.toBe(second)
  })

  it('delegates listPins with the resolved channel', async () => {
    clientMocks.listPins.mockResolvedValue([])
    await handlerFor(PIE_CHAT_LIST_PINS_CHANNEL)(trustedEvent(), { channelId: CHANNEL })
    expect(clientMocks.listPins).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      expect.any(Function)
    )
  })

  it('rejects an untrusted sender before touching the client', async () => {
    const untrusted = {
      sender: { id: 99, getType: () => 'window', isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    }
    await expect(
      handlerFor(PIE_CHAT_UNPIN_MESSAGE_CHANNEL)(untrusted, {
        channelId: CHANNEL,
        messageId: MESSAGE
      })
    ).rejects.toThrow('PIE_IPC_UNTRUSTED_SENDER')
    expect(clientMocks.unpinMessage).not.toHaveBeenCalled()
  })
})
