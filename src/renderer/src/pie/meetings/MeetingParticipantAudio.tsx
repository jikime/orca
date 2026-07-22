import { useEffect, useRef } from 'react'
import { Track, type Participant } from 'livekit-client'

export function MeetingParticipantAudio({
  participant
}: {
  participant: Participant
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null)
  const microphone = participant.getTrackPublication(Track.Source.Microphone)?.track

  useEffect(() => {
    const element = audioRef.current
    if (!microphone || !element) {
      return
    }
    microphone.attach(element)
    return () => {
      microphone.detach(element)
    }
  }, [microphone])

  return <audio ref={audioRef} autoPlay aria-hidden />
}
