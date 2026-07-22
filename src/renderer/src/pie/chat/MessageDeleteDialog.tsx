import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

type MessageDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  requireReason?: boolean
  onConfirm: (reason?: string) => Promise<void>
}

export function MessageDeleteDialog({
  open,
  onOpenChange,
  requireReason = false,
  onConfirm
}: MessageDeleteDialogProps): React.JSX.Element {
  const [deleting, setDeleting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    if (deleting) {
      return
    }
    setDeleting(true)
    setError(null)
    try {
      await onConfirm(requireReason ? reason.trim() : undefined)
      onOpenChange(false)
      setReason('')
    } catch {
      setError(
        translate('auto.pie.chat.MessageDeleteDialog.failed', 'Could not delete this message.')
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!deleting) {
          setError(null)
          if (!next) {
            setReason('')
          }
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.pie.chat.MessageDeleteDialog.title', 'Delete message?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.pie.chat.MessageDeleteDialog.description',
              'The message will be replaced with a deleted-message marker.'
            )}
          </DialogDescription>
        </DialogHeader>
        {requireReason && (
          <div className="space-y-2">
            <Label htmlFor="message-moderation-reason">
              {translate('auto.pie.chat.MessageDeleteDialog.reason', 'Moderation reason')}
            </Label>
            <Textarea
              id="message-moderation-reason"
              value={reason}
              maxLength={500}
              placeholder={translate(
                'auto.pie.chat.MessageDeleteDialog.reasonplaceholder',
                'Explain why this message is being removed.'
              )}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.pie.chat.MessageDeleteDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={deleting || (requireReason && reason.trim().length === 0)}
            onClick={confirm}
          >
            {deleting
              ? translate('auto.pie.chat.MessageDeleteDialog.deleting', 'Deleting…')
              : translate('auto.pie.chat.MessageDeleteDialog.delete', 'Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
