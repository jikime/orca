import type { TimelineMessage } from './use-pie-chat'

type NotificationInboxProps = {
  messages: TimelineMessage[]
  currentUserId: string
  currentUserDisplayName: string
}

// There is no notifications-feed endpoint in the chat contract. The composer
// writes a mention into the body as literal '@DisplayName' text (mentions are
// not returned on the message resource — see MessageBody), so scanning the
// already-loaded timeline for that text is the only real "did someone mention
// me" signal available without a new fetch. This only covers the currently
// open channel's loaded messages, not a cross-channel notification feed.
function mentionsMe(message: TimelineMessage, displayName: string, currentUserId: string): boolean {
  if (message.authorId === currentUserId || message.deleted) {
    return false
  }
  return message.body.includes(`@${displayName}`)
}

export function NotificationInbox({
  messages,
  currentUserId,
  currentUserDisplayName
}: NotificationInboxProps): React.JSX.Element {
  const mentions = messages
    .filter((message) => mentionsMe(message, currentUserDisplayName, currentUserId))
    .slice(-5)
    .toReversed()

  return (
    <div className="flex max-h-64 shrink-0 flex-col border-t border-border">
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Notifications
      </h3>
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {mentions.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No new notifications</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {mentions.map((message) => (
              <li key={message.optimisticId ?? message.id} className="rounded-md px-2 py-1.5">
                <p className="truncate text-xs text-muted-foreground">
                  {message.authorId.slice(0, 8)} mentioned you
                </p>
                <p className="truncate text-sm text-foreground">{message.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
