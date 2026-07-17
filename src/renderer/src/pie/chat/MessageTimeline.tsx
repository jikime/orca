import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { TimelineMessage } from './use-pie-chat'
import { ReactionBar } from './ReactionBar'
import { MessageBody } from './MessageBody'
import { AttachmentList } from './AttachmentList'

type MessageTimelineProps = {
  messages: TimelineMessage[]
  currentUserId: string
  loading: boolean
  channelId: string
  onToggleReaction: (messageId: string, emoji: string) => void
  onOpenThread: (message: TimelineMessage) => void
  onTogglePin: (message: TimelineMessage) => void
}

function authorLabel(authorId: string, currentUserId: string): string {
  return authorId === currentUserId ? 'You' : authorId.slice(0, 8)
}

function initials(label: string): string {
  return label === 'You' ? 'Y' : label.slice(0, 2).toUpperCase()
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function MessageTimeline({
  messages,
  currentUserId,
  loading,
  channelId,
  onToggleReaction,
  onOpenThread,
  onTogglePin
}: MessageTimelineProps): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Keep the newest message in view as the timeline grows or live-updates.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  if (loading && messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading messages…
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1" viewportClassName="px-4 py-3">
      <ol className="flex flex-col gap-3">
        {messages.map((message, index) => {
          const previous = messages[index - 1]
          // Group consecutive messages from the same author under one heading.
          const grouped = previous?.authorId === message.authorId && !previous?.deleted
          const label = authorLabel(message.authorId, currentUserId)
          const actionable = !message.deleted && !message.pending
          return (
            <li key={message.optimisticId ?? message.id} className="group flex gap-3">
              <div className="w-8 shrink-0">
                {!grouped && (
                  <div
                    aria-hidden
                    className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
                  >
                    {initials(label)}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                {!grouped && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatTime(message.createdAt)}
                    </span>
                    {message.pinned && (
                      <span className="text-xs text-muted-foreground" title="Pinned">
                        📌
                      </span>
                    )}
                  </div>
                )}
                {message.deleted ? (
                  <p className="text-sm italic text-muted-foreground">Message deleted</p>
                ) : (
                  <>
                    <p
                      className={cn(
                        'text-sm whitespace-pre-wrap break-words text-foreground',
                        message.pending && 'text-muted-foreground'
                      )}
                    >
                      <MessageBody body={message.body} />
                      {message.edited && (
                        <span className="ml-1 text-xs text-muted-foreground">(edited)</span>
                      )}
                    </p>
                    {message.attachments.length > 0 && (
                      <AttachmentList channelId={channelId} attachments={message.attachments} />
                    )}
                    {message.reactions.length > 0 && (
                      <ReactionBar
                        reactions={message.reactions}
                        onToggle={(emoji) => onToggleReaction(message.id, emoji)}
                      />
                    )}
                    {message.replyCount > 0 && (
                      <button
                        type="button"
                        onClick={() => onOpenThread(message)}
                        className="mt-1 text-xs font-medium text-primary hover:underline"
                      >
                        {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
                      </button>
                    )}
                  </>
                )}
                {message.failed && <p className="text-xs text-destructive">Failed to send</p>}
                {actionable && (
                  <div className="mt-0.5 hidden gap-2 text-xs text-muted-foreground group-hover:flex">
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => onToggleReaction(message.id, '👍')}
                    >
                      React
                    </button>
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => onOpenThread(message)}
                    >
                      Reply
                    </button>
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => onTogglePin(message)}
                    >
                      {message.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <div ref={bottomRef} />
    </ScrollArea>
  )
}
