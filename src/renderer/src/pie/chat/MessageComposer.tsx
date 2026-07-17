import { useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type MessageComposerProps = {
  disabled: boolean
  sending: boolean
  onSend: (body: string) => void | Promise<void>
}

export function MessageComposer({
  disabled,
  sending,
  onSend
}: MessageComposerProps): React.JSX.Element {
  const [value, setValue] = useState('')
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
      <div className="flex items-end gap-2">
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder="Write a message…"
          aria-label="Message"
          className={cn(
            'flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground',
            'placeholder:text-muted-foreground outline-none transition-[color,box-shadow]',
            'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
        <Button type="button" size="sm" onClick={submit} disabled={!canSend}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  )
}
