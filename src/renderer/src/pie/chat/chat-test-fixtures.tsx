import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { ChatScreen } from './ChatScreen'
import type {
  PieChannel,
  PieChatMember,
  PieChatMessagesChanged,
  PieChatRendererApi,
  PieMessage,
  PieNotification,
  PiePinnedMessage
} from '../../../../shared/pie-chat-contract'
import type { PieSessionState } from '../../../../shared/pie-session-contract'
import { TooltipProvider } from '@/components/ui/tooltip'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Shared fixtures + a fully-stubbed chat API for the renderer suites. Every
// PieChatRendererApi method resolves to a benign default; specific tests override
// only the calls they exercise.

export const USER = '20000000-0000-4000-8000-0000000000aa'
export const OTHER = '20000000-0000-4000-8000-0000000000bb'
export const ORG = '20000000-0000-4000-8000-000000000001'
export const CHANNEL = '20000000-0000-4000-8000-000000000002'

export function channel(overrides: Partial<PieChannel> = {}): PieChannel {
  return {
    id: CHANNEL,
    organizationId: ORG,
    name: 'general',
    kind: 'channel',
    scopeType: 'organization',
    scopeId: null,
    visibility: 'internal',
    topic: '',
    description: '',
    version: 1,
    archivedAt: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides
  }
}

export function message(overrides: Partial<PieMessage> = {}): PieMessage {
  return {
    id: '20000000-0000-4000-8000-000000000010',
    organizationId: ORG,
    channelId: CHANNEL,
    authorId: OTHER,
    body: 'hello world',
    visibility: 'internal',
    version: 1,
    threadRootMessageId: null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    edited: false,
    revisionCount: 0,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    pinned: false,
    ...overrides
  }
}

export function member(userId: string, displayName: string): PieChatMember {
  return { userId, displayName }
}

export function notification(overrides: Partial<PieNotification> = {}): PieNotification {
  return {
    id: '20000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    userId: USER,
    type: 'mention',
    channelId: CHANNEL,
    messageId: '20000000-0000-4000-8000-000000000010',
    seen: false,
    read: false,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...overrides
  }
}

export function pinnedMessage(msg: PieMessage): PiePinnedMessage {
  return { message: msg, pinnedBy: USER, pinnedAt: '2026-07-16T00:00:00.000Z' }
}

export const signedInSession: PieSessionState = {
  status: 'signed_in',
  instanceId: 'local-desktop',
  userId: USER,
  displayName: 'Pie User',
  organizationId: ORG,
  permissions: ['message.post'],
  expiresAt: '2026-07-16T01:00:00.000Z'
}

export type FakeChat = PieChatRendererApi & {
  changedCallbacks: ((event: PieChatMessagesChanged) => void)[]
}

export function makeChatApi(overrides: Partial<PieChatRendererApi> = {}): FakeChat {
  const changedCallbacks: ((event: PieChatMessagesChanged) => void)[] = []
  const api: FakeChat = {
    changedCallbacks,
    listChannels: vi.fn().mockResolvedValue([channel()]),
    listMessages: vi.fn().mockResolvedValue({ items: [message()], nextCursor: null }),
    getMessage: vi.fn().mockResolvedValue(message()),
    sendMessage: vi.fn().mockResolvedValue(message({ authorId: USER })),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(message()),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    pinMessage: vi.fn().mockResolvedValue(undefined),
    unpinMessage: vi.fn().mockResolvedValue(undefined),
    listPins: vi.fn().mockResolvedValue([]),
    createChannel: vi.fn().mockResolvedValue(channel()),
    createDm: vi.fn().mockResolvedValue(channel({ kind: 'dm' })),
    createGroupDm: vi.fn().mockResolvedValue(channel({ kind: 'dm' })),
    addChannelMember: vi.fn().mockResolvedValue(undefined),
    updateChannel: vi.fn().mockResolvedValue(channel()),
    listChannelMembers: vi.fn().mockResolvedValue([]),
    removeChannelMember: vi.fn().mockResolvedValue(undefined),
    listChannelAudit: vi.fn().mockResolvedValue([]),
    exportChannel: vi.fn().mockResolvedValue({
      exportedAt: '2026-07-16T00:00:00.000Z',
      truncated: false,
      messages: []
    }),
    applyChannelRetention: vi.fn().mockResolvedValue(0),
    muteChannel: vi.fn().mockResolvedValue(undefined),
    unmuteChannel: vi.fn().mockResolvedValue(undefined),
    searchMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listMembers: vi.fn().mockResolvedValue([]),
    uploadAttachment: vi.fn().mockResolvedValue({
      id: 'att-1',
      objectId: 'obj-1',
      uploadUrl: 'https://up',
      expiresAt: 'x'
    }),
    downloadAttachment: vi.fn().mockResolvedValue({
      url: 'https://dl',
      filename: 'f',
      contentType: 'image/png',
      expiresAt: 'x'
    }),
    listNotifications: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    markNotificationRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(0),
    getNotificationPreferences: vi.fn().mockResolvedValue({
      desktopEnabled: true,
      dndEnabled: false,
      dndStartMinute: 1320,
      dndEndMinute: 480,
      timezone: 'UTC',
      channelLevels: []
    }),
    updateNotificationPreferences: vi.fn(),
    setChannelNotificationLevel: vi.fn().mockResolvedValue(undefined),
    onNotificationClicked: () => () => {},
    onMessagesChanged: (callback) => {
      changedCallbacks.push(callback)
      return () => {
        const index = changedCallbacks.indexOf(callback)
        if (index !== -1) {
          changedCallbacks.splice(index, 1)
        }
      }
    },
    sendTyping: vi.fn().mockResolvedValue(undefined),
    getPresenceSnapshot: vi.fn().mockResolvedValue([]),
    onTypingChanged: () => () => {},
    onPresenceChanged: () => () => {},
    ...overrides
  }
  return api
}

export function setChatApi(chat: PieChatRendererApi): void {
  ;(window as unknown as { api: { pie: { chat: PieChatRendererApi } } }).api = { pie: { chat } }
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

export function renderScreen(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <TooltipProvider>
        <ChatScreen getSessionState={() => Promise.resolve(signedInSession)} />
      </TooltipProvider>
    )
  })
  return { root, container }
}

// The composer is now a TipTap contenteditable, so text is inserted via a paste
// event (which ProseMirror handles) rather than a textarea value assignment.
export function typeInto(container: HTMLElement, text: string): void {
  const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  editable.dispatchEvent(
    new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true
    } as ClipboardEventInit)
  )
}

export function pressEnter(container: HTMLElement): void {
  const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
  editable.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  )
}
