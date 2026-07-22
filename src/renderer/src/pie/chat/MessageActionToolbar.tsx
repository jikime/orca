import {
  ClipboardPlus,
  ListTodo,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  SmilePlus,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🚀']

type MessageActionToolbarProps = {
  pinned?: boolean
  onReact: (emoji: string) => void
  onReply?: () => void
  onTogglePin?: () => void
  onCreateWorkItem?: () => void
  onAddToAgenda?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

function ActionTooltip({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function MessageActionToolbar({
  pinned = false,
  onReact,
  onReply,
  onTogglePin,
  onCreateWorkItem,
  onAddToAgenda,
  onEdit,
  onDelete
}: MessageActionToolbarProps): React.JSX.Element {
  const reactLabel = translate('auto.pie.chat.MessageTimeline.61bb0789a8', 'React')
  const pinLabel = pinned
    ? translate('auto.pie.chat.MessageTimeline.unpin', 'Unpin')
    : translate('auto.pie.chat.MessageTimeline.pin', 'Pin')

  return (
    // Pointer devices get Slack-style hover disclosure; touch devices keep the
    // toolbar in the row because they have no hover state to reveal it.
    <div
      data-slot="message-action-toolbar"
      role="toolbar"
      aria-label={translate('auto.pie.chat.MessageActionToolbar.actions', 'Message actions')}
      className="z-10 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 text-popover-foreground shadow-xs transition-opacity can-hover:pointer-events-none can-hover:absolute can-hover:right-2 can-hover:top-0 can-hover:-translate-y-1/2 can-hover:opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100"
    >
      <Popover>
        <ActionTooltip label={reactLabel}>
          <PopoverTrigger asChild>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={reactLabel}>
              <SmilePlus />
            </Button>
          </PopoverTrigger>
        </ActionTooltip>
        <PopoverContent className="w-auto p-1" align="end">
          <div className="flex gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(emoji)}
                aria-label={translate('auto.pie.chat.ReactionBar.ae15d47337', 'React {{value0}}', {
                  value0: emoji
                })}
                className="flex size-8 items-center justify-center rounded-md text-base hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {onReply && (
        <ActionTooltip label={translate('auto.pie.chat.MessageTimeline.79541c630f', 'Reply')}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={translate('auto.pie.chat.MessageTimeline.79541c630f', 'Reply')}
            onClick={onReply}
          >
            <MessageSquareReply />
          </Button>
        </ActionTooltip>
      )}

      {onTogglePin && (
        <ActionTooltip label={pinLabel}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={pinLabel}
            aria-pressed={pinned}
            onClick={onTogglePin}
          >
            {pinned ? <PinOff /> : <Pin />}
          </Button>
        </ActionTooltip>
      )}

      {onCreateWorkItem && (
        <ActionTooltip
          label={translate('auto.pie.chat.MessageActionToolbar.workItem', 'Work item')}
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={translate('auto.pie.chat.MessageActionToolbar.workItem', 'Work item')}
            onClick={onCreateWorkItem}
          >
            <ListTodo />
          </Button>
        </ActionTooltip>
      )}

      {onAddToAgenda && (
        <ActionTooltip
          label={translate('auto.pie.chat.MessageActionToolbar.addagenda', 'Add to agenda')}
        >
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={translate('auto.pie.chat.MessageActionToolbar.addagenda', 'Add to agenda')}
            onClick={onAddToAgenda}
          >
            <ClipboardPlus />
          </Button>
        </ActionTooltip>
      )}

      {onEdit && (
        <ActionTooltip label={translate('auto.pie.chat.MessageTimeline.edit', 'Edit')}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={translate('auto.pie.chat.MessageTimeline.edit', 'Edit')}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        </ActionTooltip>
      )}

      {onDelete && (
        <ActionTooltip label={translate('auto.pie.chat.MessageTimeline.delete', 'Delete')}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label={translate('auto.pie.chat.MessageTimeline.delete', 'Delete')}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </ActionTooltip>
      )}
    </div>
  )
}
