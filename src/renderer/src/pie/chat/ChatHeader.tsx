import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi,
  PieMessage,
  PieNotification
} from '../../../../shared/pie-chat-contract'
import { PinsPanel } from './PinsPanel'
import { MessageSearch } from './MessageSearch'
import { translate } from '@/i18n/i18n'
import { ChannelMemberInvite } from './ChannelMemberInvite'
import { ChannelSettingsDialog } from './ChannelSettingsDialog'
import { ChatNotificationSettingsDialog } from './ChatNotificationSettingsDialog'
import { Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { queuePieMeetingNavigation } from '../meetings/pie-meeting-navigation'
import { ChatHeaderContextControls } from './ChatHeaderContextControls'

type ChatHeaderProps = {
  channel: PieChannel | undefined
  members: PieChatMember[]
  api: PieChatRendererApi
  onSearchSelect: (message: PieMessage) => void
  onPinnedSelect: (message: PieMessage) => void
  currentUserId: string
  canManageChannel: boolean
  onChannelUpdated: (channel: PieChannel) => void
  channels: PieChannel[]
  onlineUserIds: ReadonlySet<string>
  notifications: PieNotification[]
  unreadNotificationCount: number
  onSelectNotification: (notification: PieNotification) => void
  onMarkAllNotificationsRead: () => void
}

// listMembers() is the org roster, not this channel's roster. Do not present its
// size as a channel member count until a channel-scoped read model exists.
function metaLine(channel: PieChannel): string {
  if (channel.kind === 'dm') {
    return 'Direct message'
  }
  if (channel.archivedAt) {
    return translate('auto.pie.chat.ChatHeader.archived', 'Archived channel')
  }
  return channel.topic || `${channel.visibility} channel`
}

export function ChatHeader({
  channel,
  members,
  api,
  onSearchSelect,
  onPinnedSelect,
  currentUserId,
  canManageChannel,
  onChannelUpdated,
  channels,
  onlineUserIds,
  notifications,
  unreadNotificationCount,
  onSelectNotification,
  onMarkAllNotificationsRead
}: ChatHeaderProps): React.JSX.Element {
  return (
    <header className="flex h-14 shrink-0 flex-col justify-center gap-0.5 border-b border-border px-4">
      <div className="flex items-center justify-between">
        <h2 className="truncate text-sm font-medium text-foreground">
          {channel
            ? `${channel.kind === 'dm' ? '@' : '#'} ${channel.name}`
            : translate('auto.pie.chat.ChatHeader.4cdc4c7776', 'Chat')}
        </h2>
        {channel && (
          <div className="flex items-center gap-1">
            {channel.scopeType === 'meeting' && channel.scopeId && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={translate('auto.pie.chat.ChatHeader.openmeeting', 'Open meeting')}
                title={translate('auto.pie.chat.ChatHeader.openmeeting', 'Open meeting')}
                onClick={() => queuePieMeetingNavigation({ meetingId: channel.scopeId! })}
              >
                <Video />
              </Button>
            )}
            {channel.kind === 'channel' && canManageChannel && (
              <>
                {!channel.archivedAt && (
                  <ChannelMemberInvite
                    channelId={channel.id}
                    channelName={channel.name}
                    currentUserId={currentUserId}
                    members={members}
                    api={api}
                  />
                )}
                <ChannelSettingsDialog
                  channel={channel}
                  currentUserId={currentUserId}
                  members={members}
                  api={api}
                  onUpdated={onChannelUpdated}
                />
              </>
            )}
            <ChatHeaderContextControls
              key={channel.id}
              channel={channel}
              channels={channels}
              members={members}
              onlineUserIds={onlineUserIds}
              notifications={notifications}
              unreadNotificationCount={unreadNotificationCount}
              api={api}
              onSelectNotification={onSelectNotification}
              onMarkAllNotificationsRead={onMarkAllNotificationsRead}
            />
            <MessageSearch api={api} members={members} onSelect={onSearchSelect} />
            <PinsPanel
              channelId={channel.id}
              api={api}
              members={members}
              onJumpToMessage={onPinnedSelect}
            />
            <ChatNotificationSettingsDialog channel={channel} api={api} />
          </div>
        )}
      </div>
      {channel && <p className="truncate text-xs text-muted-foreground">{metaLine(channel)}</p>}
    </header>
  )
}
