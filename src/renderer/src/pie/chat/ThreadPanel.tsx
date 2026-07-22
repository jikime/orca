import { useCallback, useEffect, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import type {
  PieChatMember,
  PieChatRendererApi,
  PieMessage,
  PieSendMessageOptions
} from '../../../../shared/pie-chat-contract'
import { ChannelComposer } from './ChannelComposer'
import { MessageBody } from './MessageBody'
import { translate } from '@/i18n/i18n'
import { AttachmentList } from './AttachmentList'
import { ReactionBar } from './ReactionBar'
import { MessageEditForm } from './MessageEditForm'
import { MessageDeleteDialog } from './MessageDeleteDialog'
import { chatMemberDisplayName } from './chat-member-display-name'
import { MessageActionToolbar } from './MessageActionToolbar'
import {
  chatScrollPositionKey,
  readChatScrollPosition,
  writeChatScrollPosition
} from './chat-scroll-position-store'

type ThreadPanelProps = {
  channelId: string
  root: PieMessage
  currentUserId: string
  members: PieChatMember[]
  api: PieChatRendererApi
  onClose: () => void
  // Refresh the main timeline so the root's reply count updates after a reply.
  onReplied: () => void
  readOnly?: boolean
  canModerate?: boolean
  onCreateWorkItem?: (message: PieMessage) => void
  onAddToAgenda?: (message: PieMessage) => void
}

export function ThreadPanel({
  channelId,
  root,
  currentUserId,
  members,
  api,
  onClose,
  onReplied,
  readOnly = false,
  canModerate = false,
  onCreateWorkItem,
  onAddToAgenda
}: ThreadPanelProps): React.JSX.Element {
  const [replies, setReplies] = useState<PieMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PieMessage | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const restoredScrollKeyRef = useRef<string | null>(null)
  const scrollKey = chatScrollPositionKey(currentUserId, channelId, root.id)
  const authorLabel = (authorId: string): string =>
    chatMemberDisplayName(
      authorId,
      members,
      currentUserId,
      translate('auto.pie.chat.ThreadPanel.selfauthor', 'You')
    )

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      // Replies are messages filtered by threadRoot on the same channel endpoint.
      const response = await api.listMessages(channelId, { threadRoot: root.id })
      setReplies(response.items)
    } finally {
      setLoading(false)
    }
  }, [api, channelId, root.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => api.onMessagesChanged(() => void load()), [api, load])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || loading || restoredScrollKeyRef.current === scrollKey) {
      return
    }
    const saved = readChatScrollPosition(scrollKey)
    viewport.scrollTop = saved && !saved.atBottom ? saved.scrollTop : viewport.scrollHeight
    restoredScrollKeyRef.current = scrollKey
  }, [loading, replies.length, scrollKey])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const save = (): void => {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48
      writeChatScrollPosition(scrollKey, {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        atBottom
      })
    }
    viewport.addEventListener('scroll', save, { passive: true })
    return () => viewport.removeEventListener('scroll', save)
  }, [scrollKey])

  const sendReply = useCallback(
    async (body: string, opts?: PieSendMessageOptions, clientRequestId?: string): Promise<void> => {
      setSending(true)
      try {
        await api.sendMessage(
          channelId,
          body,
          { ...opts, threadRootMessageId: root.id },
          clientRequestId
        )
        await load()
        onReplied()
      } finally {
        setSending(false)
      }
    },
    [api, channelId, root.id, load, onReplied]
  )

  const toggleReaction = async (reply: PieMessage, emoji: string): Promise<void> => {
    const reacted = reply.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.reactedByMe
    )
    await (reacted
      ? api.removeReaction(channelId, reply.id, emoji)
      : api.addReaction(channelId, reply.id, emoji))
    await load()
  }

  const togglePin = async (reply: PieMessage): Promise<void> => {
    await (reply.pinned
      ? api.unpinMessage(channelId, reply.id)
      : api.pinMessage(channelId, reply.id))
    await load()
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h3 className="text-sm font-medium text-foreground">
          {translate('auto.pie.chat.ThreadPanel.9bfe3362e2', 'Thread')}
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label={translate('auto.pie.chat.ThreadPanel.948c50b342', 'Close thread')}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </header>
      <div className="border-b border-border px-4 py-3">
        <div className="text-xs font-medium text-foreground">{authorLabel(root.authorId)}</div>
        {/* div, not p: rendered Markdown may contain block elements. */}
        <div className="text-sm break-words text-foreground">
          <MessageBody body={root.body} />
        </div>
      </div>
      <ScrollArea className="flex-1" viewportClassName="px-4 py-2" viewportRef={viewportRef}>
        {loading && replies.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {translate('auto.pie.chat.ThreadPanel.0dc91c7465', 'Loading…')}
          </p>
        ) : replies.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {translate('auto.pie.chat.ThreadPanel.422de4e5e4', 'No replies yet')}
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {replies.map((reply) => (
              <li
                key={reply.id}
                className="group/message relative flex rounded-md px-2 py-1 hover:bg-accent/50 focus-within:bg-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-foreground">
                    {authorLabel(reply.authorId)}
                  </div>
                  {reply.deleted ? (
                    <p className="text-sm italic text-muted-foreground">
                      {translate('auto.pie.chat.ThreadPanel.deleted', 'Message deleted')}
                    </p>
                  ) : editingId === reply.id ? (
                    <MessageEditForm
                      initialBody={reply.body}
                      onCancel={() => setEditingId(null)}
                      onSave={async (body) => {
                        await api.editMessage(channelId, reply.id, body, reply.version)
                        await load()
                        setEditingId(null)
                      }}
                    />
                  ) : (
                    <>
                      <div className="text-sm break-words text-foreground">
                        <MessageBody body={reply.body} />
                        {reply.edited && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {translate('auto.pie.chat.ThreadPanel.edited', '(edited)')}
                          </span>
                        )}
                      </div>
                      {reply.attachments.length > 0 && (
                        <AttachmentList
                          channelId={channelId}
                          attachments={reply.attachments}
                          api={api}
                        />
                      )}
                      {reply.reactions.length > 0 && !readOnly && (
                        <ReactionBar
                          reactions={reply.reactions}
                          onToggle={(emoji) => void toggleReaction(reply, emoji)}
                        />
                      )}
                    </>
                  )}
                </div>
                {!reply.deleted && !readOnly && editingId !== reply.id && (
                  <MessageActionToolbar
                    pinned={reply.pinned}
                    onReact={(emoji) => void toggleReaction(reply, emoji)}
                    onTogglePin={() => void togglePin(reply)}
                    onCreateWorkItem={onCreateWorkItem ? () => onCreateWorkItem(reply) : undefined}
                    onAddToAgenda={onAddToAgenda ? () => onAddToAgenda(reply) : undefined}
                    onEdit={
                      reply.authorId === currentUserId ? () => setEditingId(reply.id) : undefined
                    }
                    onDelete={
                      reply.authorId === currentUserId || canModerate
                        ? () => setDeleteTarget(reply)
                        : undefined
                    }
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
      {!readOnly && (
        <ChannelComposer
          channelId={channelId}
          draftOwnerId={currentUserId}
          threadRootMessageId={root.id}
          members={members}
          sending={sending}
          api={api}
          onSend={sendReply}
        />
      )}
      <div className="px-3 pb-2">
        <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onClose}>
          {translate('auto.pie.chat.ThreadPanel.07dae26381', 'Close')}
        </Button>
      </div>
      <MessageDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
        requireReason={deleteTarget?.authorId !== currentUserId}
        onConfirm={async (reason) => {
          if (deleteTarget) {
            await api.deleteMessage(channelId, deleteTarget.id, reason)
            await load()
          }
        }}
      />
    </div>
  )
}
