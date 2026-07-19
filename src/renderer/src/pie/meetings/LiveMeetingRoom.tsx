import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  CameraOff,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  PhoneCall,
  ScreenShareOff
} from 'lucide-react'
import { Room, RoomEvent, type Participant } from 'livekit-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { apiGet, apiPost, PieApiError, resourceEtag } from '../control-plane/pie-api-client'
import type { MeetingMediaToken, MeetingParticipant } from './meeting-types'
import { MeetingParticipantTile } from './MeetingParticipantTile'
import { MeetingDisplaySourceDialog } from './MeetingDisplaySourceDialog'
import type { MeetingDisplaySource } from '../../../../shared/meeting-display-source'

type ConnectionState = 'idle' | 'joining' | 'connected'

type LiveCaption = { segmentId: string; speaker: string; text: string; final: boolean }

function errorText(caught: unknown): string {
  if (caught instanceof PieApiError) {
    return `${caught.code ?? caught.status}: ${caught.message}`
  }
  return caught instanceof Error ? caught.message : String(caught)
}

export function LiveMeetingRoom({
  meetingId,
  onParticipantsChanged
}: {
  meetingId: string
  onParticipantsChanged: () => void
}): React.JSX.Element {
  const roomRef = useRef<Room | null>(null)
  const [state, setState] = useState<ConnectionState>('idle')
  const [mediaToken, setMediaToken] = useState<MeetingMediaToken | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [speakers, setSpeakers] = useState<Set<string>>(new Set())
  const [busyControl, setBusyControl] = useState<'mic' | 'camera' | 'screen' | 'consent' | null>(
    null
  )
  const [displaySources, setDisplaySources] = useState<MeetingDisplaySource[]>([])
  const [displayPickerOpen, setDisplayPickerOpen] = useState(false)
  const [captions, setCaptions] = useState<LiveCaption[]>([])
  const [error, setError] = useState<string | null>(null)

  const refreshRoom = useCallback(() => {
    const room = roomRef.current
    if (!room) {
      return
    }
    setParticipants([room.localParticipant, ...room.remoteParticipants.values()])
  }, [])

  const leave = useCallback(() => {
    const room = roomRef.current
    roomRef.current = null
    room?.disconnect()
    setState('idle')
    setParticipants([])
    setSpeakers(new Set())
    setCaptions([])
    window.setTimeout(onParticipantsChanged, 750)
  }, [onParticipantsChanged])

  useEffect(() => leave, [leave])

  const join = async (): Promise<void> => {
    setState('joining')
    setError(null)
    try {
      const issued = await apiPost<MeetingMediaToken>(`/meetings/${meetingId}/media-token`)
      const room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
        const text = (await reader.readAll()).trim()
        if (!text || roomRef.current !== room) {
          return
        }
        const attributes = reader.info.attributes ?? {}
        const segmentId = attributes['lk.segment_id'] ?? reader.info.id
        const final = attributes['lk.transcription_final'] === 'true'
        setCaptions((current) => {
          const next = current.filter((caption) => caption.segmentId !== segmentId)
          next.push({ segmentId, speaker: participant.identity, text, final })
          return next.slice(-4)
        })
      })
      room
        .on(RoomEvent.ParticipantConnected, refreshRoom)
        .on(RoomEvent.ParticipantDisconnected, refreshRoom)
        .on(RoomEvent.TrackPublished, refreshRoom)
        .on(RoomEvent.TrackUnpublished, refreshRoom)
        .on(RoomEvent.TrackSubscribed, refreshRoom)
        .on(RoomEvent.TrackUnsubscribed, refreshRoom)
        .on(RoomEvent.LocalTrackPublished, refreshRoom)
        .on(RoomEvent.LocalTrackUnpublished, refreshRoom)
        .on(RoomEvent.ActiveSpeakersChanged, (active) => {
          setSpeakers(new Set(active.map((participant) => participant.identity)))
        })
        .on(RoomEvent.Disconnected, () => {
          roomRef.current = null
          setState('idle')
          setParticipants([])
        })
      await room.connect(issued.serverUrl, issued.token)
      setMediaToken(issued)
      setState('connected')
      refreshRoom()
      window.setTimeout(onParticipantsChanged, 750)
    } catch (caught) {
      roomRef.current?.disconnect()
      roomRef.current = null
      setState('idle')
      setError(errorText(caught))
    }
  }

  const toggleScreenShare = async (): Promise<void> => {
    const localParticipant = roomRef.current?.localParticipant
    if (!localParticipant) {
      return
    }
    if (localParticipant.isScreenShareEnabled) {
      setBusyControl('screen')
      try {
        await localParticipant.setScreenShareEnabled(false)
        refreshRoom()
      } catch (caught) {
        setError(errorText(caught))
      } finally {
        setBusyControl(null)
      }
      return
    }
    const bridge = window.api?.meetingMedia
    if (!bridge) {
      setBusyControl('screen')
      try {
        await localParticipant.setScreenShareEnabled(true)
        refreshRoom()
      } catch (caught) {
        setError(errorText(caught))
      } finally {
        setBusyControl(null)
      }
      return
    }
    setBusyControl('screen')
    try {
      const sources = await bridge.listDisplaySources()
      if (sources.length === 0) {
        throw new Error('No shareable screens or windows were found')
      }
      setDisplaySources(sources)
      setDisplayPickerOpen(true)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyControl(null)
    }
  }

  const shareDisplaySource = async (source: MeetingDisplaySource): Promise<void> => {
    const localParticipant = roomRef.current?.localParticipant
    const bridge = window.api?.meetingMedia
    if (!localParticipant || !bridge) {
      return
    }
    setDisplayPickerOpen(false)
    setBusyControl('screen')
    setError(null)
    try {
      if (!(await bridge.selectDisplaySource(source.id))) {
        throw new Error('Display share was denied')
      }
      await localParticipant.setScreenShareEnabled(true)
      refreshRoom()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyControl(null)
    }
  }

  const toggleTrack = async (kind: 'mic' | 'camera'): Promise<void> => {
    const local = roomRef.current?.localParticipant
    if (!local) {
      return
    }
    setBusyControl(kind)
    setError(null)
    try {
      await (kind === 'mic'
        ? local.setMicrophoneEnabled(!local.isMicrophoneEnabled)
        : local.setCameraEnabled(!local.isCameraEnabled))
      refreshRoom()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyControl(null)
    }
  }

  const setConsent = async (): Promise<void> => {
    const self = mediaToken?.participant
    if (!self) {
      return
    }
    setBusyControl('consent')
    setError(null)
    try {
      // Presence webhooks can bump the participant version after join; fetch before the OCC write.
      const current = await apiGet<{ items: MeetingParticipant[] }>(
        `/meetings/${meetingId}/participants`
      )
      const participant = current.items.find((item) => item.userId === self.userId)
      if (!participant) {
        throw new Error('current participant not found')
      }
      const updated = await apiPost<MeetingParticipant>(
        `/meeting-participants/${participant.id}:consent`,
        { consent: !participant.consentRecording },
        resourceEtag('meeting-participant', participant.version)
      )
      setMediaToken({ ...mediaToken, participant: updated })
      onParticipantsChanged()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyControl(null)
    }
  }

  const local = roomRef.current?.localParticipant
  const micEnabled = Boolean(local?.isMicrophoneEnabled)
  const cameraEnabled = Boolean(local?.isCameraEnabled)
  const screenEnabled = Boolean(local?.isScreenShareEnabled)
  const consented = Boolean(mediaToken?.participant.consentRecording)
  const participantCount = useMemo(() => participants.length, [participants])

  if (state !== 'connected') {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center">
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <PhoneCall className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            {translate('auto.pie.meetings.LiveMeetingRoom.ready', 'Ready to join')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.pie.meetings.LiveMeetingRoom.devicesOff',
              'Your microphone and camera stay off until you enable them.'
            )}
          </p>
        </div>
        <Button size="sm" onClick={() => void join()} disabled={state === 'joining'}>
          <PhoneCall />
          {state === 'joining'
            ? translate('auto.pie.meetings.LiveMeetingRoom.joining', 'Joining…')
            : translate('auto.pie.meetings.LiveMeetingRoom.join', 'Join meeting')}
        </Button>
        {error && <p className="max-w-md text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">
          {translate('auto.pie.meetings.LiveMeetingRoom.participantCount', '{{value0}} connected', {
            value0: participantCount
          })}
        </Badge>
        <Badge variant={consented ? 'secondary' : 'outline'}>
          {consented
            ? translate('auto.pie.meetings.LiveMeetingRoom.consentGranted', 'Recording allowed')
            : translate(
                'auto.pie.meetings.LiveMeetingRoom.consentMissing',
                'Recording not allowed'
              )}
        </Badge>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="grid size-full grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2 overflow-y-auto scrollbar-sleek">
          {participants.map((participant) => (
            <MeetingParticipantTile
              key={participant.identity}
              participant={participant}
              local={participant === local}
              speaking={speakers.has(participant.identity)}
            />
          ))}
        </div>
        {captions.length > 0 && (
          <div className="pointer-events-none absolute inset-x-4 bottom-3 mx-auto max-w-3xl rounded-lg bg-background/90 px-3 py-2 text-center text-xs text-foreground shadow-sm backdrop-blur-sm">
            {captions.slice(-2).map((caption) => (
              <p key={caption.segmentId} className={caption.final ? '' : 'text-muted-foreground'}>
                <span className="font-medium">{caption.speaker}: </span>
                {caption.text}
              </p>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant={micEnabled ? 'secondary' : 'outline'}
          onClick={() => void toggleTrack('mic')}
          disabled={busyControl !== null}
        >
          {micEnabled ? <Mic /> : <MicOff />}
          {micEnabled
            ? translate('auto.pie.meetings.LiveMeetingRoom.mute', 'Mute')
            : translate('auto.pie.meetings.LiveMeetingRoom.unmute', 'Unmute')}
        </Button>
        <Button
          size="sm"
          variant={screenEnabled ? 'secondary' : 'outline'}
          onClick={() => void toggleScreenShare()}
          disabled={busyControl !== null}
        >
          {screenEnabled ? <ScreenShareOff /> : <MonitorUp />}
          {screenEnabled
            ? translate('auto.pie.meetings.LiveMeetingRoom.screenOff', 'Stop sharing')
            : translate('auto.pie.meetings.LiveMeetingRoom.screenOn', 'Share screen')}
        </Button>
        <Button
          size="sm"
          variant={cameraEnabled ? 'secondary' : 'outline'}
          onClick={() => void toggleTrack('camera')}
          disabled={busyControl !== null}
        >
          {cameraEnabled ? <Camera /> : <CameraOff />}
          {cameraEnabled
            ? translate('auto.pie.meetings.LiveMeetingRoom.cameraOff', 'Stop camera')
            : translate('auto.pie.meetings.LiveMeetingRoom.cameraOn', 'Start camera')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void setConsent()}
          disabled={busyControl !== null}
        >
          {consented
            ? translate('auto.pie.meetings.LiveMeetingRoom.revokeConsent', 'Revoke consent')
            : translate('auto.pie.meetings.LiveMeetingRoom.grantConsent', 'Allow recording')}
        </Button>
        <Button size="sm" variant="destructive" className="ml-auto" onClick={leave}>
          <LogOut />
          {translate('auto.pie.meetings.LiveMeetingRoom.leave', 'Leave')}
        </Button>
      </div>
      <MeetingDisplaySourceDialog
        open={displayPickerOpen}
        sources={displaySources}
        onOpenChange={setDisplayPickerOpen}
        onSelect={(source) => void shareDisplaySource(source)}
      />
    </div>
  )
}
