import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { PieChatMember } from '../../../../shared/pie-chat-contract'
import { MessageAvatar } from './MessageAvatar'

type MemberRosterProps = {
  members: PieChatMember[]
  // Org-wide online user ids from realtime presence; absent members read offline.
  onlineUserIds: ReadonlySet<string>
}

export function MemberRoster({ members, onlineUserIds }: MemberRosterProps): React.JSX.Element {
  const onlineCount = members.filter((member) => onlineUserIds.has(member.userId)).length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Members · {onlineCount}/{members.length} online
      </h3>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
        {members.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No members found</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {members.map((member) => {
              const online = onlineUserIds.has(member.userId)
              return (
                <li key={member.userId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                  <span className="relative">
                    <MessageAvatar label={member.displayName} size="sm" />
                    <span
                      aria-hidden
                      className={cn(
                        'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background',
                        online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                      )}
                    />
                  </span>
                  <span
                    className={cn(
                      'truncate text-sm',
                      online ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {member.displayName}
                  </span>
                  <span className="sr-only">{online ? 'online' : 'offline'}</span>
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
