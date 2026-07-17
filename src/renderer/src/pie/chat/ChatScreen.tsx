import { useEffect, useState } from 'react'
import type { PieSessionState } from '../../../../shared/pie-session-contract'
import { ChannelSidebar } from './ChannelSidebar'
import { MessageComposer } from './MessageComposer'
import { MessageTimeline } from './MessageTimeline'
import { usePieChat } from './use-pie-chat'

type ChatWorkspaceProps = {
  currentUserId: string
}

function ChatWorkspace({ currentUserId }: ChatWorkspaceProps): React.JSX.Element {
  const chat = usePieChat(currentUserId)
  const activeChannel = chat.channels.find((channel) => channel.id === chat.selectedChannelId)

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <ChannelSidebar
        channels={chat.channels}
        selectedChannelId={chat.selectedChannelId}
        loading={chat.loadingChannels}
        onSelect={chat.selectChannel}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h2 className="truncate text-sm font-medium text-foreground">
            {activeChannel
              ? `${activeChannel.kind === 'dm' ? '@' : '#'} ${activeChannel.name}`
              : 'Chat'}
          </h2>
        </header>
        {chat.error && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-destructive">
            {chat.error}
          </div>
        )}
        {chat.selectedChannelId ? (
          <>
            <MessageTimeline
              messages={chat.messages}
              currentUserId={currentUserId}
              loading={chat.loadingMessages}
            />
            <MessageComposer
              disabled={!chat.selectedChannelId}
              sending={chat.sending}
              onSend={chat.sendMessage}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a channel to start chatting
          </div>
        )}
      </div>
    </div>
  )
}

type ChatScreenProps = {
  // Test seam; defaults to the live bridge in the app.
  getSessionState?: () => Promise<PieSessionState>
}

export function ChatScreen({ getSessionState }: ChatScreenProps = {}): React.JSX.Element {
  const [session, setSession] = useState<PieSessionState | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const read = getSessionState ?? (() => window.api.pie.session.getState())
    void read()
      .then((state) => {
        if (!cancelled) {
          setSession(state)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [getSessionState])

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-destructive">
        Could not load your Pie session
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (session.status === 'signed_out') {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Sign in to use Pie chat
      </div>
    )
  }

  return <ChatWorkspace currentUserId={session.userId} />
}
