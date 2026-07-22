import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

type MessageEditFormProps = {
  initialBody: string
  onCancel: () => void
  onSave: (body: string) => Promise<void>
}

export function MessageEditForm({
  initialBody,
  onCancel,
  onSave
}: MessageEditFormProps): React.JSX.Element {
  const [body, setBody] = useState(initialBody)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const trimmed = body.trim()

  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  const save = async (): Promise<void> => {
    if (saving || trimmed.length === 0 || trimmed === initialBody.trim()) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed)
    } catch {
      // Why: an OCC conflict must preserve the draft so the author can reconcile
      // it with the newer server version instead of losing their edit.
      setError(
        translate(
          'auto.pie.chat.MessageEditForm.savefailed',
          'Could not save. Refresh the conversation and try again.'
        )
      )
      setSaving(false)
    }
  }

  return (
    <div className="mt-1 space-y-2">
      <Textarea
        ref={textareaRef}
        value={body}
        disabled={saving}
        aria-label={translate('auto.pie.chat.MessageEditForm.editmessage', 'Edit message')}
        aria-invalid={error ? true : undefined}
        className="min-h-20 resize-y text-sm"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void save()
          }
        }}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={saving || trimmed.length === 0} onClick={save}>
          {saving
            ? translate('auto.pie.chat.MessageEditForm.saving', 'Saving…')
            : translate('auto.pie.chat.MessageEditForm.save', 'Save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {translate('auto.pie.chat.MessageEditForm.cancel', 'Cancel')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.pie.chat.MessageEditForm.hint',
            'Enter to save · Shift+Enter for a new line · Esc to cancel'
          )}
        </span>
      </div>
    </div>
  )
}
