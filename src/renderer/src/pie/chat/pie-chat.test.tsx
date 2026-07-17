// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatScreen } from './ChatScreen'
import type {
  PieChannel,
  PieChatMessagesChanged,
  PieChatRendererApi,
  PieMessage
} from '../../../../shared/pie-chat-contract'
import type { PieSessionState } from '../../../../shared/pie-session-contract'

const USER = '20000000-0000-4000-8000-0000000000aa'
const OTHER = '20000000-0000-4000-8000-0000000000bb'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'

function channel(): PieChannel {
  return {
    id: CHANNEL,
    organizationId: ORG,
    name: 'general',
    kind: 'channel',
    scopeType: 'organization',
    scopeId: null,
    visibility: 'internal',
    version: 1,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }
}

function message(overrides: Partial<PieMessage> = {}): PieMessage {
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

const signedInSession: PieSessionState = {
  status: 'signed_in',
  instanceId: 'local-desktop',
  userId: USER,
  displayName: 'Pie User',
  organizationId: ORG,
  permissions: ['message.post'],
  expiresAt: '2026-07-16T01:00:00.000Z'
}

type FakeChat = PieChatRendererApi & {
  changedCallbacks: ((event: PieChatMessagesChanged) => void)[]
}

function makeChatApi(overrides: Partial<PieChatRendererApi> = {}): FakeChat {
  const changedCallbacks: ((event: PieChatMessagesChanged) => void)[] = []
  const api: FakeChat = {
    changedCallbacks,
    listChannels: vi.fn().mockResolvedValue([channel()]),
    listMessages: vi.fn().mockResolvedValue({ items: [message()], nextCursor: null }),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
    onMessagesChanged: (callback) => {
      changedCallbacks.push(callback)
      return () => {
        const index = changedCallbacks.indexOf(callback)
        if (index !== -1) {
          changedCallbacks.splice(index, 1)
        }
      }
    },
    ...overrides
  }
  return api
}

function setChatApi(chat: PieChatRendererApi): void {
  ;(window as unknown as { api: { pie: { chat: PieChatRendererApi } } }).api = { pie: { chat } }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderScreen(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ChatScreen getSessionState={() => Promise.resolve(signedInSession)} />)
  })
  return { root, container }
}

describe('Pie chat renderer', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('renders channels and messages for the selected channel', async () => {
    setChatApi(makeChatApi())
    ;({ root, container } = renderScreen())
    await flush()

    expect(container.textContent).toContain('general')
    expect(container.textContent).toContain('hello world')
  })

  it('optimistically appends a sent message before the server responds', async () => {
    let resolveSend: (value: PieMessage) => void = () => {}
    const sendMessage = vi
      .fn()
      .mockImplementation(() => new Promise<PieMessage>((resolve) => (resolveSend = resolve)))
    setChatApi(makeChatApi({ sendMessage }))
    ;({ root, container } = renderScreen())
    await flush()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set
    await act(async () => {
      setValue?.call(textarea, 'my new message')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // Appears immediately, before the send promise resolves.
    expect(container.textContent).toContain('my new message')
    expect(sendMessage).toHaveBeenCalledWith(CHANNEL, 'my new message')
    resolveSend(
      message({
        id: '20000000-0000-4000-8000-000000000099',
        body: 'my new message',
        authorId: USER
      })
    )
    await flush()
  })

  it('renders a tombstone for a deleted message', async () => {
    setChatApi(
      makeChatApi({
        listMessages: vi
          .fn()
          .mockResolvedValue({ items: [message({ deleted: true, body: '' })], nextCursor: null })
      })
    )
    ;({ root, container } = renderScreen())
    await flush()

    expect(container.textContent).toContain('Message deleted')
  })

  it('live-updates the timeline on an onMessagesChanged event', async () => {
    const listMessages = vi
      .fn()
      .mockResolvedValueOnce({ items: [message({ body: 'first' })], nextCursor: null })
      .mockResolvedValue({
        items: [
          message({ body: 'first' }),
          message({ id: '20000000-0000-4000-8000-000000000020', body: 'second' })
        ],
        nextCursor: null
      })
    const chat = makeChatApi({ listMessages })
    setChatApi(chat)
    ;({ root, container } = renderScreen())
    await flush()
    expect(container.textContent).toContain('first')
    expect(container.textContent).not.toContain('second')

    await act(async () => {
      chat.changedCallbacks.forEach((callback) =>
        callback({ type: 'chat.messages-changed', organizationId: ORG })
      )
    })
    await flush()

    expect(container.textContent).toContain('second')
  })
})
