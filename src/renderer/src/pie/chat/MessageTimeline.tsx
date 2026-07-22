import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { TimelineMessage } from './use-pie-chat'
import { translate } from '@/i18n/i18n'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { useMessageTimelineScroll } from './use-message-timeline-scroll'
import { MessageTimelineList } from './MessageTimelineList'

type MessageTimelineProps = {
  messages: TimelineMessage[]
  currentUserId: string
  members: PieChatMember[]
  loading: boolean
  channelId: string
  canModerate?: boolean
  onToggleReaction: (messageId: string, emoji: string) => void
  onOpenThread: (message: TimelineMessage) => void
  onTogglePin: (message: TimelineMessage) => void
  onCreateWorkItem?: (message: TimelineMessage) => void
  onAddToAgenda?: (message: TimelineMessage) => void
  onEditMessage: (message: TimelineMessage, body: string) => Promise<void>
  onDeleteMessage: (message: TimelineMessage, reason?: string) => Promise<void>
  onRetryMessage?: (optimisticId: string) => void
  onDismissFailedMessage?: (optimisticId: string) => void
  loadingOlder: boolean
  hasOlder: boolean
  onLoadOlder: () => void
  focusedMessageId: string | null
  unreadBoundaryMessageId?: string | null
  onReadThrough?: (messageId: string) => void
  readOnly?: boolean
}

const ignoreReadThrough = (): void => {}

export function MessageTimeline({
  messages,
  currentUserId,
  members,
  loading,
  channelId,
  canModerate = false,
  onToggleReaction,
  onOpenThread,
  onTogglePin,
  onCreateWorkItem,
  onAddToAgenda,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onDismissFailedMessage,
  loadingOlder,
  hasOlder,
  onLoadOlder,
  focusedMessageId,
  unreadBoundaryMessageId = null,
  onReadThrough = ignoreReadThrough,
  readOnly = false
}: MessageTimelineProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const { hasNewMessages, scrollToNewest } = useMessageTimelineScroll({
    viewportRef,
    ownerId: currentUserId,
    channelId,
    messages,
    unreadBoundaryMessageId,
    focusedMessageId,
    onReadThrough
  })

  if (loading && messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {translate('auto.pie.chat.MessageTimeline.deb1250abe', 'Loading messages…')}
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {translate('auto.pie.chat.MessageTimeline.6af9f3e38d', 'No messages yet')}
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <ScrollArea className="h-full" viewportClassName="px-4 py-3" viewportRef={viewportRef}>
        {hasOlder && (
          <div className="flex justify-center pb-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loadingOlder}
              onClick={onLoadOlder}
            >
              {loadingOlder
                ? translate('auto.pie.chat.MessageTimeline.loadingolder', 'Loading…')
                : translate('auto.pie.chat.MessageTimeline.loadolder', 'Load older messages')}
            </Button>
          </div>
        )}
        <MessageTimelineList
          messages={messages}
          unreadBoundaryMessageId={unreadBoundaryMessageId}
          focusedMessageId={focusedMessageId}
          viewportRef={viewportRef}
          currentUserId={currentUserId}
          members={members}
          channelId={channelId}
          readOnly={readOnly}
          canModerate={canModerate}
          onToggleReaction={onToggleReaction}
          onOpenThread={onOpenThread}
          onTogglePin={onTogglePin}
          onCreateWorkItem={onCreateWorkItem}
          onAddToAgenda={onAddToAgenda}
          onEditMessage={onEditMessage}
          onDeleteMessage={onDeleteMessage}
          onRetryMessage={onRetryMessage}
          onDismissFailedMessage={onDismissFailedMessage}
        />
      </ScrollArea>
      {hasNewMessages && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-xs"
          onClick={scrollToNewest}
        >
          {translate('auto.pie.chat.MessageTimeline.newmessages', 'New messages')}
        </Button>
      )}
    </div>
  )
}
