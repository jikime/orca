import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, MessageSquareText, Play, Radio, Send, Video } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiGet, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type {
  MeetingProcessingJob,
  MeetingRecording,
  MeetingResource,
  MeetingTranscript
} from './meeting-types'
import {
  openPublishedMeetingMessage,
  publishMeetingMessage,
  type PublishedMeetingMessage
} from './meeting-chat'
import { MeetingTranscriptTimeline } from './MeetingTranscriptTimeline'
import { subscribeMeetingRecordingSeek } from './meeting-recording-navigation'
import { MeetingCaptureToolbar } from './MeetingCaptureToolbar'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingRecordingPanel({
  meeting,
  live,
  joinedParticipantIds,
  canManageTranscript
}: {
  meeting: MeetingResource
  live: boolean
  joinedParticipantIds: string[]
  canManageTranscript: boolean
}): React.JSX.Element {
  const meetingId = meeting.id
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
  const [published, setPublished] = useState<PublishedMeetingMessage | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeekMs = useRef<number | null>(null)
  const items = recordingData?.items ?? []
  const active = items.find((item) => item.status === 'pending' && !item.stoppedAt)
  const finalizing = items.some((item) => item.status === 'pending' && item.stoppedAt)
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

  useEffect(() => {
    const seekMs = pendingSeekMs.current
    if (!playbackUrl || seekMs === null || !videoRef.current) {
      return
    }
    videoRef.current.currentTime = seekMs / 1_000
    pendingSeekMs.current = null
    void videoRef.current.play().catch(() => undefined)
  }, [playbackUrl])

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

  const seekRecording = useCallback(
    async (milliseconds: number): Promise<void> => {
      if (!latestAvailable) {
        return
      }
      pendingSeekMs.current = milliseconds
      if (playbackUrl && videoRef.current) {
        videoRef.current.currentTime = milliseconds / 1_000
        pendingSeekMs.current = null
        void videoRef.current.play().catch(() => undefined)
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
    },
    [latestAvailable, playbackUrl]
  )

  useEffect(
    () => subscribeMeetingRecordingSeek((milliseconds) => void seekRecording(milliseconds)),
    [seekRecording]
  )

  const publish = async (): Promise<void> => {
    if (!latestAvailable) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const duration = latestAvailable.durationSeconds
        ? translate(
            'auto.pie.meetings.MeetingRecordingPanel.duration',
            'Duration: {{value0}} seconds',
            { value0: latestAvailable.durationSeconds }
          )
        : translate(
            'auto.pie.meetings.MeetingRecordingPanel.durationunknown',
            'Duration is being calculated.'
          )
      setPublished(
        await publishMeetingMessage(
          meeting,
          `recording:${latestAvailable.id}`,
          `## ${translate(
            'auto.pie.meetings.MeetingRecordingPanel.readytitle',
            'Recording ready: {{value0}}',
            { value0: meeting.title }
          )}\n\n${duration}\n\n${translate(
            'auto.pie.meetings.MeetingRecordingPanel.readybody',
            'Open the meeting recap to play the recording and review its transcript.'
          )}`
        )
      )
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
        {(active || finalizing) && (
          <Badge variant="destructive" className="ml-auto">
            <Radio className="size-3" />
            {finalizing && !active
              ? translate('auto.pie.meetings.MeetingRecordingPanel.finalizing', 'Finalizing')
              : translate('auto.pie.meetings.MeetingRecordingPanel.recording', 'Recording')}
          </Badge>
        )}
      </div>
      <div className="space-y-3 p-3">
        <MeetingCaptureToolbar
          meetingId={meetingId}
          live={live}
          joinedParticipantIds={joinedParticipantIds}
          active={active}
          busy={busy}
          mutate={mutate}
        />
        <div className="flex flex-wrap gap-2">
          {latestAvailable && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void seekRecording(0)}
            >
              <Play />
              {translate('auto.pie.meetings.MeetingRecordingPanel.play', 'Play latest')}
            </Button>
          )}
          {latestAvailable && !published && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void publish()}>
              <Send />
              {translate('auto.pie.meetings.MeetingRecordingPanel.publish', 'Publish to chat')}
            </Button>
          )}
          {published && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openPublishedMeetingMessage(published)}
            >
              <MessageSquareText />
              {translate('auto.pie.meetings.MeetingRecordingPanel.openpost', 'Open chat post')}
            </Button>
          )}
        </div>
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
            ref={videoRef}
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
      {latestTranscript && (
        <div className="border-t border-border p-3">
          <MeetingTranscriptTimeline
            transcript={latestTranscript}
            canManage={canManageTranscript}
            onSeek={(milliseconds) => void seekRecording(milliseconds)}
          />
        </div>
      )}
    </section>
  )
}
