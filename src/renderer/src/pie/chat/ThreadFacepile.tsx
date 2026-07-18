import { translate } from '@/i18n/i18n'
type ThreadFacepileProps = {
  replyCount: number
  onOpen: () => void
}

// Reply participant ids are not returned on the message resource (only a
// replyCount), so a real facepile of stacked participant avatars is not
// cheaply available without a per-message fetch. Showing the count only
// avoids either an expensive per-row fetch or inventing participants.
export function ThreadFacepile({
  replyCount,
  onOpen
}: ThreadFacepileProps): React.JSX.Element | null {
  if (replyCount <= 0) {
    return null
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1 flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      <span aria-hidden>💬</span>
      {replyCount}{' '}
      {replyCount === 1
        ? translate('auto.pie.chat.ThreadFacepile.6173a7a63e', 'reply')
        : translate('auto.pie.chat.ThreadFacepile.d3d50882be', 'replies')}
    </button>
  )
}
