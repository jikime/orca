import { useCallback, useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { PieChatRendererApi, PiePinnedMessage } from '../../../../shared/pie-chat-contract'

type PinsPanelProps = {
  channelId: string
  api: PieChatRendererApi
  onJumpToMessage: (messageId: string) => void
}

export function PinsPanel({ channelId, api, onJumpToMessage }: PinsPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pins, setPins] = useState<PiePinnedMessage[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setPins(await api.listPins(channelId))
    } finally {
      setLoading(false)
    }
  }, [api, channelId])

  // Refetch each time the popover opens so a just-pinned message shows up.
  useEffect(() => {
    if (open) {
      void load()
    }
  }, [open, load])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Pinned messages"
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          📌 Pins
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2 text-sm font-medium text-foreground">
          Pinned messages
        </div>
        <ScrollArea className="max-h-72">
          <div className="p-1">
            {loading && pins.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
            ) : pins.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">No pinned messages</p>
            ) : (
              pins.map((pin) => (
                <button
                  key={pin.message.id}
                  type="button"
                  onClick={() => {
                    onJumpToMessage(pin.message.id)
                    setOpen(false)
                  }}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <div className="text-xs text-muted-foreground">
                    {pin.message.authorId.slice(0, 8)}
                  </div>
                  <div className="truncate text-sm text-foreground">{pin.message.body}</div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
