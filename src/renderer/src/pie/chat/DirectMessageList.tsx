import { cn } from '@/lib/utils'
import type { PieChannel, PieChatMember } from '../../../../shared/pie-chat-contract'
import { MessageAvatar } from './MessageAvatar'
import { dmParticipantLabel } from './dm-participant-label'
import { translate } from '@/i18n/i18n'

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
  const unread = channel.unreadCount ?? 0
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
      <span
        className={cn(
          'truncate',
          muted && 'text-muted-foreground',
          unread > 0 && !active && 'font-semibold text-sidebar-foreground'
        )}
      >
        {label}
      </span>
      {unread > 0 ? (
        <span
          className="ml-auto min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[11px] font-medium text-primary-foreground"
          aria-label={translate('auto.pie.chat.DirectMessageList.9b550129b0', '{{value0}} unread', {
            value0: unread
          })}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      ) : (
        muted && (
          <span className="ml-auto text-xs text-muted-foreground" title="Muted">
            🔕
          </span>
        )
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
        {translate('auto.pie.chat.DirectMessageList.5998ec9258', 'Direct messages')}
      </p>
      {dms.length === 0 ? (
        <p className="px-2 py-1.5 text-[13px] text-muted-foreground">
          {translate('auto.pie.chat.DirectMessageList.be2afe9b07', 'No direct messages yet')}
        </p>
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
