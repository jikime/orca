import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const clientMocks = vi.hoisted(() => ({
  addChannelMember: vi.fn(),
  createChannel: vi.fn(),
  createDm: vi.fn(),
  createGroupDm: vi.fn(),
  listChannelMembers: vi.fn(),
  muteChannel: vi.fn(),
  removeChannelMember: vi.fn(),
  unmuteChannel: vi.fn(),
  updateChannel: vi.fn(),
  listMembers: vi.fn()
}))

vi.mock('../pie-chat/chat-channel-admin-client', () => clientMocks)

import {
  PIE_CHAT_ADD_CHANNEL_MEMBER_CHANNEL,
  PIE_CHAT_CREATE_CHANNEL_CHANNEL,
  PIE_CHAT_CREATE_DM_CHANNEL,
  PIE_CHAT_LIST_CHANNEL_MEMBERS_CHANNEL,
  PIE_CHAT_LIST_MEMBERS_CHANNEL,
  PIE_CHAT_REMOVE_CHANNEL_MEMBER_CHANNEL,
  PIE_CHAT_UPDATE_CHANNEL_CHANNEL
} from '../../shared/pie-chat-contract'
import { registerPieChatAdminHandlers } from './pie-chat-admin'
import type { PieChatHandlerDeps } from './pie-chat-ipc-shared'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const OTHER = '20000000-0000-4000-8000-000000000005'
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

describe('Pie chat admin IPC', () => {
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
    registerPieChatAdminHandlers(deps)
  })

  it('creates a channel with resolved auth and a fresh Idempotency-Key', async () => {
    clientMocks.createChannel.mockResolvedValue({})
    await handlerFor(PIE_CHAT_CREATE_CHANNEL_CHANNEL)(trustedEvent(), { name: 'general' })
    const args = clientMocks.createChannel.mock.calls[0]
    expect(args[0]).toBe('https://cp.example/v1')
    expect(args[1]).toBe('token-123')
    expect(args[2]).toBe(ORG)
    expect(args[3]).toEqual({
      name: 'general',
      visibility: undefined,
      idempotencyKey: expect.any(String)
    })
    expect(args[3].idempotencyKey.length).toBeGreaterThan(0)
  })

  it('creates a DM by delegating the other user id', async () => {
    clientMocks.createDm.mockResolvedValue({})
    await handlerFor(PIE_CHAT_CREATE_DM_CHANNEL)(trustedEvent(), { otherUserId: OTHER })
    expect(clientMocks.createDm).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      OTHER,
      expect.any(Function)
    )
  })

  it('rejects a non-uuid DM target before touching the client', () => {
    expect(() =>
      handlerFor(PIE_CHAT_CREATE_DM_CHANNEL)(trustedEvent(), { otherUserId: 'nope' })
    ).toThrow('PIE_CHAT_INVALID_REQUEST')
    expect(clientMocks.createDm).not.toHaveBeenCalled()
  })

  it('adds a member using trusted ids and Main-owned auth', async () => {
    clientMocks.addChannelMember.mockResolvedValue(undefined)
    await handlerFor(PIE_CHAT_ADD_CHANNEL_MEMBER_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      userId: OTHER
    })

    expect(clientMocks.addChannelMember).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      OTHER,
      expect.any(Function)
    )
  })

  it('updates channel details with a validated version and a fresh idempotency key', async () => {
    clientMocks.updateChannel.mockResolvedValue({})
    await handlerFor(PIE_CHAT_UPDATE_CHANNEL_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      update: { topic: 'Launch' },
      expectedVersion: 3
    })
    expect(clientMocks.updateChannel).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      { update: { topic: 'Launch' }, expectedVersion: 3, idempotencyKey: expect.any(String) },
      expect.any(Function)
    )
  })

  it('lists and removes channel members through Main-owned auth', async () => {
    clientMocks.listChannelMembers.mockResolvedValue([])
    await handlerFor(PIE_CHAT_LIST_CHANNEL_MEMBERS_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL
    })
    await handlerFor(PIE_CHAT_REMOVE_CHANNEL_MEMBER_CHANNEL)(trustedEvent(), {
      channelId: CHANNEL,
      userId: OTHER
    })
    expect(clientMocks.listChannelMembers).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      expect.any(Function)
    )
    expect(clientMocks.removeChannelMember).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      CHANNEL,
      OTHER,
      expect.any(String),
      expect.any(Function)
    )
  })

  it('rejects an untrusted sender before listing members', () => {
    const untrusted = {
      sender: { id: 99, getType: () => 'window', isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    }
    expect(() => handlerFor(PIE_CHAT_LIST_MEMBERS_CHANNEL)(untrusted, undefined)).toThrow(
      'PIE_IPC_UNTRUSTED_SENDER'
    )
    expect(clientMocks.listMembers).not.toHaveBeenCalled()
  })
})
