import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import type { TimelineMessage } from './use-pie-chat'
import { MemberRoster } from './MemberRoster'
import { NotificationInbox } from './NotificationInbox'

type ContextSidebarProps = {
  members: PieChatMember[]
  messages: TimelineMessage[]
  currentUserId: string
  currentUserDisplayName: string
}

// The right column of the 3-column layout: the workspace roster on top, a
// truthful mentions-derived inbox below (see NotificationInbox for the source).
export function ContextSidebar({
  members,
  messages,
  currentUserId,
  currentUserDisplayName
}: ContextSidebarProps): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-background">
      <MemberRoster members={members} />
      <NotificationInbox
        messages={messages}
        currentUserId={currentUserId}
        currentUserDisplayName={currentUserDisplayName}
      />
    </div>
  )
}
