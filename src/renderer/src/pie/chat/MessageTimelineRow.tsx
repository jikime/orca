import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import type { TimelineMessage } from './pie-chat-controller'
import { translate } from '@/i18n/i18n'
import { chatMemberDisplayName } from './chat-member-display-name'
import { MessageAvatar } from './MessageAvatar'
import { MessageBody } from './MessageBody'
import { AttachmentList } from './AttachmentList'
import { ReactionBar } from './ReactionBar'
import { ThreadFacepile } from './ThreadFacepile'
import { MessageEditForm } from './MessageEditForm'
import { MessageActionToolbar } from './MessageActionToolbar'
import { MessageDeleteDialog } from './MessageDeleteDialog'

export type MessageTimelineRowProps = {
  message: TimelineMessage
  previous?: TimelineMessage
  currentUserId: string
  members: PieChatMember[]
  channelId: string
  focused: boolean
  readOnly: boolean
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
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function MessageTimelineRow({
  message,
  previous,
  currentUserId,
  members,
  channelId,
  focused,
  readOnly,
  canModerate = false,
  onToggleReaction,
  onOpenThread,
  onTogglePin,
  onCreateWorkItem,
  onAddToAgenda,
  onEditMessage,
  onDeleteMessage,
  onRetryMessage,
  onDismissFailedMessage
}: MessageTimelineRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const grouped = previous?.authorId === message.authorId && !previous?.deleted
  const label = chatMemberDisplayName(
    message.authorId,
    members,
    currentUserId,
    translate('auto.pie.chat.MessageTimeline.selfauthor', 'You')
  )
  const actionable = !message.deleted && !message.pending
  const ownMessage = message.authorId === currentUserId

  return (
    <div
      role="listitem"
      data-message-id={message.id}
      className={cn(
        'group/message relative flex gap-3 rounded-md px-2 py-1 transition-colors hover:bg-accent/50 focus-within:bg-accent/50',
        focused && 'bg-accent'
      )}
    >
      <div className="w-8 shrink-0">{!grouped && <MessageAvatar label={label} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">{formatTime(message.createdAt)}</span>
            {message.pinned && (
              <span className="text-xs text-muted-foreground" title="Pinned">
                📌
              </span>
            )}
          </div>
        )}
        {message.deleted ? (
          <p className="text-sm italic text-muted-foreground">
            {translate('auto.pie.chat.MessageTimeline.06f442945e', 'Message deleted')}
          </p>
        ) : editing ? (
          <MessageEditForm
            initialBody={message.body}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await onEditMessage(message, body)
              setEditing(false)
            }}
          />
        ) : (
          <>
            <div
              className={cn(
                'text-sm break-words text-foreground',
                message.pending && 'text-muted-foreground'
              )}
            >
              <MessageBody body={message.body} />
              {message.edited && (
                <span className="ml-1 text-xs text-muted-foreground">
                  {translate('auto.pie.chat.MessageTimeline.0da3375b15', '(edited)')}
                </span>
              )}
            </div>
            {message.attachments.length > 0 && (
              <AttachmentList channelId={channelId} attachments={message.attachments} />
            )}
            {message.reactions.length > 0 && !readOnly && (
              <ReactionBar
                reactions={message.reactions}
                onToggle={(emoji) => onToggleReaction(message.id, emoji)}
              />
            )}
            <ThreadFacepile replyCount={message.replyCount} onOpen={() => onOpenThread(message)} />
          </>
        )}
        {message.failed && (
          <div className="flex items-center gap-1.5 text-xs text-destructive" role="status">
            <span>{translate('auto.pie.chat.MessageTimeline.879efb1ff3', 'Failed to send')}</span>
            {message.optimisticId && onRetryMessage && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => onRetryMessage(message.optimisticId as string)}
              >
                {translate('auto.pie.chat.MessageTimeline.retry', 'Retry')}
              </Button>
            )}
            {message.optimisticId && onDismissFailedMessage && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => onDismissFailedMessage(message.optimisticId as string)}
              >
                {translate('auto.pie.chat.MessageTimeline.dismiss', 'Dismiss')}
              </Button>
            )}
          </div>
        )}
        {message.pending && (
          <p className="text-xs text-muted-foreground" role="status">
            {translate('auto.pie.chat.MessageTimeline.sending', 'Sending…')}
          </p>
        )}
      </div>
      {actionable && !readOnly && !editing && (
        <MessageActionToolbar
          pinned={message.pinned}
          onReact={(emoji) => onToggleReaction(message.id, emoji)}
          onReply={() => onOpenThread(message)}
          onTogglePin={() => onTogglePin(message)}
          onCreateWorkItem={onCreateWorkItem ? () => onCreateWorkItem(message) : undefined}
          onAddToAgenda={onAddToAgenda ? () => onAddToAgenda(message) : undefined}
          onEdit={ownMessage ? () => setEditing(true) : undefined}
          onDelete={ownMessage || canModerate ? () => setDeleteOpen(true) : undefined}
        />
      )}
      <MessageDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        requireReason={!ownMessage}
        onConfirm={(reason) => onDeleteMessage(message, reason)}
      />
    </div>
  )
}
