import { cn } from '@/lib/utils'
import type { PieChannel, PieChatMember } from '../../../../shared/pie-chat-contract'
import { MessageAvatar } from './MessageAvatar'
import { dmParticipantLabel } from './dm-participant-label'

type DirectMessageListProps = {
  dms: PieChannel[]
  members: PieChatMember[]
  currentUserId: string
  selectedChannelId: string | null
  onSelect: (channelId: string) => void
}

type DirectMessageRowProps = {
  channel: PieChannel
  label: string
  active: boolean
  onSelect: (channelId: string) => void
}

function DirectMessageRow({
  channel,
  label,
  active,
  onSelect
}: DirectMessageRowProps): React.JSX.Element {
  const muted = (channel as { muted?: boolean }).muted === true
  return (
    <button
      type="button"
      onClick={() => onSelect(channel.id)}
      aria-current={active ? 'true' : undefined}
      // STYLEGUIDE: a persistent active row carries data-current in addition to
      // the accent background, to distinguish it from a transient cmdk highlight.
      data-current={active ? 'true' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-sidebar-foreground transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      )}
    >
      <MessageAvatar label={label} size="sm" />
      <span className={cn('truncate', muted && 'text-muted-foreground')}>{label}</span>
      {muted && (
        <span className="ml-auto text-xs text-muted-foreground" title="Muted">
          🔕
        </span>
      )}
    </button>
  )
}

// The DM section of the chat sidebar: one row per DM conversation, labelled by
// the other participant. Kept separate from the channel nav so its avatar rows
// and participant resolution don't complicate the plain #channel list.
export function DirectMessageList({
  dms,
  members,
  currentUserId,
  selectedChannelId,
  onSelect
}: DirectMessageListProps): React.JSX.Element {
  return (
    <>
      <p className="px-2 pt-3 text-xs font-medium uppercase text-muted-foreground">
        Direct messages
      </p>
      {dms.length === 0 ? (
        <p className="px-2 py-1.5 text-[13px] text-muted-foreground">No direct messages yet</p>
      ) : (
        dms.map((channel) => (
          <DirectMessageRow
            key={channel.id}
            channel={channel}
            label={dmParticipantLabel(channel, members, currentUserId)}
            active={channel.id === selectedChannelId}
            onSelect={onSelect}
          />
        ))
      )}
    </>
  )
}
