import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const clientMocks = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn()
}))

vi.mock('../pie-chat/chat-notification-client', () => clientMocks)

import {
  PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL,
  PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL,
  PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL
} from '../../shared/pie-chat-contract'
import { registerPieChatNotificationHandlers } from './pie-chat-notifications'
import type { PieChatHandlerDeps } from './pie-chat-ipc-shared'
import { setTrustedPieRendererWebContentsId } from './pie-renderer-trust'

const ORG = '20000000-0000-4000-8000-000000000001'
const NOTIF = '20000000-0000-4000-8000-0000000000c1'

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

describe('Pie chat notification IPC', () => {
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
    registerPieChatNotificationHandlers(deps)
  })

  it('lists notifications with resolved auth', async () => {
    clientMocks.listNotifications.mockResolvedValue({ items: [], nextCursor: null })
    await handlerFor(PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL)(trustedEvent(), undefined)
    expect(clientMocks.listNotifications).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      expect.any(Function)
    )
  })

  it('marks one notification read by delegating the id', async () => {
    clientMocks.markNotificationRead.mockResolvedValue({})
    await handlerFor(PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL)(trustedEvent(), {
      notificationId: NOTIF
    })
    expect(clientMocks.markNotificationRead).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      NOTIF,
      expect.any(Function)
    )
  })

  it('rejects a non-uuid notification id before touching the client', () => {
    expect(() =>
      handlerFor(PIE_CHAT_MARK_NOTIFICATION_READ_CHANNEL)(trustedEvent(), { notificationId: 'nope' })
    ).toThrow('PIE_CHAT_INVALID_REQUEST')
    expect(clientMocks.markNotificationRead).not.toHaveBeenCalled()
  })

  it('marks all read with resolved auth', async () => {
    clientMocks.markAllNotificationsRead.mockResolvedValue(2)
    await handlerFor(PIE_CHAT_MARK_ALL_NOTIFICATIONS_READ_CHANNEL)(trustedEvent(), undefined)
    expect(clientMocks.markAllNotificationsRead).toHaveBeenCalledWith(
      'https://cp.example/v1',
      'token-123',
      ORG,
      expect.any(Function)
    )
  })

  it('rejects an untrusted sender before listing notifications', () => {
    const untrusted = {
      sender: { id: 99, getType: () => 'window', isDestroyed: () => false, mainFrame: {} },
      senderFrame: {}
    }
    expect(() => handlerFor(PIE_CHAT_LIST_NOTIFICATIONS_CHANNEL)(untrusted, undefined)).toThrow(
      'PIE_IPC_UNTRUSTED_SENDER'
    )
    expect(clientMocks.listNotifications).not.toHaveBeenCalled()
  })
})
