import { translate } from '@/i18n/i18n'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'

type TypingIndicatorProps = {
  typingUserIds: string[]
  members: PieChatMember[]
}

// The line above the composer showing who is typing in the active channel. Renders
// a fixed-height row (even when empty) so the timeline doesn't jump as it appears.
export function TypingIndicator({
  typingUserIds,
  members
}: TypingIndicatorProps): React.JSX.Element {
  const names = typingUserIds.map(
    (id) =>
      members.find((member) => member.userId === id)?.displayName ??
      translate('auto.pie.chat.TypingIndicator.someone', 'Someone')
  )
  const label =
    names.length === 0
      ? ''
      : names.length === 1
        ? `${names[0]} is typing…`
        : names.length === 2
          ? `${names[0]} and ${names[1]} are typing…`
          : `${names.length} people are typing…`
  return (
    <div className="h-5 px-4 text-xs text-muted-foreground" aria-live="polite">
      {label}
    </div>
  )
}
