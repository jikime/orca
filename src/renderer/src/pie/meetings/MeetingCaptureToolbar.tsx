import { useState } from 'react'
import { CircleStop, Pause, Play, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { apiPost } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { isMeetingCaptureReady } from './meeting-capture-readiness'
import type {
  MeetingCaptureConsent,
  MeetingCaptureType,
  MeetingGovernance,
  MeetingRecording
} from './meeting-types'

type RecordingCaptureType = Extract<MeetingCaptureType, 'recording' | 'transcription' | 'ai_notes'>

export function MeetingCaptureToolbar({
  meetingId,
  live,
  joinedParticipantIds,
  active,
  busy,
  mutate
}: {
  meetingId: string
  live: boolean
  joinedParticipantIds: string[]
  active: MeetingRecording | undefined
  busy: boolean
  mutate: (action: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const consents = usePieResource<{ items: MeetingCaptureConsent[] }>(
    `/meetings/${meetingId}/capture-consents`
  )
  const governance = usePieResource<MeetingGovernance>(`/meetings/${meetingId}/governance`)
  const [captureTypes, setCaptureTypes] = useState<RecordingCaptureType[]>([
    'recording',
    'transcription',
    'ai_notes'
  ])
  const setTranscription = (checked: boolean): void => {
    setCaptureTypes((current) => {
      if (checked) {
        return current.includes('transcription') ? current : [...current, 'transcription']
      }
      return current.filter((type) => type !== 'transcription' && type !== 'ai_notes')
    })
  }

  const setAiNotes = (checked: boolean): void => {
    setCaptureTypes((current) => {
      if (checked) {
        const withTranscript: RecordingCaptureType[] = current.includes('transcription')
          ? current
          : [...current, 'transcription']
        return withTranscript.includes('ai_notes')
          ? withTranscript
          : [...withTranscript, 'ai_notes']
      }
      return current.filter((type) => type !== 'ai_notes')
    })
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    await mutate(action)
    consents.refetch()
    governance.refetch()
  }

  const paused = governance.data?.captureStatus === 'paused'
  const resumeCaptureTypes = (governance.data?.activeCaptureTypes ?? []).filter(
    (type): type is RecordingCaptureType =>
      type === 'recording' || type === 'transcription' || type === 'ai_notes'
  )
  // Resume validates the capture purposes that were active before pause, not the new-session picker.
  const readinessCaptureTypes = paused ? resumeCaptureTypes : captureTypes
  const ready = isMeetingCaptureReady(
    joinedParticipantIds,
    readinessCaptureTypes,
    consents.data?.items ?? []
  )

  return (
    <div className="space-y-2.5">
      {!active && live && !paused && (
        <div className="flex flex-wrap gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
          <label className="flex items-center gap-2">
            <Checkbox checked disabled />
            {translate('auto.pie.meetings.capture.recording', 'Recording')}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={captureTypes.includes('transcription')}
              onCheckedChange={(value) => setTranscription(value === true)}
            />
            {translate('auto.pie.meetings.capture.transcription', 'Transcript')}
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={captureTypes.includes('ai_notes')}
              onCheckedChange={(value) => setAiNotes(value === true)}
            />
            {translate('auto.pie.meetings.capture.aiNotes', 'AI notes')}
          </label>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!active && live && !paused && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !ready}
            onClick={() =>
              void run(() => apiPost(`/meetings/${meetingId}/recordings`, { captureTypes }))
            }
          >
            <Radio />
            {translate('auto.pie.meetings.MeetingRecordingPanel.start', 'Start recording')}
          </Button>
        )}
        {active && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => apiPost(`/meetings/${meetingId}/capture/pause`))}
          >
            <Pause />
            {translate('auto.pie.meetings.capture.pause', 'Pause')}
          </Button>
        )}
        {paused && live && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !ready}
            onClick={() => void run(() => apiPost(`/meetings/${meetingId}/capture/resume`))}
          >
            <Play />
            {translate('auto.pie.meetings.capture.resume', 'Resume')}
          </Button>
        )}
        {active && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run(() => apiPost(`/meeting-recordings/${active.id}:stop`))}
          >
            <CircleStop />
            {translate('auto.pie.meetings.MeetingRecordingPanel.stop', 'Stop')}
          </Button>
        )}
      </div>
      {live && !ready && !active && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.pie.meetings.capture.consentRequired',
            'Every connected participant must allow each selected capture purpose.'
          )}
        </p>
      )}
      {(consents.error || governance.error) && (
        <p className="text-xs text-destructive">{consents.error ?? governance.error}</p>
      )}
    </div>
  )
}
