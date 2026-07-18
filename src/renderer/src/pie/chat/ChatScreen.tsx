import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { PieSessionState } from '../../../../shared/pie-session-contract'
import type { PieChannel, PieMessage, PieNotification } from '../../../../shared/pie-chat-contract'
import { ChannelSidebar } from './ChannelSidebar'
import { ChannelComposer } from './ChannelComposer'
import { MessageTimeline } from './MessageTimeline'
import { ThreadPanel } from './ThreadPanel'
import { ChatHeader } from './ChatHeader'
import { PinnedBanner } from './PinnedBanner'
import { ContextSidebar } from './ContextSidebar'
import { usePieChat } from './use-pie-chat'
import type { TimelineMessage } from './use-pie-chat'

type ChatWorkspaceProps = {
  currentUserId: string
}

// 3-column layout: left nav | center stream | right context. Fixed side
// widths (~232px / ~264px), center stream fills the remaining space.
const GRID_COLUMNS = 'grid-cols-[232px_minmax(0,1fr)_264px]'

function ChatWorkspace({ currentUserId }: ChatWorkspaceProps): React.JSX.Element {
  const chat = usePieChat(currentUserId)
  const [threadRoot, setThreadRoot] = useState<PieMessage | null>(null)
  const activeChannel = chat.channels.find((channel) => channel.id === chat.selectedChannelId)

  // Close the thread when the channel changes so it never shows a stale root.
  useEffect(() => {
    setThreadRoot(null)
  }, [chat.selectedChannelId])

  const togglePin = useCallback(
    async (message: TimelineMessage): Promise<void> => {
      if (!chat.selectedChannelId) {
        return
      }
      await (message.pinned
        ? chat.api.unpinMessage(chat.selectedChannelId, message.id)
        : chat.api.pinMessage(chat.selectedChannelId, message.id))
      chat.refresh()
    },
    [chat]
  )

  const jumpToChannel = useCallback(
    (channel: PieChannel) => {
      chat.selectChannelObject(channel)
      setThreadRoot(null)
    },
    [chat]
  )

  const onSearchSelect = useCallback(
    (message: PieMessage) => {
      // Focus the message's channel; the timeline refetch brings it into view.
      if (message.channelId !== chat.selectedChannelId) {
        chat.selectChannel(message.channelId)
      } else {
        chat.refresh()
      }
      setThreadRoot(null)
    },
    [chat]
  )

  const onSelectNotification = useCallback(
    (notification: PieNotification) => {
      void chat.markNotificationRead(notification.id)
      // Jump to the mention's channel when it is one the user can open.
      if (notification.channelId && notification.channelId !== chat.selectedChannelId) {
        chat.selectChannel(notification.channelId)
        setThreadRoot(null)
      }
    },
    [chat]
  )

  return (
    <div className={`grid h-full w-full ${GRID_COLUMNS} bg-background text-foreground`}>
      <ChannelSidebar
        channels={chat.channels}
        members={chat.members}
        selectedChannelId={chat.selectedChannelId}
        loading={chat.loadingChannels}
        currentUserId={currentUserId}
        api={chat.api}
        onSelect={chat.selectChannel}
        onChannelCreated={jumpToChannel}
      />
      <div className="flex min-w-0 min-h-0 flex-col">
        <ChatHeader
          channel={activeChannel}
          members={chat.members}
          api={chat.api}
          onSearchSelect={onSearchSelect}
        />
        {chat.error && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-destructive">
            {chat.error}
          </div>
        )}
        {chat.selectedChannelId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <PinnedBanner channelId={chat.selectedChannelId} api={chat.api} />
            <MessageTimeline
              messages={chat.messages}
              currentUserId={currentUserId}
              loading={chat.loadingMessages}
              channelId={chat.selectedChannelId}
              onToggleReaction={chat.toggleReaction}
              onOpenThread={setThreadRoot}
              onTogglePin={togglePin}
            />
            <ChannelComposer
              channelId={chat.selectedChannelId}
              members={chat.members}
              sending={chat.sending}
              api={chat.api}
              onSend={chat.sendMessage}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Select a channel to start chatting
          </div>
        )}
      </div>
      {threadRoot && chat.selectedChannelId ? (
        <ThreadPanel
          channelId={chat.selectedChannelId}
          root={threadRoot}
          currentUserId={currentUserId}
          api={chat.api}
          onClose={() => setThreadRoot(null)}
          onReplied={chat.refresh}
        />
      ) : (
        <ContextSidebar
          members={chat.members}
          channels={chat.channels}
          notifications={chat.notifications}
          unreadNotificationCount={chat.unreadNotificationCount}
          onSelectNotification={onSelectNotification}
          onMarkAllNotificationsRead={chat.markAllNotificationsRead}
        />
      )}
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
  const [signingIn, setSigningIn] = useState(false)

  const readSession = useCallback(
    () => getSessionState ?? (() => window.api.pie.session.getState()),
    [getSessionState]
  )

  useEffect(() => {
    let cancelled = false
    void readSession()()
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
  }, [readSession])

  // Triggers the dev-gated OIDC login (opens the system browser), then re-reads
  // the now-signed-in session so the chat surface renders.
  const signIn = useCallback(async (): Promise<void> => {
    setSigningIn(true)
    try {
      await window.api.pie.auth.beginLogin()
      setSession(await readSession()())
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setSigningIn(false)
    }
  }, [readSession])

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
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm text-muted-foreground">Sign in to use Pie chat</p>
        <Button onClick={() => void signIn()} disabled={signingIn}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    )
  }

  return <ChatWorkspace currentUserId={session.userId} />
}
