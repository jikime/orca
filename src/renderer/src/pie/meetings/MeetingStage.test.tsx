// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('livekit-client', () => ({
  Track: {
    Source: {
      Camera: 'camera',
      ScreenShare: 'screen_share'
    }
  }
}))

vi.mock('./MeetingParticipantAudio', () => ({
  MeetingParticipantAudio: () => null
}))

vi.mock('./MeetingParticipantTile', () => ({
  MeetingParticipantTile: ({
    participant,
    source = 'camera'
  }: {
    participant: { identity: string }
    source?: string
  }) => <div data-participant={participant.identity} data-source={source} />
}))

import type { Participant } from 'livekit-client'
import { MeetingStage } from './MeetingStage'

function participant(identity: string, sharingScreen = false): Participant {
  return {
    identity,
    name: identity,
    getTrackPublication: vi.fn((source: string) =>
      sharingScreen && source === 'screen_share' ? { track: {}, isMuted: false } : undefined
    )
  } as unknown as Participant
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderStage(participants: Participant[]): HTMLDivElement {
  const nextContainer = document.createElement('div')
  container = nextContainer
  document.body.appendChild(nextContainer)
  root = createRoot(nextContainer)
  act(() => {
    root?.render(
      <MeetingStage
        participants={participants}
        localParticipant={participants[0]}
        activeSpeakerIds={[]}
        captions={[]}
      />
    )
  })
  return nextContainer
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('MeetingStage', () => {
  it('renders local and remote participants together in gallery view', () => {
    const stage = renderStage([participant('local'), participant('remote')])
    expect(
      [...stage.querySelectorAll('[data-participant]')].map((tile) =>
        tile.getAttribute('data-participant')
      )
    ).toEqual(['local', 'remote'])
  })

  it('promotes a shared screen while retaining participant cameras in the filmstrip', () => {
    const stage = renderStage([participant('local'), participant('presenter', true)])
    expect(
      stage.querySelector('[data-participant="presenter"][data-source="screen_share"]')
    ).not.toBeNull()
    expect(stage.querySelectorAll('[data-source="camera"]')).toHaveLength(2)
  })
})
