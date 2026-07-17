import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  PieChannel,
  PieChatMember,
  PieChatRendererApi
} from '../../../../shared/pie-chat-contract'

type DmComposerProps = {
  members: PieChatMember[]
  currentUserId: string
  api: PieChatRendererApi
  onCreated: (channel: PieChannel) => void
}

// One entry point for the three creation flows: a named channel, a 1:1 DM, or a
// group DM (2+ members). Members drive DM selection; channel needs only a name.
export function DmComposer({
  members,
  currentUserId,
  api,
  onCreated
}: DmComposerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectable = members.filter((member) => member.userId !== currentUserId)

  const finish = (channel: PieChannel): void => {
    onCreated(channel)
    setOpen(false)
    setChannelName('')
    setSelected([])
    setError(null)
  }

  const run = async (action: () => Promise<PieChannel>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      finish(await action())
    } catch {
      setError('Could not create')
    } finally {
      setBusy(false)
    }
  }

  const createChannel = (): Promise<void> => run(() => api.createChannel(channelName.trim()))
  const createDm = (): Promise<void> => {
    if (selected.length === 1) {
      return run(() => api.createDm(selected[0]))
    }
    return run(() => api.createGroupDm(selected))
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="New channel or DM"
          className="rounded-md px-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
        >
          +
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New channel or DM</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">Channel</label>
            <div className="flex gap-2">
              <Input
                value={channelName}
                onChange={(event) => setChannelName(event.target.value)}
                placeholder="channel-name"
                aria-label="New channel name"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy || channelName.trim().length === 0}
                onClick={() => void createChannel()}
              >
                Create
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground">
              Direct message ({selected.length} selected)
            </label>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border">
              {selectable.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">No other members</p>
              ) : (
                selectable.map((member) => {
                  const on = selected.includes(member.userId)
                  return (
                    <button
                      key={member.userId}
                      type="button"
                      onClick={() =>
                        setSelected((current) =>
                          on
                            ? current.filter((id) => id !== member.userId)
                            : [...current, member.userId]
                        )
                      }
                      className={cn(
                        'flex w-full items-center justify-between px-2 py-1.5 text-left text-sm',
                        on ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
                      )}
                    >
                      <span className="truncate">@{member.displayName}</span>
                      {on && <span aria-hidden>✓</span>}
                    </button>
                  )
                })
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || selected.length === 0}
              onClick={() => void createDm()}
            >
              {selected.length > 1 ? 'Start group DM' : 'Start DM'}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
