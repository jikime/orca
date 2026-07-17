import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const clientMocks = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  createAttachmentIntent: vi.fn(),
  uploadAttachment: vi.fn(),
  downloadAttachment: vi.fn()
}))

vi.mock('../pie-chat/chat-search-attachment-client', () => clientMocks)

import {
  PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL,
  PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL,
  PIE_CHAT_SEARCH_MESSAGES_CHANNEL
} from '../../shared/pie-chat-contract'
import { registerPieChatSearchAttachmentHandlers } from './pie-chat-search-attachments'
import type { PieChatHandlerDeps } from './pie-chat-ipc-shared'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const ATTACHMENT = '20000000-0000-4000-8000-000000000008'

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

describe('Pie chat search + attachment IPC', () => {
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
    registerPieChatSearchAttachmentHandlers(deps)
  })

  it('delegates a search with the resolved auth and query', async () => {
    clientMocks.searchMessages.mockResolvedValue({ items: [], nextCursor: null })
    await handlerFor(PIE_CHAT_SEARCH_MESSAGES_CHANNEL)(trustedEvent(), { query: 'hello' })
    const args = clientMocks.searchMessages.mock.calls[0]
    expect(args[0]).toBe('https://cp.example/v1')
    expect(args[1]).toBe('token-123')
    expect(args[2]).toBe(ORG)
    expect(args[3]).toEqual({ query: 'hello', cursor: undefined })
  })

  it('creates an attachment intent with a fresh Idempotency-Key', async () => {
    clientMocks.createAttachmentIntent.mockResolvedValue({
      id: ATTACHMENT,
      objectId: 'obj',
      uploadUrl: 'https://up',
      expiresAt: 'x'
    })
    await handlerFor(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      filename: 'a.png',
      contentType: 'image/png',
      byteSize: 10
    })
    const args = clientMocks.createAttachmentIntent.mock.calls[0]
    expect(args[3]).toBe(CHANNEL)
    expect(args[4]).toEqual({
      filename: 'a.png',
      contentType: 'image/png',
      byteSize: 10,
      idempotencyKey: expect.any(String)
    })
    // No bytes passed → the inline presigned PUT must not run.
    expect(clientMocks.uploadAttachment).not.toHaveBeenCalled()
  })

  it('PUTs the bytes to the presigned url when the renderer passes a buffer', async () => {
    clientMocks.createAttachmentIntent.mockResolvedValue({
      id: ATTACHMENT,
      objectId: 'obj',
      uploadUrl: 'https://storage.example/put',
      expiresAt: 'x'
    })
    clientMocks.uploadAttachment.mockResolvedValue(undefined)
    const file = new ArrayBuffer(8)
    await handlerFor(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      filename: 'a.png',
      contentType: 'image/png',
      byteSize: 8,
      file
    })
    expect(clientMocks.uploadAttachment).toHaveBeenCalledWith(
      'https://storage.example/put',
      file,
      'image/png',
      expect.any(Function)
    )
  })

  it('rejects a non-integer byteSize before touching the client', async () => {
    await expect(
      handlerFor(PIE_CHAT_CREATE_ATTACHMENT_INTENT_CHANNEL)(trustedEvent(), {
        channelId: CHANNEL,
        filename: 'a.png',
        contentType: 'image/png',
        byteSize: 1.5
      }) as Promise<unknown>
    ).rejects.toThrow('PIE_CHAT_INVALID_REQUEST')
    expect(clientMocks.createAttachmentIntent).not.toHaveBeenCalled()
  })

  it('rejects an untrusted sender before downloading', async () => {
    const untrusted = {
      sender: { id: 99, getType: () => 'window', isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    }
    expect(() =>
      handlerFor(PIE_CHAT_DOWNLOAD_ATTACHMENT_CHANNEL)(untrusted, {
        channelId: CHANNEL,
        attachmentId: ATTACHMENT
      })
    ).toThrow('PIE_IPC_UNTRUSTED_SENDER')
    expect(clientMocks.downloadAttachment).not.toHaveBeenCalled()
  })
})
