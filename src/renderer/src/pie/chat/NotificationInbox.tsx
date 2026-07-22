import type { PieChannel, PieNotification } from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'

type NotificationInboxProps = {
  notifications: PieNotification[]
  channels: PieChannel[]
  unreadCount: number
  onSelect: (notification: PieNotification) => void
  onMarkAllRead: () => void
  surface?: 'sidebar' | 'panel'
}

// The backend feed carries no actor or message body — only a type + channel/
// message reference — so a mention reads as "Mentioned you" with the channel
// name and a relative time, not an author line.
function describe(notification: PieNotification): string {
  return notification.type === 'mention'
    ? translate('auto.pie.chat.NotificationInbox.mentionedyou', 'Mentioned you')
    : notification.type
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000000],
  ['month', 2592000000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000]
]

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) {
    return ''
  }
  const deltaMs = then - Date.now()
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(deltaMs) >= ms) {
      return formatter.format(Math.round(deltaMs / ms), unit)
    }
  }
  return formatter.format(Math.round(deltaMs / 1000), 'second')
}

export function NotificationInbox({
  notifications,
  channels,
  unreadCount,
  onSelect,
  onMarkAllRead,
  surface = 'sidebar'
}: NotificationInboxProps): React.JSX.Element {
  const channelName = (channelId: string | null): string => {
    const channel = channelId ? channels.find((item) => item.id === channelId) : undefined
    return channel ? `#${channel.name}` : 'a channel'
  }

  return (
    <div
      className={
        surface === 'sidebar'
          ? 'flex max-h-64 shrink-0 flex-col border-t border-border'
          : 'flex min-h-0 flex-1 flex-col'
      }
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {translate('auto.pie.chat.NotificationInbox.2c80f2a8e0', 'Notifications')}
        </h3>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={onMarkAllRead}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {translate('auto.pie.chat.NotificationInbox.e12c4cd18c', 'Mark all read')}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-3 scrollbar-sleek">
        {notifications.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {translate('auto.pie.chat.NotificationInbox.a9d880377a', 'No new notifications')}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {notifications.map((notification) => (
              <li key={notification.id}>
                <button
                  type="button"
                  onClick={() => onSelect(notification)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span
                    aria-hidden
                    data-unread={notification.read ? undefined : 'true'}
                    className={
                      notification.read
                        ? 'mt-1.5 size-1.5 shrink-0 rounded-full bg-transparent'
                        : 'mt-1.5 size-1.5 shrink-0 rounded-full bg-primary'
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {describe(notification)}{' '}
                      {translate('auto.pie.chat.NotificationInbox.276316e695', 'in')}{' '}
                      {channelName(notification.channelId)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {relativeTime(notification.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
