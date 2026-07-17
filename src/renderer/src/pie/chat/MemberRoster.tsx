import { ScrollArea } from '@/components/ui/scroll-area'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { MessageAvatar } from './MessageAvatar'

type MemberRosterProps = {
  members: PieChatMember[]
}

// No presence signal (online/away/offline) is exposed to the renderer today —
// use-pie-chat carries no such field — so members render with no status dot
// rather than a fabricated one, per the truthfulness constraint.
export function MemberRoster({ members }: MemberRosterProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Members · {members.length}
      </h3>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
        {members.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No members found</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {members.map((member) => (
              <li key={member.userId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <MessageAvatar label={member.displayName} size="sm" />
                <span className="truncate text-sm text-foreground">{member.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
