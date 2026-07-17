import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, fromIdMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  fromIdMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock },
  webContents: { fromId: fromIdMock }
}))

const clientMocks = vi.hoisted(() => ({
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  editMessage: vi.fn(),
  deleteMessage: vi.fn(),
  markRead: vi.fn()
}))

vi.mock('../pie-chat/chat-control-plane-client', () => clientMocks)

import {
  PIE_CHAT_LIST_CHANNELS_CHANNEL,
  PIE_CHAT_SEND_MESSAGE_CHANNEL
} from '../../shared/pie-chat-contract'
import { registerPieChatHandlers, type PieChatHandlerDeps } from './pie-chat'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'

function trustedEvent() {
  const mainFrame = { url: 'file:///app/index.html' }
  return {
    sender: {
      id: 42,
      getType: () => 'window',
      isDestroyed: () => false,
      mainFrame
    },
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

describe('Pie chat IPC', () => {
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
    registerPieChatHandlers(deps)
  })

  it('resolves apiBaseUrl, token, and org in Main and delegates to the client', async () => {
    clientMocks.listChannels.mockResolvedValue([])
    await handlerFor(PIE_CHAT_LIST_CHANNELS_CHANNEL)(trustedEvent(), undefined)

    expect(clientMocks.listChannels).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      expect.any(Function)
    )
  })

  it('generates a fresh Idempotency-Key per send by delegating with a key', async () => {
    clientMocks.sendMessage.mockResolvedValue({})
    await handlerFor(PIE_CHAT_SEND_MESSAGE_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      body: 'hi'
    })

    const args = clientMocks.sendMessage.mock.calls[0]
    expect(args[3]).toBe(CHANNEL)
    expect(args[4]).toEqual({ body: 'hi', idempotencyKey: expect.any(String) })
    expect(args[4].idempotencyKey.length).toBeGreaterThan(0)
  })

  it('rejects an untrusted sender before touching the client', () => {
    const untrusted = {
      sender: { id: 99, getType: () => 'window', isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    }
    expect(() => handlerFor(PIE_CHAT_LIST_CHANNELS_CHANNEL)(untrusted, undefined)).toThrow(
      'PIE_IPC_UNTRUSTED_SENDER'
    )
    expect(clientMocks.listChannels).not.toHaveBeenCalled()
  })

  it('throws when not authenticated', () => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    registerPieChatHandlers({ ...deps, getAccessToken: () => null })
    expect(() => handlerFor(PIE_CHAT_LIST_CHANNELS_CHANNEL)(trustedEvent(), undefined)).toThrow(
      'PIE_CHAT_NOT_AUTHENTICATED'
    )
  })

  it('rejects a non-uuid channel id', () => {
    expect(() =>
      handlerFor(PIE_CHAT_SEND_MESSAGE_CHANNEL)(trustedEvent(), { channelId: 'nope', body: 'x' })
    ).toThrow('PIE_CHAT_INVALID_REQUEST')
  })
})
