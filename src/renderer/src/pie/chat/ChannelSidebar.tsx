import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'
import { DmComposer } from './DmComposer'

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
      <span className={cn('truncate', muted && 'text-muted-foreground')}>{channel.name}</span>
      {muted && (
        <span className="ml-auto text-xs text-muted-foreground" title="Muted">
          🔕
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
        <span className="text-sm font-medium text-sidebar-foreground">Messages</span>
        <DmComposer
          members={members}
          currentUserId={currentUserId}
          api={api}
          onCreated={onChannelCreated}
        />
      </div>
      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-0.5 px-2 pb-2" aria-label="Channels">
          {loading && channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
          ) : channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No channels yet</p>
          ) : (
            <>
              <p className="px-2 pt-1 text-xs font-medium uppercase text-muted-foreground">
                Channels
              </p>
              {namedChannels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === selectedChannelId}
                  onSelect={onSelect}
                />
              ))}
              {dms.length > 0 && (
                <p className="px-2 pt-3 text-xs font-medium uppercase text-muted-foreground">
                  Direct messages
                </p>
              )}
              {dms.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  active={channel.id === selectedChannelId}
                  onSelect={onSelect}
                />
              ))}
            </>
          )}
        </nav>
      </ScrollArea>
    </div>
  )
}
