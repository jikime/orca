import { useState } from 'react'
import { Check, ChevronsUpDown, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export type MeetingMember = {
  userId: string
  displayName: string
  status: string
}

export function MeetingMemberPicker({
  members,
  excludedUserIds,
  disabled,
  onSelect
}: {
  members: MeetingMember[]
  excludedUserIds: ReadonlySet<string>
  disabled: boolean
  onSelect: (member: MeetingMember) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const available = members.filter(
    (member) => member.status === 'active' && !excludedUserIds.has(member.userId)
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-between"
          disabled={disabled}
          aria-expanded={open}
        >
          <span className="flex min-w-0 items-center gap-2">
            <UserPlus />
            <span className="truncate">
              {translate(
                'auto.pie.meetings.MeetingMemberPicker.placeholder',
                'Search organization members'
              )}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0">
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.pie.meetings.MeetingMemberPicker.search',
              'Search by name or user ID…'
            )}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.pie.meetings.MeetingMemberPicker.empty',
                'No available members found.'
              )}
            </CommandEmpty>
            {available.map((member) => (
              <CommandItem
                key={member.userId}
                value={`${member.displayName} ${member.userId}`}
                onSelect={() => {
                  onSelect(member)
                  setOpen(false)
                }}
              >
                <Check className={cn('size-3.5 opacity-0')} />
                <span className="min-w-0 flex-1 truncate">{member.displayName}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {member.userId.slice(0, 8)}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
