// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const liveKit = vi.hoisted(() => ({
  getLocalDevices: vi.fn()
}))

vi.mock('livekit-client', () => ({
  Room: { getLocalDevices: liveKit.getLocalDevices },
  RoomEvent: {
    MediaDevicesChanged: 'mediaDevicesChanged',
    ActiveDeviceChanged: 'activeDeviceChanged'
  }
}))

import { MeetingCameraControl } from './MeetingCameraControl'
import {
  resolveMeetingCameraDeviceId,
  switchMeetingCamera,
  type MeetingCameraDevice
} from './meeting-camera-device-selection'
import type { Room } from 'livekit-client'

function device(deviceId: string, label: string): MeetingCameraDevice {
  return { deviceId, label }
}

function createRoom(activeDeviceId = 'camera-a'): Room {
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const room = {
    localParticipant: {
      isCameraEnabled: false,
      setCameraEnabled: vi.fn(async () => undefined)
    },
    getActiveDevice: vi.fn(() => activeDeviceId),
    switchActiveDevice: vi.fn(async () => true),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return room
    }),
    off: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.get(event)?.delete(listener)
      return room
    })
  }
  return room as unknown as Room
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderControl(room: Room): Promise<HTMLDivElement> {
  const nextContainer = document.createElement('div')
  container = nextContainer
  document.body.appendChild(nextContainer)
  root = createRoot(nextContainer)
  await act(async () => {
    root?.render(
      <MeetingCameraControl
        room={room}
        disabled={false}
        onBusyChange={vi.fn()}
        onError={vi.fn()}
        onChanged={vi.fn()}
      />
    )
    await Promise.resolve()
  })
  return nextContainer
}

beforeEach(() => {
  liveKit.getLocalDevices.mockReset()
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('meeting camera device selection', () => {
  it('keeps an available active or selected camera and otherwise falls back to default', () => {
    const devices = [device('default', 'Default'), device('camera-a', 'Desk camera')]
    expect(resolveMeetingCameraDeviceId(devices, 'camera-a', '')).toBe('camera-a')
    expect(resolveMeetingCameraDeviceId(devices, undefined, 'camera-a')).toBe('camera-a')
    expect(resolveMeetingCameraDeviceId(devices, 'removed', 'removed')).toBe('default')
  })

  it('switches the LiveKit video input and rejects an unsuccessful switch', async () => {
    const switchActiveDevice = vi.fn(async () => true)
    await switchMeetingCamera(
      { switchActiveDevice } as unknown as Pick<Room, 'switchActiveDevice'>,
      'camera-b'
    )
    expect(switchActiveDevice).toHaveBeenCalledWith('videoinput', 'camera-b')

    await expect(
      switchMeetingCamera(
        { switchActiveDevice: vi.fn(async () => false) } as unknown as Pick<
          Room,
          'switchActiveDevice'
        >,
        'camera-b'
      )
    ).rejects.toThrow('Could not switch camera')
  })

  it('shows the camera selector only when more than one camera is available', async () => {
    liveKit.getLocalDevices.mockResolvedValueOnce([device('camera-a', 'Built-in camera')])
    const singleCamera = await renderControl(createRoom())
    expect(singleCamera.querySelector('[data-slot="select-trigger"]')).toBeNull()

    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    liveKit.getLocalDevices.mockResolvedValueOnce([
      device('camera-a', 'Built-in camera'),
      device('camera-b', 'Desk camera')
    ])
    const multipleCameras = await renderControl(createRoom())
    expect(multipleCameras.querySelector('[data-slot="select-trigger"]')).not.toBeNull()
    expect(
      multipleCameras.querySelector('[data-slot="select-trigger"]')?.getAttribute('aria-label')
    ).toBe('Choose camera')
  })
})
