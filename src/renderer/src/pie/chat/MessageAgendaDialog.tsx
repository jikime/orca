import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { apiPostWithIdempotencyKey, PieApiError } from '../control-plane/pie-api-client'
import { queuePieMeetingNavigation } from '../meetings/pie-meeting-navigation'
import type { TimelineMessage } from './pie-chat-controller'

type MeetingAgendaItem = { id: string; body: string }

export function MessageAgendaDialog({
  open,
  onOpenChange,
  meetingId,
  channelId,
  message
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meetingId: string
  channelId: string
  message: TimelineMessage | null
}): React.JSX.Element {
  const [created, setCreated] = useState<MeetingAgendaItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const idempotencyKey = useRef(globalThis.crypto.randomUUID())

  useEffect(() => {
    if (!open) {
      return
    }
    setCreated(null)
    setError(null)
    idempotencyKey.current = globalThis.crypto.randomUUID()
  }, [message?.id, open])

  const create = async (): Promise<void> => {
    if (!meetingId || !channelId || !message) {
      return
    }
    setCreating(true)
    setError(null)
    try {
      setCreated(
        await apiPostWithIdempotencyKey<MeetingAgendaItem>(
          `/meetings/${meetingId}/agenda-items`,
          { sourceChannelId: channelId, sourceMessageId: message.id },
          idempotencyKey.current
        )
      )
    } catch (caught) {
      setError(
        caught instanceof PieApiError
          ? `${caught.code ?? caught.status}: ${caught.message}`
          : translate(
              'auto.pie.chat.MessageAgendaDialog.createfailed',
              'Could not add the message to the agenda.'
            )
      )
    } finally {
      setCreating(false)
    }
  }

  const openMeeting = (): void => {
    onOpenChange(false)
    queuePieMeetingNavigation({ meetingId })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.chat.MessageAgendaDialog.title', 'Add to meeting agenda')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.pie.chat.MessageAgendaDialog.description',
              'Keep this message as a linked agenda item for the meeting.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground scrollbar-sleek">
          {created?.body ?? message?.body}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {created ? (
            <Button type="button" onClick={openMeeting}>
              {translate('auto.pie.chat.MessageAgendaDialog.openmeeting', 'Open meeting')}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {translate('auto.pie.chat.MessageAgendaDialog.cancel', 'Cancel')}
              </Button>
              <Button type="button" disabled={creating || !message} onClick={() => void create()}>
                {creating
                  ? translate('auto.pie.chat.MessageAgendaDialog.adding', 'Adding…')
                  : translate('auto.pie.chat.MessageAgendaDialog.add', 'Add to agenda')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
