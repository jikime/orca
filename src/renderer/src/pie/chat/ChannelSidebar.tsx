import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'
import { DmComposer } from './DmComposer'
import { DirectMessageList } from './DirectMessageList'
import { translate } from '@/i18n/i18n'
import { Archive, BellOff } from 'lucide-react'

type ChannelSidebarProps = {
  channels: PieChannel[]
  members: PieChatMember[]
  selectedChannelId: string | null
  loading: boolean
  currentUserId: string
  api: PieChatRendererApi
  onSelect: (channelId: string) => void
  onChannelCreated: (channel: PieChannel) => void
}

type ChannelRowProps = {
  channel: PieChannel
  active: boolean
  onSelect: (channelId: string) => void
}

function ChannelRow({ channel, active, onSelect }: ChannelRowProps): React.JSX.Element {
  const muted = (channel as { muted?: boolean }).muted === true
  const unread = channel.unreadCount ?? 0
  return (
    <button
      type="button"
      onClick={() => onSelect(channel.id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      )}
    >
      <span className="text-muted-foreground">{channel.kind === 'dm' ? '@' : '#'}</span>
      <span
        className={cn(
          'truncate',
          muted && 'text-muted-foreground',
          unread > 0 && !active && 'font-semibold text-sidebar-foreground'
        )}
      >
        {channel.name}
      </span>
      {unread > 0 ? (
        <span
          className="ml-auto min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[11px] font-medium text-primary-foreground"
          aria-label={translate('auto.pie.chat.ChannelSidebar.332167b29c', '{{value0}} unread', {
            value0: unread
          })}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      ) : (
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          {channel.archivedAt && (
            <Archive
              className="size-3"
              aria-label={translate('auto.pie.chat.ChannelSidebar.archived', 'Archived')}
            />
          )}
          {muted && (
            <BellOff
              className="size-3"
              aria-label={translate('auto.pie.chat.ChannelSidebar.muted', 'Muted')}
            />
          )}
        </span>
      )}
    </button>
  )
}

export function ChannelSidebar({
  channels,
  members,
  selectedChannelId,
  loading,
  currentUserId,
  api,
  onSelect,
  onChannelCreated
}: ChannelSidebarProps): React.JSX.Element {
  const namedChannels = channels.filter((channel) => channel.kind !== 'dm')
  const dms = channels.filter((channel) => channel.kind === 'dm')

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-sidebar">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-medium text-sidebar-foreground">
          {translate('auto.pie.chat.ChannelSidebar.d4b567493d', 'Messages')}
        </span>
        <DmComposer
          members={members}
          currentUserId={currentUserId}
          api={api}
          onCreated={onChannelCreated}
        />
      </div>
      <ScrollArea className="flex-1">
        <nav
          className="flex flex-col gap-0.5 px-2 pb-2"
          aria-label={translate('auto.pie.chat.ChannelSidebar.5855bc71db', 'Channels')}
        >
          {loading && channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {translate('auto.pie.chat.ChannelSidebar.7dad5ec92e', 'Loading…')}
            </p>
          ) : channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {translate('auto.pie.chat.ChannelSidebar.28a333bc28', 'No channels yet')}
            </p>
          ) : (
            <>
              <p className="px-2 pt-1 text-xs font-medium uppercase text-muted-foreground">
                {translate('auto.pie.chat.ChannelSidebar.5855bc71db', 'Channels')}
              </p>
              {namedChannels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === selectedChannelId}
                  onSelect={onSelect}
                />
              ))}
              <DirectMessageList
                dms={dms}
                members={members}
                currentUserId={currentUserId}
                selectedChannelId={selectedChannelId}
                onSelect={onSelect}
              />
            </>
          )}
        </nav>
      </ScrollArea>
    </div>
  )
}
