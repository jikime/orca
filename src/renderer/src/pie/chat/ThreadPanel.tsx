import { useCallback, useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import type { PieChatRendererApi, PieMessage } from '../../../../shared/pie-chat-contract'
import { MessageComposer } from './MessageComposer'
import { MessageBody } from './MessageBody'

type ThreadPanelProps = {
  channelId: string
  root: PieMessage
  currentUserId: string
  api: PieChatRendererApi
  onClose: () => void
  // Refresh the main timeline so the root's reply count updates after a reply.
  onReplied: () => void
}

function label(authorId: string, currentUserId: string): string {
  return authorId === currentUserId ? 'You' : authorId.slice(0, 8)
}

export function ThreadPanel({
  channelId,
  root,
  currentUserId,
  api,
  onClose,
  onReplied
}: ThreadPanelProps): React.JSX.Element {
  const [replies, setReplies] = useState<PieMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

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

  const sendReply = useCallback(
    async (body: string): Promise<void> => {
      setSending(true)
      try {
        await api.sendMessage(channelId, body, { threadRootMessageId: root.id })
        await load()
        onReplied()
      } finally {
        setSending(false)
      }
    },
    [api, channelId, root.id, load, onReplied]
  )

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <h3 className="text-sm font-medium text-foreground">Thread</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </header>
      <div className="border-b border-border px-4 py-3">
        <div className="text-xs font-medium text-foreground">
          {label(root.authorId, currentUserId)}
        </div>
        {/* div, not p: rendered Markdown may contain block elements. */}
        <div className="text-sm break-words text-foreground">
          <MessageBody body={root.body} />
        </div>
      </div>
      <ScrollArea className="flex-1" viewportClassName="px-4 py-2">
        {loading && replies.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">Loading…</p>
        ) : replies.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No replies yet</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {replies.map((reply) => (
              <li key={reply.id}>
                <div className="text-xs font-medium text-foreground">
                  {label(reply.authorId, currentUserId)}
                </div>
                {/* div, not p: rendered Markdown may contain block elements. */}
                <div className="text-sm break-words text-foreground">
                  <MessageBody body={reply.body} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
      <MessageComposer disabled={false} sending={sending} onSend={sendReply} />
      <div className="px-3 pb-2">
        <Button type="button" variant="ghost" size="sm" className="w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}
