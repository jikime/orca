import { useCallback, useEffect, useRef, useState } from 'react'
import { ConnectionQuality, Room, RoomEvent, type Participant } from 'livekit-client'
import { translate } from '@/i18n/i18n'
import { apiPost, PieApiError } from '../control-plane/pie-api-client'
import { usePieResource } from '../control-plane/use-pie-resource'
import type {
  MeetingMediaDiagnostics,
  MeetingMediaToken,
  MeetingParticipant
} from './meeting-types'
import { MeetingDisplaySourceDialog } from './MeetingDisplaySourceDialog'
import { MeetingConnectionStatus, type MeetingConnectionState } from './MeetingConnectionStatus'
import { MeetingRoomControlBar } from './MeetingRoomControlBar'
import { MeetingStage } from './MeetingStage'
import type { MeetingDisplaySource } from '../../../../shared/meeting-display-source'
import { MeetingDevicePreview, type MeetingDevicePreferences } from './MeetingDevicePreview'

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
  const preferencesRef = useRef<MeetingDevicePreferences | null>(null)
  const explicitLeaveRef = useRef(false)
  const waitingPollRef = useRef(false)
  const recoveryTimerRef = useRef<number | null>(null)
  const [state, setState] = useState<MeetingConnectionState>('idle')
  const [mediaToken, setMediaToken] = useState<MeetingMediaToken | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<string[]>([])
  const [busyControl, setBusyControl] = useState<'mic' | 'camera' | 'screen' | null>(null)
  const [displaySources, setDisplaySources] = useState<MeetingDisplaySource[]>([])
  const [displayPickerOpen, setDisplayPickerOpen] = useState(false)
  const [captions, setCaptions] = useState<LiveCaption[]>([])
  const [error, setError] = useState<string | null>(null)
  const diagnostics = usePieResource<MeetingMediaDiagnostics>(
    `/meetings/${meetingId}/media-diagnostics`
  )
  const refetchDiagnostics = diagnostics.refetch

  const refreshRoom = useCallback(() => {
    const room = roomRef.current
    if (!room) {
      return
    }
    setParticipants([room.localParticipant, ...room.remoteParticipants.values()])
  }, [])

  const leave = useCallback(() => {
    explicitLeaveRef.current = true
    const room = roomRef.current
    roomRef.current = null
    room?.disconnect()
    setState('idle')
    setParticipants([])
    setActiveSpeakerIds([])
    setCaptions([])
    setMediaToken(null)
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current)
    }
    window.setTimeout(onParticipantsChanged, 750)
  }, [onParticipantsChanged])

  useEffect(() => leave, [leave])

  const markRecovered = useCallback((): void => {
    setState('recovered')
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current)
    }
    recoveryTimerRef.current = window.setTimeout(() => {
      setState((current) => (current === 'recovered' ? 'connected' : current))
    }, 2_500)
  }, [])

  const join = useCallback(
    async (preferences: MeetingDevicePreferences): Promise<void> => {
      preferencesRef.current = preferences
      explicitLeaveRef.current = false
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
          // Why: LiveKit normally toggles devices by muting an existing publication.
          // Publication/subscription events alone would leave remote camera state stale.
          .on(RoomEvent.TrackMuted, refreshRoom)
          .on(RoomEvent.TrackUnmuted, refreshRoom)
          .on(RoomEvent.LocalTrackPublished, refreshRoom)
          .on(RoomEvent.LocalTrackUnpublished, refreshRoom)
          .on(RoomEvent.ActiveSpeakersChanged, (active) => {
            setActiveSpeakerIds(active.map((participant) => participant.identity))
          })
          .on(RoomEvent.Reconnecting, () => setState('reconnecting'))
          .on(RoomEvent.SignalReconnecting, () => setState('reconnecting'))
          .on(RoomEvent.Reconnected, markRecovered)
          .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
            if (participant !== room.localParticipant) {
              return
            }
            if (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) {
              setState('degraded')
            } else {
              setState((current) => {
                if (current !== 'degraded') {
                  return current
                }
                window.setTimeout(markRecovered, 0)
                return current
              })
            }
          })
          .on(RoomEvent.MediaDevicesError, (caught) => {
            setError(
              translate(
                'auto.pie.meetings.LiveMeetingRoom.deviceError',
                'A camera or microphone became unavailable: {{value0}}',
                { value0: errorText(caught) }
              )
            )
          })
          .on(RoomEvent.Disconnected, () => {
            roomRef.current = null
            setState('idle')
            setParticipants([])
            setActiveSpeakerIds([])
            setCaptions([])
            setMediaToken(null)
            if (!explicitLeaveRef.current) {
              setError(
                translate(
                  'auto.pie.meetings.LiveMeetingRoom.disconnected',
                  'The media connection ended. Check the connection status and join again.'
                )
              )
            }
          })
        await room.connect(issued.serverUrl, issued.token)
        if (preferences.speakerDeviceId) {
          await room.switchActiveDevice('audiooutput', preferences.speakerDeviceId)
        }
        if (preferences.microphoneEnabled) {
          await room.localParticipant.setMicrophoneEnabled(true, {
            deviceId: preferences.microphoneDeviceId || undefined
          })
        }
        if (preferences.cameraEnabled) {
          await room.localParticipant.setCameraEnabled(true, {
            deviceId: preferences.cameraDeviceId || undefined
          })
        }
        setMediaToken(issued)
        setState('connected')
        refreshRoom()
        window.setTimeout(onParticipantsChanged, 750)
      } catch (caught) {
        roomRef.current?.disconnect()
        roomRef.current = null
        if (caught instanceof PieApiError && caught.code === 'MEETING_ADMISSION_REQUIRED') {
          setState('waiting')
          setError(null)
          onParticipantsChanged()
        } else {
          setState('idle')
          setError(errorText(caught))
          refetchDiagnostics()
        }
      }
    },
    [markRecovered, meetingId, onParticipantsChanged, refetchDiagnostics, refreshRoom]
  )

  useEffect(() => {
    if (state !== 'waiting') {
      return
    }
    let cancelled = false
    const poll = async (): Promise<void> => {
      if (waitingPollRef.current) {
        return
      }
      waitingPollRef.current = true
      try {
        const participant = await apiPost<MeetingParticipant>(`/meetings/${meetingId}/waiting-room`)
        onParticipantsChanged()
        if (cancelled) {
          return
        }
        if (participant.accessStatus === 'admitted' && preferencesRef.current) {
          await join(preferencesRef.current)
        } else if (
          participant.accessStatus === 'denied' ||
          participant.accessStatus === 'blocked'
        ) {
          setState('idle')
          setError(
            translate(
              'auto.pie.meetings.LiveMeetingRoom.admissionDenied',
              'The host did not admit this participant.'
            )
          )
        }
      } catch (caught) {
        if (!cancelled) {
          setError(errorText(caught))
        }
      } finally {
        waitingPollRef.current = false
      }
    }
    void poll()
    const interval = window.setInterval(() => void poll(), 3_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [join, meetingId, onParticipantsChanged, state])

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

  const toggleMicrophone = async (): Promise<void> => {
    const local = roomRef.current?.localParticipant
    if (!local) {
      return
    }
    setBusyControl('mic')
    setError(null)
    try {
      await local.setMicrophoneEnabled(!local.isMicrophoneEnabled)
      refreshRoom()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusyControl(null)
    }
  }

  const local = roomRef.current?.localParticipant
  const micEnabled = Boolean(local?.isMicrophoneEnabled)
  const screenEnabled = Boolean(local?.isScreenShareEnabled)
  const participantCount = participants.length
  const canShareScreen =
    mediaToken?.participant.role === 'host' ||
    mediaToken?.participant.role === 'co_host' ||
    mediaToken?.participant.role === 'presenter'
  const inRoom = ['connected', 'reconnecting', 'degraded', 'recovered'].includes(state)

  if (!inRoom) {
    return (
      <MeetingDevicePreview
        joining={state === 'joining'}
        waiting={state === 'waiting'}
        connectionError={error}
        diagnostics={diagnostics.data}
        diagnosticsLoading={diagnostics.loading}
        diagnosticsError={diagnostics.error}
        onRetryDiagnostics={diagnostics.refetch}
        onJoin={(preferences) => void join(preferences)}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <MeetingConnectionStatus
        state={state}
        participantCount={participantCount}
        role={mediaToken?.participant.role ?? null}
      />
      <div className="relative min-h-0 flex-1">
        <MeetingStage
          participants={participants}
          localParticipant={local}
          activeSpeakerIds={activeSpeakerIds}
          captions={captions}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {roomRef.current && mediaToken?.participant && (
        <MeetingRoomControlBar
          room={roomRef.current}
          meetingId={meetingId}
          participant={mediaToken.participant}
          micEnabled={micEnabled}
          screenEnabled={screenEnabled}
          canShareScreen={canShareScreen}
          busy={busyControl !== null}
          onToggleMicrophone={() => void toggleMicrophone()}
          onToggleScreenShare={() => void toggleScreenShare()}
          onCameraBusyChange={(busy) => setBusyControl(busy ? 'camera' : null)}
          onError={setError}
          onChanged={refreshRoom}
          onLeave={leave}
        />
      )}
      <MeetingDisplaySourceDialog
        open={displayPickerOpen}
        sources={displaySources}
        onOpenChange={setDisplayPickerOpen}
        onSelect={(source) => void shareDisplaySource(source)}
      />
    </div>
  )
}
