import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PieMessageReaction } from '../../../../shared/pie-chat-contract'
import { translate } from '@/i18n/i18n'

// A small, fixed quick-pick set keeps the picker dependency-free (no emoji-mart)
// while covering the common acknowledgements.
const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🚀']

type ReactionBarProps = {
  reactions: PieMessageReaction[]
  onToggle: (emoji: string) => void
}

export function ReactionBar({ reactions, onToggle }: ReactionBarProps): React.JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          onClick={() => onToggle(reaction.emoji)}
          aria-pressed={reaction.reactedByMe}
          className={cn(
            'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
            reaction.reactedByMe
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border bg-muted text-muted-foreground hover:bg-accent'
          )}
        >
          <span aria-hidden>{reaction.emoji}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </button>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={translate('auto.pie.chat.ReactionBar.b1a3927f6d', 'Add reaction')}
            className="flex size-6 items-center justify-center rounded-full border border-border bg-muted text-xs text-muted-foreground hover:bg-accent"
          >
            +
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-1" align="start">
          <div className="flex gap-0.5">
            {QUICK_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onToggle(emoji)}
                aria-label={translate('auto.pie.chat.ReactionBar.ae15d47337', 'React {{value0}}', {
                  value0: emoji
                })}
                className="flex size-8 items-center justify-center rounded-md text-base hover:bg-accent"
              >
                {emoji}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
