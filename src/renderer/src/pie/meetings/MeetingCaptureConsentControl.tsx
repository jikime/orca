import { useMemo, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { apiPatch, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingCaptureConsent, MeetingCaptureType, MeetingParticipant } from './meeting-types'

function captureLabel(captureType: MeetingCaptureType): string {
  switch (captureType) {
    case 'recording':
      return translate('auto.pie.meetings.captureConsent.recording', 'Video and audio recording')
    case 'transcription':
      return translate('auto.pie.meetings.captureConsent.transcription', 'Speech transcription')
    case 'ai_notes':
      return translate('auto.pie.meetings.captureConsent.aiNotes', 'AI meeting notes')
    case 'presentation_screenshot':
      return translate(
        'auto.pie.meetings.captureConsent.presentationScreenshots',
        'Presentation screenshots'
      )
  }
}

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingCaptureConsentControl({
  meetingId,
  participant,
  disabled,
  onChanged
}: {
  meetingId: string
  participant: MeetingParticipant
  disabled: boolean
  onChanged: () => void
}): React.JSX.Element {
  const resource = usePieResource<{ items: MeetingCaptureConsent[] }>(
    `/meetings/${meetingId}/capture-consents`
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const consents = useMemo(
    () => (resource.data?.items ?? []).filter((item) => item.participantId === participant.id),
    [participant.id, resource.data]
  )
  const granted = consents.filter((item) => item.status === 'granted' && item.currentPolicy).length

  const update = async (consent: MeetingCaptureConsent, checked: boolean): Promise<void> => {
    setBusyId(consent.id)
    setError(null)
    try {
      await apiPatch(
        `/meeting-capture-consents/${consent.id}`,
        { status: checked ? 'granted' : 'revoked' },
        resourceEtag('meeting-capture-consent', consent.version)
      )
      resource.refetch()
      onChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <ShieldCheck />
          {translate(
            'auto.pie.meetings.captureConsent.button',
            'Capture permissions {{value0}}/4',
            { value0: granted }
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.pie.meetings.captureConsent.title', 'Meeting capture permissions')}
          </DialogTitle>
          <DialogDescription>
            {consents[0]?.purpose ??
              translate(
                'auto.pie.meetings.captureConsent.description',
                'Choose which processing purposes you allow for this meeting.'
              )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {consents.map((consent) => {
            const checked = consent.status === 'granted' && consent.currentPolicy
            return (
              <label
                key={consent.id}
                className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5"
              >
                <Checkbox
                  checked={checked}
                  disabled={busyId !== null}
                  onCheckedChange={(value) => void update(consent, value === true)}
                />
                <span className="min-w-0 flex-1 text-sm text-foreground">
                  {captureLabel(consent.captureType)}
                </span>
                {!consent.currentPolicy && (
                  <Badge variant="outline">
                    {translate('auto.pie.meetings.captureConsent.renew', 'Review again')}
                  </Badge>
                )}
              </label>
            )
          })}
          {resource.loading && (
            <p className="text-xs text-muted-foreground">
              {translate('auto.pie.meetings.captureConsent.loading', 'Loading permissions…')}
            </p>
          )}
          {(error || resource.error) && (
            <p className="text-xs text-destructive">{error ?? resource.error}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
