import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { PieChannel } from '../../../../shared/pie-chat-contract'

type ChannelSidebarProps = {
  channels: PieChannel[]
  selectedChannelId: string | null
  loading: boolean
  onSelect: (channelId: string) => void
}

function channelPrefix(channel: PieChannel): string {
  return channel.kind === 'dm' ? '@' : '#'
}

export function ChannelSidebar({
  channels,
  selectedChannelId,
  loading,
  onSelect
}: ChannelSidebarProps): React.JSX.Element {
  return (
    <div className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="px-4 py-3 text-sm font-medium text-sidebar-foreground">Channels</div>
      <ScrollArea className="flex-1">
        <nav className="flex flex-col gap-0.5 px-2 pb-2" aria-label="Channels">
          {loading && channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
          ) : channels.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No channels yet</p>
          ) : (
            channels.map((channel) => {
              const active = channel.id === selectedChannelId
              return (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => onSelect(channel.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground transition-colors',
                    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                    active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  )}
                >
                  <span className="text-muted-foreground">{channelPrefix(channel)}</span>
                  <span className="truncate">{channel.name}</span>
                </button>
              )
            })
          )}
        </nav>
      </ScrollArea>
    </div>
  )
}
