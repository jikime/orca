// @vitest-environment happy-dom

import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeetingDevicePreview } from './MeetingDevicePreview'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'group', toJSON: () => ({}) }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => [
        device('videoinput', 'camera-a', 'Built-in camera'),
        device('videoinput', 'camera-b', 'Desk camera'),
        device('audioinput', 'microphone-a', 'Desk microphone'),
        device('audiooutput', 'speaker-a', 'Desk speaker')
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  })
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MeetingDevicePreview', () => {
  it('lists every device class and carries the selected defaults into join', async () => {
    const onJoin = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <MeetingDevicePreview
          joining={false}
          waiting={false}
          connectionError={null}
          diagnostics={{
            status: 'ready',
            controlPlane: 'ready',
            media: 'ready',
            latencyMs: 12,
            checkedAt: new Date().toISOString()
          }}
          diagnosticsLoading={false}
          diagnosticsError={null}
          onRetryDiagnostics={vi.fn()}
          onJoin={onJoin}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="Choose camera"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Choose microphone"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Choose speaker"]')).not.toBeNull()
    const join = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Join meeting')
    )
    act(() => fireEvent.click(join as Element))
    expect(onJoin).toHaveBeenCalledWith({
      cameraEnabled: false,
      microphoneEnabled: false,
      cameraDeviceId: 'camera-a',
      microphoneDeviceId: 'microphone-a',
      speakerDeviceId: 'speaker-a'
    })
  })
})
