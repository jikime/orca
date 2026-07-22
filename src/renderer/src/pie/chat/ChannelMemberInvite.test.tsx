// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

import { ChannelMemberInvite } from './ChannelMemberInvite'
import { CHANNEL, flush, makeChatApi, member, OTHER, USER } from './chat-test-fixtures'

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

describe('ChannelMemberInvite', () => {
  it('adds an organization member through the channel admin bridge', async () => {
    const addChannelMember = vi.fn().mockResolvedValue(undefined)
    const api = makeChatApi({ addChannelMember })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <ChannelMemberInvite
          channelId={CHANNEL}
          channelName="general"
          currentUserId={USER}
          members={[member(USER, 'Ada'), member(OTHER, 'Grace')]}
          api={api}
        />
      )
    })

    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    )
    await act(async () => add?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    expect(addChannelMember).toHaveBeenCalledWith(CHANNEL, OTHER)
    expect(container.textContent).toContain('Added')
  })
})
