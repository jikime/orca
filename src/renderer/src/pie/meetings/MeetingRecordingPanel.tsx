import { useEffect, useMemo, useState } from 'react'
import { CircleStop, LoaderCircle, Play, Radio, Video } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiGet, apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type { MeetingProcessingJob, MeetingRecording, MeetingTranscript } from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingRecordingPanel({
  meetingId,
  live,
  recordingReady
}: {
  meetingId: string
  live: boolean
  recordingReady: boolean
}): React.JSX.Element {
  const {
    data: recordingData,
    error: recordingError,
    refetch: refetchRecordings
  } = usePieResource<{ items: MeetingRecording[] }>(`/meetings/${meetingId}/recordings`)
  const {
    data: jobData,
    error: jobError,
    refetch: refetchJobs
  } = usePieResource<{
    items: MeetingProcessingJob[]
  }>(`/meetings/${meetingId}/processing-jobs`)
  const {
    data: transcriptData,
    error: transcriptError,
    refetch: refetchTranscripts
  } = usePieResource<{ items: MeetingTranscript[] }>(`/meetings/${meetingId}/transcripts`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const items = recordingData?.items ?? []
  const active = items.find((item) => item.status === 'pending')
  const latestAvailable = items
    .filter((item) => item.status === 'available')
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const latestTranscript = useMemo(
    () =>
      (transcriptData?.items ?? [])
        .filter((item) => item.source === 'post_recording')
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
    [transcriptData]
  )
  const processing = (jobData?.items ?? []).some(
    (job) => job.status === 'queued' || job.status === 'processing'
  )

  useEffect(() => {
    if (!active && !processing) {
      return
    }
    const interval = window.setInterval(() => {
      refetchRecordings()
      refetchJobs()
      refetchTranscripts()
    }, 3_000)
    return () => window.clearInterval(interval)
  }, [active, processing, refetchJobs, refetchRecordings, refetchTranscripts])

  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      refetchRecordings()
      refetchJobs()
      refetchTranscripts()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const play = async (): Promise<void> => {
    if (!latestAvailable) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const grant = await apiGet<{ url: string }>(
        `/meeting-recordings/${latestAvailable.id}/playback`
      )
      setPlaybackUrl(grant.url)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const latestJob = (jobData?.items ?? []).at(-1)

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Video className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.pie.meetings.MeetingRecordingPanel.title', 'Recording & transcript')}
        </h3>
        {active && (
          <Badge variant="destructive" className="ml-auto">
            <Radio className="size-3" />
            {active.stoppedAt
              ? translate('auto.pie.meetings.MeetingRecordingPanel.finalizing', 'Finalizing')
              : translate('auto.pie.meetings.MeetingRecordingPanel.recording', 'Recording')}
          </Badge>
        )}
      </div>
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap gap-2">
          {!active && live && (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || !recordingReady}
              onClick={() => void mutate(() => apiPost(`/meetings/${meetingId}/recordings`))}
            >
              <Radio />
              {translate('auto.pie.meetings.MeetingRecordingPanel.start', 'Start recording')}
            </Button>
          )}
          {active && !active.stoppedAt && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void mutate(() => apiPost(`/meeting-recordings/${active.id}:stop`))}
            >
              <CircleStop />
              {translate('auto.pie.meetings.MeetingRecordingPanel.stop', 'Stop')}
            </Button>
          )}
          {latestAvailable && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void play()}>
              <Play />
              {translate('auto.pie.meetings.MeetingRecordingPanel.play', 'Play latest')}
            </Button>
          )}
        </div>
        {live && !recordingReady && !active && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.MeetingRecordingPanel.consent',
              'Every connected participant must allow recording first.'
            )}
          </p>
        )}
        {latestJob && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {(latestJob.status === 'queued' || latestJob.status === 'processing') && (
              <LoaderCircle className="size-3.5 animate-spin" />
            )}
            {latestJob.jobType} · {latestJob.status}
            {latestJob.lastError ? ` · ${latestJob.lastError}` : ''}
          </p>
        )}
        {playbackUrl && (
          <video
            className="aspect-video w-full rounded-md bg-muted"
            src={playbackUrl}
            controls
            preload="metadata"
          />
        )}
        {latestTranscript?.content && (
          <details className="rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              {translate(
                'auto.pie.meetings.MeetingRecordingPanel.transcript',
                'Post-meeting transcript'
              )}
            </summary>
            <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-muted-foreground scrollbar-sleek">
              {latestTranscript.content}
            </p>
          </details>
        )}
        {(error || recordingError || jobError || transcriptError) && (
          <p className="text-xs text-destructive">
            {error ?? recordingError ?? jobError ?? transcriptError}
          </p>
        )}
      </div>
    </section>
  )
}
