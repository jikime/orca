// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ChatHeaderContextControls', () => ({
  ChatHeaderContextControls: ({
    notifications,
    onSelectNotification
  }: {
    notifications: { id: string }[]
    onSelectNotification: (notification: { id: string }) => void
  }) => (
    <div>
      {notifications.map((item) => (
        <button key={item.id} type="button" onClick={() => onSelectNotification(item)}>
          Mentioned you
        </button>
      ))}
    </div>
  )
}))
import {
  CHANNEL,
  flush,
  makeChatApi,
  message,
  notification,
  renderScreen,
  setChatApi
} from './chat-test-fixtures'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('Chat notification navigation', () => {
  it('fetches and focuses a target outside the latest message page', async () => {
    const target = message({
      id: '20000000-0000-4000-8000-000000000099',
      body: 'historical mention'
    })
    const getMessage = vi.fn().mockResolvedValue(target)
    const api = makeChatApi({
      listMessages: vi.fn().mockResolvedValue({
        items: [message({ id: '20000000-0000-4000-8000-000000000088', body: 'latest' })],
        nextCursor: null
      }),
      listNotifications: vi.fn().mockResolvedValue({
        items: [notification({ channelId: CHANNEL, messageId: target.id })],
        nextCursor: null
      }),
      getMessage
    })
    setChatApi(api)
    ;({ root, container } = renderScreen())
    await flush()

    const notificationButton = [...(container?.querySelectorAll('button') ?? [])].find((button) =>
      button.textContent?.includes('Mentioned you')
    )
    expect(notificationButton).toBeTruthy()
    act(() => notificationButton?.click())
    await flush()

    expect(api.markNotificationRead).toHaveBeenCalledWith(notification().id)
    expect(getMessage).toHaveBeenCalledWith(CHANNEL, target.id)
    expect(container?.querySelector(`[data-message-id="${target.id}"]`)?.textContent).toContain(
      'historical mention'
    )
  })
})
