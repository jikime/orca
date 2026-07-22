import { describe, expect, it } from 'vitest'
import { resolveMeetingStageFocus, type MeetingStageParticipant } from './meeting-stage-focus'

function participant(
  identity: string,
  options: Partial<Omit<MeetingStageParticipant, 'identity'>> = {}
): MeetingStageParticipant {
  return { identity, local: false, sharingScreen: false, ...options }
}

describe('meeting stage focus', () => {
  it('promotes a shared screen in either view mode', () => {
    const participants = [
      participant('local', { local: true }),
      participant('presenter', {
        sharingScreen: true
      })
    ]
    expect(resolveMeetingStageFocus(participants, 'gallery', null, [])).toEqual({
      identity: 'presenter',
      source: 'screen'
    })
  })

  it('keeps gallery mode unfocused when nobody is sharing', () => {
    expect(
      resolveMeetingStageFocus([participant('local', { local: true })], 'gallery', null, [])
    ).toBeNull()
  })

  it('prefers a pin, then the active speaker, then a remote participant', () => {
    const participants = [
      participant('local', { local: true }),
      participant('remote-a'),
      participant('remote-b')
    ]
    expect(resolveMeetingStageFocus(participants, 'speaker', 'remote-b', ['remote-a'])).toEqual({
      identity: 'remote-b',
      source: 'camera'
    })
    expect(resolveMeetingStageFocus(participants, 'speaker', null, ['remote-a'])).toEqual({
      identity: 'remote-a',
      source: 'camera'
    })
    expect(resolveMeetingStageFocus(participants, 'speaker', 'missing', [])).toEqual({
      identity: 'remote-a',
      source: 'camera'
    })
  })
})
