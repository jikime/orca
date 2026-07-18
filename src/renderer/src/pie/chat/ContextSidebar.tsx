import type {
  PieChannel,
  PieChatMember,
  PieNotification
} from '../../../../shared/pie-chat-contract'
import { MemberRoster } from './MemberRoster'
import { NotificationInbox } from './NotificationInbox'

type ContextSidebarProps = {
  members: PieChatMember[]
  channels: PieChannel[]
  notifications: PieNotification[]
  unreadNotificationCount: number
  onSelectNotification: (notification: PieNotification) => void
  onMarkAllNotificationsRead: () => void
}

// The right column of the 3-column layout: the workspace roster on top, the real
// per-user notification feed (see NotificationInbox) below.
export function ContextSidebar({
  members,
  channels,
  notifications,
  unreadNotificationCount,
  onSelectNotification,
  onMarkAllNotificationsRead
}: ContextSidebarProps): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <MemberRoster members={members} />
      <NotificationInbox
        notifications={notifications}
        channels={channels}
        unreadCount={unreadNotificationCount}
        onSelect={onSelectNotification}
        onMarkAllRead={onMarkAllNotificationsRead}
      />
    </div>
  )
}
