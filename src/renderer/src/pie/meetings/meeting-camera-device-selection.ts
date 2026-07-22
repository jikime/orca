import type { Room } from 'livekit-client'
import { translate } from '@/i18n/i18n'

export type MeetingCameraDevice = Pick<MediaDeviceInfo, 'deviceId' | 'label'>

export function resolveMeetingCameraDeviceId(
  devices: MeetingCameraDevice[],
  activeDeviceId: string | undefined,
  selectedDeviceId: string
): string {
  const available = new Set(devices.map((device) => device.deviceId))
  if (activeDeviceId && available.has(activeDeviceId)) {
    return activeDeviceId
  }
  if (selectedDeviceId && available.has(selectedDeviceId)) {
    return selectedDeviceId
  }
  return (
    devices.find((device) => device.deviceId === 'default')?.deviceId ?? devices[0]?.deviceId ?? ''
  )
}

export async function switchMeetingCamera(
  room: Pick<Room, 'switchActiveDevice'>,
  deviceId: string
): Promise<void> {
  if (!(await room.switchActiveDevice('videoinput', deviceId))) {
    throw new Error(
      translate('auto.pie.meetings.MeetingCameraControl.switchFailed', 'Could not switch camera')
    )
  }
}
