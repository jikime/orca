import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff } from 'lucide-react'
import { Room, RoomEvent } from 'livekit-client'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  resolveMeetingCameraDeviceId,
  switchMeetingCamera,
  type MeetingCameraDevice
} from './meeting-camera-device-selection'

function cameraLabel(device: MeetingCameraDevice, index: number): string {
  if (device.label.trim()) {
    return device.label
  }
  if (device.deviceId === 'default') {
    return translate('auto.pie.meetings.MeetingCameraControl.defaultCamera', 'Default camera')
  }
  return translate('auto.pie.meetings.MeetingCameraControl.unnamedCamera', 'Camera {{value0}}', {
    value0: index + 1
  })
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

export function MeetingCameraControl({
  room,
  disabled,
  onBusyChange,
  onError,
  onChanged
}: {
  room: Room
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onError: (error: string | null) => void
  onChanged: () => void
}): React.JSX.Element {
  const activeRoomRef = useRef<Room | null>(null)
  const devicesRef = useRef<MeetingCameraDevice[]>([])
  const [devices, setDevices] = useState<MeetingCameraDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const cameraEnabled = room.localParticipant.isCameraEnabled

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      // Why: joining keeps the camera private-by-default; listing choices must
      // not request capture permission until the user turns the camera on.
      const available = (await Room.getLocalDevices('videoinput', false)).map((device) => ({
        deviceId: device.deviceId,
        label: device.label
      }))
      if (activeRoomRef.current !== room) {
        return
      }
      devicesRef.current = available
      setDevices(available)
      setSelectedDeviceId((current) =>
        resolveMeetingCameraDeviceId(available, room.getActiveDevice('videoinput'), current)
      )
    } catch {
      if (activeRoomRef.current === room) {
        devicesRef.current = []
        setDevices([])
      }
    }
  }, [room])

  useEffect(() => {
    activeRoomRef.current = room
    const handleDevicesChanged = (): void => void refreshDevices()
    const handleActiveDeviceChanged = (kind: MediaDeviceKind, deviceId: string): void => {
      if (kind !== 'videoinput') {
        return
      }
      setSelectedDeviceId((current) =>
        resolveMeetingCameraDeviceId(devicesRef.current, deviceId, current)
      )
    }
    room.on(RoomEvent.MediaDevicesChanged, handleDevicesChanged)
    room.on(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged)
    void refreshDevices()
    return () => {
      activeRoomRef.current = null
      room.off(RoomEvent.MediaDevicesChanged, handleDevicesChanged)
      room.off(RoomEvent.ActiveDeviceChanged, handleActiveDeviceChanged)
    }
  }, [refreshDevices, room])

  const toggleCamera = async (): Promise<void> => {
    onBusyChange(true)
    onError(null)
    try {
      await room.localParticipant.setCameraEnabled(!cameraEnabled)
      await refreshDevices()
      onChanged()
    } catch (caught) {
      onError(errorText(caught))
    } finally {
      onBusyChange(false)
    }
  }

  const selectCamera = async (deviceId: string): Promise<void> => {
    onBusyChange(true)
    onError(null)
    try {
      await switchMeetingCamera(room, deviceId)
      setSelectedDeviceId(deviceId)
      onChanged()
    } catch (caught) {
      onError(errorText(caught))
    } finally {
      onBusyChange(false)
    }
  }

  return (
    <ButtonGroup>
      <Button
        size="sm"
        variant={cameraEnabled ? 'secondary' : 'outline'}
        onClick={() => void toggleCamera()}
        disabled={disabled}
      >
        {cameraEnabled ? <Camera /> : <CameraOff />}
        {cameraEnabled
          ? translate('auto.pie.meetings.LiveMeetingRoom.cameraOff', 'Stop camera')
          : translate('auto.pie.meetings.LiveMeetingRoom.cameraOn', 'Start camera')}
      </Button>
      {devices.length > 1 && (
        <Select
          value={selectedDeviceId || undefined}
          onValueChange={(deviceId) => void selectCamera(deviceId)}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className="w-52"
            aria-label={translate(
              'auto.pie.meetings.MeetingCameraControl.selectCamera',
              'Choose camera'
            )}
          >
            <SelectValue
              placeholder={translate(
                'auto.pie.meetings.MeetingCameraControl.selectCamera',
                'Choose camera'
              )}
            />
          </SelectTrigger>
          <SelectContent align="end">
            {devices.map((device, index) => (
              <SelectItem key={device.deviceId} value={device.deviceId}>
                {cameraLabel(device, index)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </ButtonGroup>
  )
}
