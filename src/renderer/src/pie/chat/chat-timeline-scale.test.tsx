// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageTimeline } from './MessageTimeline'
import { mergeChatTimeline } from './merge-chat-timeline'
import {
  CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeChatTimeline
} from './MessageTimelineList'
import { CHANNEL, OTHER, USER, member, message } from './chat-test-fixtures'

let host: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function numberedMessage(index: number) {
  return message({
    id: `message-${String(index).padStart(12, '0')}`,
    body: `message ${index}`,
    createdAt: new Date(1_700_000_000_000 + index).toISOString()
  })
}

describe('chat timeline scale gate', () => {
  it('switches to virtualization at the documented threshold', () => {
    expect(shouldVirtualizeChatTimeline(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD - 1)).toBe(false)
    expect(shouldVirtualizeChatTimeline(CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD)).toBe(true)
  })

  it('merges ten thousand messages without duplicate ids', () => {
    const history = Array.from({ length: 10_000 }, (_, index) => numberedMessage(index))
    const realtime = [...history.slice(-100), numberedMessage(10_000)]
    const merged = mergeChatTimeline(history, realtime)

    expect(merged).toHaveLength(10_001)
    expect(new Set(merged.map((item) => item.id)).size).toBe(10_001)
    expect(merged.at(-1)?.body).toBe('message 10000')
  })

  it('mounts only a bounded window for ten thousand messages', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => numberedMessage(index))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root?.render(
        <TooltipProvider>
          <MessageTimeline
            messages={messages}
            currentUserId={USER}
            members={[member(USER, 'Ada'), member(OTHER, 'Grace')]}
            loading={false}
            channelId={CHANNEL}
            onToggleReaction={vi.fn()}
            onOpenThread={vi.fn()}
            onTogglePin={vi.fn()}
            onEditMessage={vi.fn()}
            onDeleteMessage={vi.fn()}
            loadingOlder={false}
            hasOlder={false}
            onLoadOlder={vi.fn()}
            focusedMessageId={null}
          />
        </TooltipProvider>
      )
    })

    expect(host.querySelector('[data-testid="chat-virtual-timeline"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-message-id]').length).toBeLessThan(100)
  })
})
