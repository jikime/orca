import { useEffect, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { translate } from '@/i18n/i18n'
import type { TimelineMessage } from './pie-chat-controller'
import { MessageTimelineRow, type MessageTimelineRowProps } from './MessageTimelineRow'

export const CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD = 150
const CHAT_TIMELINE_OVERSCAN = 12
const ESTIMATED_MESSAGE_HEIGHT_PX = 72

export function shouldVirtualizeChatTimeline(messageCount: number): boolean {
  return messageCount >= CHAT_TIMELINE_VIRTUALIZATION_THRESHOLD
}

type MessageTimelineListProps = Omit<
  MessageTimelineRowProps,
  'message' | 'previous' | 'focused'
> & {
  messages: TimelineMessage[]
  unreadBoundaryMessageId: string | null
  focusedMessageId: string | null
  viewportRef: RefObject<HTMLDivElement | null>
}

function UnreadDivider(): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-3 py-1"
      aria-label={translate('auto.pie.chat.MessageTimeline.unread', 'Unread messages')}
    >
      <span className="h-px flex-1 bg-destructive" />
      <span className="text-xs font-medium text-destructive">
        {translate('auto.pie.chat.MessageTimeline.unread', 'Unread messages')}
      </span>
      <span className="h-px flex-1 bg-destructive" />
    </div>
  )
}

export function MessageTimelineList({
  messages,
  unreadBoundaryMessageId,
  focusedMessageId,
  viewportRef,
  ...rowProps
}: MessageTimelineListProps): React.JSX.Element {
  const virtualized = shouldVirtualizeChatTimeline(messages.length)
  const virtualizer = useVirtualizer({
    enabled: virtualized,
    count: virtualized ? messages.length : 0,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => messages[index]?.optimisticId ?? messages[index]?.id ?? index,
    estimateSize: () => ESTIMATED_MESSAGE_HEIGHT_PX,
    overscan: CHAT_TIMELINE_OVERSCAN
  })

  useEffect(() => {
    if (!virtualized) {
      return
    }
    const targetId = focusedMessageId ?? unreadBoundaryMessageId
    const targetIndex = targetId ? messages.findIndex((message) => message.id === targetId) : -1
    if (targetIndex >= 0) {
      virtualizer.scrollToIndex(targetIndex, { align: focusedMessageId ? 'center' : 'start' })
    }
  }, [focusedMessageId, messages, unreadBoundaryMessageId, virtualized, virtualizer])

  if (!virtualized) {
    return (
      <div role="list" className="flex flex-col gap-3">
        {messages.map((message, index) => (
          <div key={message.optimisticId ?? message.id}>
            {message.id === unreadBoundaryMessageId && <UnreadDivider />}
            <MessageTimelineRow
              {...rowProps}
              message={message}
              previous={messages[index - 1]}
              focused={message.id === focusedMessageId}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      role="list"
      data-testid="chat-virtual-timeline"
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const message = messages[virtualRow.index]
        if (!message) {
          return null
        }
        return (
          <div
            key={message.optimisticId ?? message.id}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            className="absolute top-0 left-0 w-full pb-3"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {message.id === unreadBoundaryMessageId && <UnreadDivider />}
            <MessageTimelineRow
              {...rowProps}
              message={message}
              previous={messages[virtualRow.index - 1]}
              focused={message.id === focusedMessageId}
            />
          </div>
        )
      })}
    </div>
  )
}
