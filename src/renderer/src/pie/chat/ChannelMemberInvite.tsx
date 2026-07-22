import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import type { PieChatMember, PieChatRendererApi } from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'

type ChannelMemberInviteProps = {
  channelId: string
  channelName: string
  currentUserId: string
  members: PieChatMember[]
  api: PieChatRendererApi
}

export function ChannelMemberInvite({
  channelId,
  channelName,
  currentUserId,
  members,
  api
}: ChannelMemberInviteProps): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const candidates = members.filter((member) => member.userId !== currentUserId)

  const add = async (userId: string): Promise<void> => {
    setBusyId(userId)
    setError(null)
    try {
      await api.addChannelMember(channelId, userId)
      setAddedIds((current) => new Set([...current, userId]))
    } catch {
      setError(
        translate(
          'auto.pie.chat.ChannelMemberInvite.failed',
          'Could not add this person to the channel.'
        )
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <UserPlus className="size-4" />
          {translate('auto.pie.chat.ChannelMemberInvite.addpeople', 'Add people')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.chat.ChannelMemberInvite.title', 'Add people')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.chat.ChannelMemberInvite.description',
              'Choose organization members to add to #{{value0}}.',
              { value0: channelName }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-sleek">
          {candidates.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              {translate('auto.pie.chat.ChannelMemberInvite.empty', 'No other members')}
            </p>
          ) : (
            candidates.map((member) => {
              const added = addedIds.has(member.userId)
              return (
                <div
                  key={member.userId}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <span className="min-w-0 truncate text-sm text-foreground">
                    {member.displayName}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={added || busyId !== null}
                    onClick={() => void add(member.userId)}
                  >
                    {added
                      ? translate('auto.pie.chat.ChannelMemberInvite.added', 'Added')
                      : busyId === member.userId
                        ? translate('auto.pie.chat.ChannelMemberInvite.adding', 'Adding…')
                        : translate('auto.pie.chat.ChannelMemberInvite.add', 'Add')}
                  </Button>
                </div>
              )
            })
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
