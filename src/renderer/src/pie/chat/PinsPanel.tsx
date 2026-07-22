import { useCallback, useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import type {
  PieChatRendererApi,
  PieChatMember,
  PieMessage,
  PiePinnedMessage
} from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'
import { chatMemberDisplayName } from './chat-member-display-name'

type PinsPanelProps = {
  channelId: string
  api: PieChatRendererApi
  members: PieChatMember[]
  onJumpToMessage: (message: PieMessage) => void
}

export function PinsPanel({
  channelId,
  api,
  members,
  onJumpToMessage
}: PinsPanelProps): React.JSX.Element {
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
          aria-label={translate('auto.pie.chat.PinsPanel.995cea7450', 'Pinned messages')}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {translate('auto.pie.chat.PinsPanel.b411bd16ee', '📌 Pins')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2 text-sm font-medium text-foreground">
          {translate('auto.pie.chat.PinsPanel.995cea7450', 'Pinned messages')}
        </div>
        <ScrollArea className="max-h-72">
          <div className="p-1">
            {loading && pins.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                {translate('auto.pie.chat.PinsPanel.9355d14e9f', 'Loading…')}
              </p>
            ) : pins.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                {translate('auto.pie.chat.PinsPanel.d9e89d3a21', 'No pinned messages')}
              </p>
            ) : (
              pins.map((pin) => (
                <button
                  key={pin.message.id}
                  type="button"
                  onClick={() => {
                    onJumpToMessage(pin.message)
                    setOpen(false)
                  }}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  <div className="text-xs text-muted-foreground">
                    {chatMemberDisplayName(pin.message.authorId, members)}
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
