import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { ComposerToolbar } from './ComposerToolbar'
import { useComposerTextareaAutogrow } from './use-composer-textarea-autogrow'

type MessageComposerProps = {
  disabled: boolean
  sending: boolean
  onSend: (body: string) => void | Promise<void>
}

// Thread replies have no attachments or mentions, so this stays a sibling of
// ChannelComposer's container/toolbar shape (STYLEGUIDE "sibling components")
// without inventing left-side controls that would do nothing.
export function MessageComposer({
  disabled,
  sending,
  onSend
}: MessageComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const textareaRef = useComposerTextareaAutogrow(value)
  const canSend = value.trim().length > 0 && !disabled && !sending

  const submit = (): void => {
    if (!canSend) {
      return
    }
    void onSend(value)
    setValue('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline. No modifier shortcut, so this
    // stays identical across macOS, Linux, and Windows.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div
        className={cn(
          'flex flex-col rounded-md border border-input bg-background transition-[color,box-shadow]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50'
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="Write a message…"
          aria-label="Message"
          className={cn(
            'w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm text-foreground',
            'placeholder:text-muted-foreground outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
        <ComposerToolbar canSend={canSend} sending={sending} onSend={submit} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  )
}
