import { useEffect, useRef } from 'react'
import { MicOff, Pin, PinOff, UserRound } from 'lucide-react'
import { Track, type Participant } from 'livekit-client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function MeetingParticipantTile({
  participant,
  local,
  speaking,
  pinned = false,
  onTogglePin,
  source = Track.Source.Camera,
  className
}: {
  participant: Participant
  local: boolean
  speaking: boolean
  pinned?: boolean
  onTogglePin?: () => void
  source?: Track.Source.Camera | Track.Source.ScreenShare
  className?: string
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const publication = participant.getTrackPublication(source)
  const video = publication?.isMuted ? undefined : publication?.track
  const screen = source === Track.Source.ScreenShare

  useEffect(() => {
    const element = videoRef.current
    if (!video || !element) {
      return
    }
    video.attach(element)
    return () => {
      video.detach(element)
    }
  }, [video])

  const microphoneEnabled = participant.isMicrophoneEnabled
  const label = participant.name || participant.identity
  const displayLabel = screen
    ? translate('auto.pie.meetings.MeetingParticipantTile.sharedScreen', "{{value0}}'s screen", {
        value0: label
      })
    : local
      ? translate('auto.pie.meetings.MeetingParticipantTile.you', '{{value0}} (you)', {
          value0: label
        })
      : label

  return (
    <div
      className={cn(
        'group relative aspect-video min-h-28 overflow-hidden rounded-lg border bg-muted',
        speaking ? 'border-ring ring-2 ring-ring/60' : 'border-border',
        className
      )}
    >
      {video ? (
        <video
          ref={videoRef}
          className={cn(
            'size-full',
            screen ? 'object-contain' : 'object-cover',
            local && !screen && '-scale-x-100'
          )}
          autoPlay
          playsInline
          muted={local}
        />
      ) : (
        <div className="flex size-full min-h-28 items-center justify-center text-muted-foreground">
          <UserRound className="size-10" />
        </div>
      )}
      {onTogglePin && !screen && (
        <Button
          size="icon-xs"
          variant="secondary"
          className={cn(
            'absolute right-2 top-2 bg-background/85 opacity-0 shadow-xs backdrop-blur-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
            pinned && 'opacity-100'
          )}
          aria-label={
            pinned
              ? translate('auto.pie.meetings.MeetingParticipantTile.unpin', 'Unpin participant')
              : translate('auto.pie.meetings.MeetingParticipantTile.pin', 'Pin participant')
          }
          title={
            pinned
              ? translate('auto.pie.meetings.MeetingParticipantTile.unpin', 'Unpin participant')
              : translate('auto.pie.meetings.MeetingParticipantTile.pin', 'Pin participant')
          }
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff /> : <Pin />}
        </Button>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/85 px-2 py-1.5 text-xs text-foreground backdrop-blur-sm">
        <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
        {!screen && !microphoneEnabled && <MicOff className="size-3.5 text-muted-foreground" />}
      </div>
    </div>
  )
}
