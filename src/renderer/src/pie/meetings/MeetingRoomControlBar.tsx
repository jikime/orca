import { LogOut, Mic, MicOff, MonitorUp, ScreenShareOff } from 'lucide-react'
import type { Room } from 'livekit-client'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { MeetingCameraControl } from './MeetingCameraControl'
import { MeetingCaptureConsentControl } from './MeetingCaptureConsentControl'
import type { MeetingParticipant } from './meeting-types'

export function MeetingRoomControlBar({
  room,
  meetingId,
  participant,
  micEnabled,
  screenEnabled,
  canShareScreen,
  busy,
  onToggleMicrophone,
  onToggleScreenShare,
  onCameraBusyChange,
  onError,
  onChanged,
  onLeave
}: {
  room: Room
  meetingId: string
  participant: MeetingParticipant
  micEnabled: boolean
  screenEnabled: boolean
  canShareScreen: boolean
  busy: boolean
  onToggleMicrophone: () => void
  onToggleScreenShare: () => void
  onCameraBusyChange: (busy: boolean) => void
  onError: (error: string | null) => void
  onChanged: () => void
  onLeave: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Button
        size="sm"
        variant={micEnabled ? 'secondary' : 'outline'}
        onClick={onToggleMicrophone}
        disabled={busy}
      >
        {micEnabled ? <Mic /> : <MicOff />}
        {micEnabled
          ? translate('auto.pie.meetings.LiveMeetingRoom.mute', 'Mute')
          : translate('auto.pie.meetings.LiveMeetingRoom.unmute', 'Unmute')}
      </Button>
      <Button
        size="sm"
        variant={screenEnabled ? 'secondary' : 'outline'}
        onClick={onToggleScreenShare}
        disabled={busy || !canShareScreen}
        title={
          canShareScreen
            ? undefined
            : translate(
                'auto.pie.meetings.LiveMeetingRoom.screenRestricted',
                'Only hosts, co-hosts, and presenters can share a screen.'
              )
        }
      >
        {screenEnabled ? <ScreenShareOff /> : <MonitorUp />}
        {screenEnabled
          ? translate('auto.pie.meetings.LiveMeetingRoom.screenOff', 'Stop sharing')
          : translate('auto.pie.meetings.LiveMeetingRoom.screenOn', 'Share screen')}
      </Button>
      <MeetingCameraControl
        room={room}
        disabled={busy}
        onBusyChange={onCameraBusyChange}
        onError={onError}
        onChanged={onChanged}
      />
      <MeetingCaptureConsentControl
        meetingId={meetingId}
        participant={participant}
        disabled={busy}
        onChanged={onChanged}
      />
      <Button size="sm" variant="destructive" className="ml-auto" onClick={onLeave}>
        <LogOut />
        {translate('auto.pie.meetings.LiveMeetingRoom.leave', 'Leave')}
      </Button>
    </div>
  )
}
