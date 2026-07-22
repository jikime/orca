import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, FileText, Gavel, Play, ScrollText, Video } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiGet, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import { MeetingTranscriptTimeline } from './MeetingTranscriptTimeline'
import type {
  MeetingActionItem,
  MeetingDecision,
  MeetingMinutes,
  MeetingRecording,
  MeetingTranscript
} from './meeting-types'

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

function latest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

function RecapMetric({
  icon,
  label,
  value
}: {
  icon: React.ReactNode
  label: string
  value: string | number
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold text-foreground">{value}</p>
    </div>
  )
}

export function MeetingRecapPanel({
  meetingId,
  canManageTranscript
}: {
  meetingId: string
  canManageTranscript: boolean
}): React.JSX.Element {
  const recordings = usePieResource<{ items: MeetingRecording[] }>(
    `/meetings/${meetingId}/recordings`
  )
  const transcripts = usePieResource<{ items: MeetingTranscript[] }>(
    `/meetings/${meetingId}/transcripts`
  )
  const minutes = usePieResource<{ items: MeetingMinutes[] }>(`/meetings/${meetingId}/minutes`)
  const decisions = usePieResource<{ items: MeetingDecision[] }>(`/meetings/${meetingId}/decisions`)
  const actions = usePieResource<{ items: MeetingActionItem[] }>(
    `/meetings/${meetingId}/action-items`
  )
  const videoRef = useRef<HTMLVideoElement>(null)
  const pendingSeekMs = useRef<number | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recording = useMemo(
    () => latest((recordings.data?.items ?? []).filter((item) => item.status === 'available')),
    [recordings.data]
  )
  const transcript = useMemo(() => latest(transcripts.data?.items ?? []), [transcripts.data])
  const meetingMinutes = useMemo(() => latest(minutes.data?.items ?? []), [minutes.data])
  const decisionItems = decisions.data?.items ?? []
  const actionItems = actions.data?.items ?? []

  useEffect(() => {
    if (!playbackUrl || pendingSeekMs.current === null || !videoRef.current) {
      return
    }
    videoRef.current.currentTime = pendingSeekMs.current / 1_000
    pendingSeekMs.current = null
    void videoRef.current.play().catch(() => undefined)
  }, [playbackUrl])

  const seek = useCallback(
    async (milliseconds: number): Promise<void> => {
      if (!recording) {
        return
      }
      pendingSeekMs.current = milliseconds
      if (playbackUrl && videoRef.current) {
        videoRef.current.currentTime = milliseconds / 1_000
        pendingSeekMs.current = null
        void videoRef.current.play().catch(() => undefined)
        return
      }
      setError(null)
      try {
        const grant = await apiGet<{ url: string }>(`/meeting-recordings/${recording.id}/playback`)
        setPlaybackUrl(grant.url)
      } catch (caught) {
        setError(errorText(caught))
      }
    },
    [playbackUrl, recording]
  )

  const errors = [
    error,
    recordings.error,
    transcripts.error,
    minutes.error,
    decisions.error,
    actions.error
  ].filter(Boolean)

  return (
    <div className="h-full overflow-y-auto p-4 scrollbar-sleek">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <RecapMetric
            icon={<Video className="size-3.5" />}
            label={translate('auto.pie.meetings.recap.recording', 'Recording')}
            value={recording ? translate('auto.pie.meetings.recap.ready', 'Ready') : '—'}
          />
          <RecapMetric
            icon={<ScrollText className="size-3.5" />}
            label={translate('auto.pie.meetings.recap.transcript', 'Transcript')}
            value={transcript ? translate('auto.pie.meetings.recap.ready', 'Ready') : '—'}
          />
          <RecapMetric
            icon={<Gavel className="size-3.5" />}
            label={translate('auto.pie.meetings.recap.decisions', 'Decisions')}
            value={decisionItems.length}
          />
          <RecapMetric
            icon={<CheckSquare className="size-3.5" />}
            label={translate('auto.pie.meetings.recap.actions', 'Action items')}
            value={actionItems.length}
          />
        </div>

        {recording && (
          <section className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
              <Video className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">
                {translate('auto.pie.meetings.recap.recording', 'Recording')}
              </h3>
              <Badge variant="secondary" className="ml-auto">
                {recording.durationSeconds
                  ? translate('auto.pie.meetings.recap.minutesDuration', '{{value0}} min', {
                      value0: Math.round(recording.durationSeconds / 60)
                    })
                  : translate('auto.pie.meetings.recap.ready', 'Ready')}
              </Badge>
            </div>
            {!playbackUrl ? (
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void seek(0)}>
                <Play />
                {translate('auto.pie.meetings.recap.play', 'Play recording')}
              </Button>
            ) : (
              <video
                ref={videoRef}
                className="mt-3 aspect-video w-full rounded-md bg-muted"
                src={playbackUrl}
                controls
                preload="metadata"
              />
            )}
          </section>
        )}

        <section className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">
              {translate('auto.pie.meetings.recap.minutes', 'Meeting minutes')}
            </h3>
            {meetingMinutes && (
              <Badge variant="outline" className="ml-auto">
                {meetingMinutes.status}
              </Badge>
            )}
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">
            {meetingMinutes?.summary ??
              translate('auto.pie.meetings.recap.noMinutes', 'No meeting minutes yet.')}
          </p>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-border bg-card p-3">
            <h3 className="text-sm font-semibold text-foreground">
              {translate('auto.pie.meetings.recap.decisions', 'Decisions')}
            </h3>
            <ul className="mt-2 space-y-2">
              {decisionItems.length === 0 ? (
                <li className="text-xs text-muted-foreground">
                  {translate('auto.pie.meetings.recap.noDecisions', 'No decisions yet.')}
                </li>
              ) : (
                decisionItems.map((item) => (
                  <li key={item.id} className="rounded-md bg-muted/30 p-2 text-xs text-foreground">
                    <Badge variant="outline" className="mb-1">
                      {item.reviewStatus}
                    </Badge>
                    <p>{item.statement}</p>
                  </li>
                ))
              )}
            </ul>
          </section>
          <section className="rounded-lg border border-border bg-card p-3">
            <h3 className="text-sm font-semibold text-foreground">
              {translate('auto.pie.meetings.recap.actions', 'Action items')}
            </h3>
            <ul className="mt-2 space-y-2">
              {actionItems.length === 0 ? (
                <li className="text-xs text-muted-foreground">
                  {translate('auto.pie.meetings.recap.noActions', 'No action items yet.')}
                </li>
              ) : (
                actionItems.map((item) => (
                  <li key={item.id} className="rounded-md bg-muted/30 p-2 text-xs text-foreground">
                    <div className="flex items-center gap-1">
                      <Badge variant="outline">{item.reviewStatus}</Badge>
                      {item.workItemId && (
                        <Badge variant="secondary">
                          {translate('auto.pie.meetings.outcomes.workItem', 'Work item')}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1">{item.task}</p>
                  </li>
                ))
              )}
            </ul>
          </section>
        </div>

        {transcript && (
          <section className="rounded-lg border border-border bg-card p-3">
            <MeetingTranscriptTimeline
              transcript={transcript}
              canManage={canManageTranscript}
              onSeek={(milliseconds) => void seek(milliseconds)}
            />
          </section>
        )}
        {errors.length > 0 && <p className="text-xs text-destructive">{errors[0]}</p>}
      </div>
    </div>
  )
}
