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
import { TypingIndicator } from './TypingIndicator'
import { usePieChat } from './use-pie-chat'
import type { TimelineMessage } from './use-pie-chat'
import { translate } from '@/i18n/i18n'
import { subscribePieChatNavigation, takePieChatNavigation } from './pie-chat-navigation'
import { MessageWorkItemDialog } from './MessageWorkItemDialog'
import { MessageAgendaDialog } from './MessageAgendaDialog'

type ChatWorkspaceProps = {
  currentUserId: string
  permissions: string[]
}

const CHAT_COLUMNS = 'relative grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)]'
// A viewport breakpoint cannot tell how narrow this nested workspace is; reserve
// the third column only while its thread panel is actually visible.
const CHAT_COLUMNS_WITH_THREAD = 'xl:grid-cols-[232px_minmax(0,1fr)_264px]'
const CHAT_COLUMNS_WITHOUT_THREAD = 'xl:grid-cols-[232px_minmax(0,1fr)]'

function ChatWorkspace({ currentUserId, permissions }: ChatWorkspaceProps): React.JSX.Element {
  const chat = usePieChat(currentUserId)
  const [threadRoot, setThreadRoot] = useState<PieMessage | null>(null)
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const [workItemSource, setWorkItemSource] = useState<TimelineMessage | null>(null)
  const [agendaSource, setAgendaSource] = useState<TimelineMessage | null>(null)
  const activeChannel = chat.channels.find((channel) => channel.id === chat.selectedChannelId)
  const meetingId = activeChannel?.scopeType === 'meeting' ? (activeChannel.scopeId ?? null) : null

  // Close the thread when the channel changes so it never shows a stale root.
  useEffect(() => {
    setThreadRoot(null)
  }, [chat.selectedChannelId])

  const selectChannel = useCallback(
    (channelId: string): void => {
      setFocusedMessageId(null)
      chat.selectChannel(channelId)
    },
    [chat]
  )

  const togglePin = useCallback(
    async (message: TimelineMessage): Promise<void> => {
      if (!chat.selectedChannelId) {
        return
      }
      await (message.pinned
        ? chat.api.unpinMessage(chat.selectedChannelId, message.id)
        : chat.api.pinMessage(chat.selectedChannelId, message.id))
      await chat.refresh()
    },
    [chat]
  )

  const jumpToChannel = useCallback(
    (channel: PieChannel) => {
      chat.selectChannelObject(channel)
      setThreadRoot(null)
      setFocusedMessageId(null)
    },
    [chat]
  )

  const onSearchSelect = useCallback(
    (message: PieMessage) => {
      chat.focusMessage(message)
      setFocusedMessageId(message.id)
      setThreadRoot(null)
    },
    [chat]
  )

  const focusExactMessage = useCallback(
    async (channelId: string, messageId: string): Promise<void> => {
      try {
        // Notification targets may be outside the latest loaded page. Fetch the
        // canonical message before focusing so the jump never lands on blank space.
        const message = await chat.api.getMessage(channelId, messageId)
        chat.focusMessage(message)
        setThreadRoot(null)
        setFocusedMessageId(message.id)
      } catch {
        chat.selectChannel(channelId)
        setFocusedMessageId(messageId)
      }
    },
    [chat]
  )

  const onSelectNotification = useCallback(
    (notification: PieNotification): void => {
      void chat.markNotificationRead(notification.id)
      if (notification.channelId && notification.messageId) {
        void focusExactMessage(notification.channelId, notification.messageId)
      }
    },
    [chat, focusExactMessage]
  )

  useEffect(() => {
    const openPending = (): void => {
      const target = takePieChatNavigation()
      if (target) {
        if (target.messageId) {
          void focusExactMessage(target.channelId, target.messageId)
        } else if (target.channel) {
          jumpToChannel(target.channel)
        } else {
          selectChannel(target.channelId)
        }
      }
    }
    openPending()
    return subscribePieChatNavigation(openPending)
  }, [focusExactMessage, jumpToChannel, selectChannel])

  const editMessage = useCallback(
    async (message: TimelineMessage, body: string): Promise<void> => {
      if (!chat.selectedChannelId) {
        return
      }
      await chat.api.editMessage(chat.selectedChannelId, message.id, body, message.version)
      await chat.refresh()
    },
    [chat]
  )

  const deleteMessage = useCallback(
    async (message: TimelineMessage, reason?: string): Promise<void> => {
      if (!chat.selectedChannelId) {
        return
      }
      await chat.api.deleteMessage(chat.selectedChannelId, message.id, reason)
      await chat.refresh()
    },
    [chat]
  )

  return (
    <div
      className={`grid h-full w-full ${CHAT_COLUMNS} ${
        threadRoot && chat.selectedChannelId
          ? CHAT_COLUMNS_WITH_THREAD
          : CHAT_COLUMNS_WITHOUT_THREAD
      } bg-background text-foreground`}
    >
      <ChannelSidebar
        channels={chat.channels}
        members={chat.members}
        selectedChannelId={chat.selectedChannelId}
        loading={chat.loadingChannels}
        currentUserId={currentUserId}
        api={chat.api}
        onSelect={selectChannel}
        onChannelCreated={jumpToChannel}
      />
      <main className="flex min-h-0 min-w-0 flex-col">
        <ChatHeader
          channel={activeChannel}
          members={chat.members}
          api={chat.api}
          onSearchSelect={onSearchSelect}
          onPinnedSelect={onSearchSelect}
          currentUserId={currentUserId}
          canManageChannel={permissions.includes('channel.manage')}
          onChannelUpdated={chat.replaceChannel}
          channels={chat.channels}
          onlineUserIds={chat.onlineUserIds}
          notifications={chat.notifications}
          unreadNotificationCount={chat.unreadNotificationCount}
          onSelectNotification={onSelectNotification}
          onMarkAllNotificationsRead={chat.markAllNotificationsRead}
        />
        {chat.error && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-destructive">
            {chat.error}
          </div>
        )}
        {chat.selectedChannelId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <PinnedBanner
              channelId={chat.selectedChannelId}
              api={chat.api}
              members={chat.members}
              refreshKey={chat.messages
                .filter((message) => message.pinned)
                .map((message) => message.id)
                .join(':')}
            />
            <MessageTimeline
              messages={chat.messages}
              currentUserId={currentUserId}
              members={chat.members}
              loading={chat.loadingMessages}
              channelId={chat.selectedChannelId}
              canModerate={permissions.includes('channel.manage')}
              onToggleReaction={chat.toggleReaction}
              onOpenThread={setThreadRoot}
              onTogglePin={togglePin}
              onCreateWorkItem={
                permissions.includes('work_item.create') ? setWorkItemSource : undefined
              }
              onAddToAgenda={
                meetingId && permissions.includes('meeting.manage') ? setAgendaSource : undefined
              }
              onEditMessage={editMessage}
              onDeleteMessage={deleteMessage}
              onRetryMessage={(optimisticId) => void chat.retryMessage(optimisticId)}
              onDismissFailedMessage={chat.dismissFailedMessage}
              loadingOlder={chat.loadingOlderMessages}
              hasOlder={chat.hasOlderMessages}
              onLoadOlder={() => void chat.loadOlderMessages()}
              focusedMessageId={focusedMessageId}
              unreadBoundaryMessageId={chat.unreadBoundaryMessageId}
              onReadThrough={(messageId) => {
                if (chat.selectedChannelId) {
                  void chat.markReadThrough(chat.selectedChannelId, messageId)
                }
              }}
              readOnly={Boolean(activeChannel?.archivedAt)}
            />
            <TypingIndicator
              typingUserIds={chat.typingUserIdsByChannel.get(chat.selectedChannelId) ?? []}
              members={chat.members}
            />
            {activeChannel?.archivedAt ? (
              <div className="border-t border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                {translate(
                  'auto.pie.chat.ChatScreen.archived',
                  'This channel is archived. Restore it in channel settings to continue chatting.'
                )}
              </div>
            ) : (
              <ChannelComposer
                channelId={chat.selectedChannelId}
                draftOwnerId={currentUserId}
                members={chat.members}
                sending={chat.sending}
                api={chat.api}
                onSend={chat.sendMessage}
                notifyTyping={chat.notifyTyping}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {translate('auto.pie.chat.ChatScreen.5a6de3b2da', 'Select a channel to start chatting')}
          </div>
        )}
      </main>
      {threadRoot && chat.selectedChannelId && (
        <aside className="pie-chat-thread-panel absolute inset-y-0 right-0 z-20 min-w-0 w-80 max-w-full shadow-lg">
          <ThreadPanel
            channelId={chat.selectedChannelId}
            root={threadRoot}
            currentUserId={currentUserId}
            members={chat.members}
            api={chat.api}
            onClose={() => setThreadRoot(null)}
            onReplied={chat.refresh}
            readOnly={Boolean(activeChannel?.archivedAt)}
            canModerate={permissions.includes('channel.manage')}
            onCreateWorkItem={
              permissions.includes('work_item.create') ? setWorkItemSource : undefined
            }
            onAddToAgenda={
              meetingId && permissions.includes('meeting.manage') ? setAgendaSource : undefined
            }
          />
        </aside>
      )}
      <MessageWorkItemDialog
        open={workItemSource !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWorkItemSource(null)
          }
        }}
        channelId={chat.selectedChannelId ?? ''}
        assigneeId={currentUserId}
        message={workItemSource}
      />
      <MessageAgendaDialog
        open={agendaSource !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAgendaSource(null)
          }
        }}
        meetingId={meetingId ?? ''}
        channelId={chat.selectedChannelId ?? ''}
        message={agendaSource}
      />
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
    // Track session transitions live: a failed token refresh flips the session to
    // reauth_required, and a re-login flips it back to signed_in. Without this the
    // surface keeps its mount-time snapshot and 401s silently instead of prompting.
    const unsubscribe = window.api?.pie?.session?.onChanged?.((event) => {
      if (!cancelled) {
        setSession(event.session)
      }
    })
    return () => {
      cancelled = true
      unsubscribe?.()
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
        {translate('auto.pie.chat.ChatScreen.8bcadb6d26', 'Could not load your Pie session')}
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        {translate('auto.pie.chat.ChatScreen.e9c3f412e7', 'Loading…')}
      </div>
    )
  }

  // Any non-signed-in state prompts a sign-in. reauth_required means a token
  // refresh failed (expired refresh token / ended IdP session), so the message
  // distinguishes it from a first-time sign-in.
  if (session.status !== 'signed_in') {
    const reauth = session.status === 'reauth_required'
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background">
        <p className="text-sm text-muted-foreground">
          {reauth
            ? translate(
                'auto.pie.chat.ChatScreen.ff4184c27d',
                'Your Pie session expired — sign in again to continue.'
              )
            : translate('auto.pie.chat.ChatScreen.c601569f79', 'Sign in to use Pie chat')}
        </p>
        <Button onClick={() => void signIn()} disabled={signingIn}>
          {signingIn
            ? translate('auto.pie.chat.ChatScreen.b53e1add3a', 'Signing in…')
            : translate('auto.pie.chat.ChatScreen.eaf7ac990b', 'Sign in')}
        </Button>
      </div>
    )
  }

  return <ChatWorkspace currentUserId={session.userId} permissions={session.permissions} />
}
