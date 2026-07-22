import { cn } from '@/lib/utils'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'

type MentionAutocompleteProps = {
  members: PieChatMember[]
  query: string
  activeIndex: number
  onSelect: (member: PieChatMember) => void
}

// Filters org members by the text typed after '@'. Rendered above the composer
// while a mention is in progress; selection is driven by keyboard or click.
export function filterMembers(members: PieChatMember[], query: string): PieChatMember[] {
  const needle = query.toLowerCase()
  return members
    .filter(
      (member) =>
        member.displayName.toLowerCase().includes(needle) ||
        member.userId.toLowerCase().includes(needle)
    )
    .slice(0, 6)
}

export function MentionAutocomplete({
  members,
  query,
  activeIndex,
  onSelect
}: MentionAutocompleteProps): React.JSX.Element | null {
  const matches = filterMembers(members, query)
  if (matches.length === 0) {
    return null
  }
  return (
    <ul
      className="mb-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md scrollbar-sleek"
      role="listbox"
      aria-label={translate('auto.pie.chat.MentionAutocomplete.dfa38ec247', 'Mention suggestions')}
    >
      {matches.map((member, index) => (
        <li key={member.userId}>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => {
              // Prevent the textarea from losing focus before we insert the mention.
              event.preventDefault()
              onSelect(member)
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground',
              index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
            )}
          >
            <span className="text-muted-foreground">@</span>
            <span className="truncate">{member.displayName}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
