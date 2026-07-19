import { useEffect, useRef } from 'react'
import { MicOff, UserRound } from 'lucide-react'
import { Track, type Participant } from 'livekit-client'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function MeetingParticipantTile({
  participant,
  local,
  speaking
}: {
  participant: Participant
  local: boolean
  speaking: boolean
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const camera = participant.getTrackPublication(Track.Source.Camera)?.track
  const screen = participant.getTrackPublication(Track.Source.ScreenShare)?.track
  const microphone = participant.getTrackPublication(Track.Source.Microphone)?.track
  const video = screen ?? camera

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

  useEffect(() => {
    const element = audioRef.current
    if (local || !microphone || !element) {
      return
    }
    microphone.attach(element)
    return () => {
      microphone.detach(element)
    }
  }, [local, microphone])

  const microphoneEnabled = participant.isMicrophoneEnabled
  const label = participant.name || participant.identity

  return (
    <div
      className={cn(
        'relative min-h-40 overflow-hidden rounded-lg border bg-muted',
        speaking ? 'border-foreground/50' : 'border-border'
      )}
    >
      {video ? (
        <video
          ref={videoRef}
          className={cn('size-full object-cover', local && !screen && '-scale-x-100')}
          autoPlay
          playsInline
          muted={local}
        />
      ) : (
        <div className="flex size-full min-h-40 items-center justify-center text-muted-foreground">
          <UserRound className="size-10" />
        </div>
      )}
      {!local && <audio ref={audioRef} autoPlay />}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/85 px-2 py-1.5 text-xs text-foreground backdrop-blur-sm">
        <span className="min-w-0 flex-1 truncate">
          {local
            ? translate('auto.pie.meetings.MeetingParticipantTile.you', '{{value0}} (you)', {
                value0: label
              })
            : label}
        </span>
        {!microphoneEnabled && <MicOff className="size-3.5 text-muted-foreground" />}
      </div>
    </div>
  )
}
