import { describe, expect, it } from 'vitest'
import type { MeetingCaptureConsent, MeetingCaptureType } from './meeting-types'
import { isMeetingCaptureReady } from './meeting-capture-readiness'

const NOW = Date.parse('2026-07-21T00:00:00.000Z')

function consent(
  participantId: string,
  captureType: MeetingCaptureType,
  overrides: Partial<MeetingCaptureConsent> = {}
): MeetingCaptureConsent {
  return {
    id: `${participantId}-${captureType}`,
    organizationId: 'organization-1',
    meetingId: 'meeting-1',
    participantId,
    captureType,
    policyVersion: 2,
    purpose: '회의 기록 및 후속 업무 정리',
    status: 'granted',
    currentPolicy: true,
    grantedAt: '2026-07-20T00:00:00.000Z',
    revokedAt: null,
    expiresAt: null,
    version: 1,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides
  }
}

describe('meeting capture readiness', () => {
  it('requires a current grant for every joined participant and selected capture type', () => {
    const consents = [
      consent('participant-1', 'recording'),
      consent('participant-1', 'transcription'),
      consent('participant-2', 'recording'),
      consent('participant-2', 'transcription')
    ]

    expect(
      isMeetingCaptureReady(
        ['participant-1', 'participant-2'],
        ['recording', 'transcription'],
        consents,
        NOW
      )
    ).toBe(true)
  })

  it.each([
    ['stale policy', { currentPolicy: false }],
    ['revoked grant', { status: 'revoked' as const }],
    ['expired grant', { expiresAt: '2026-07-20T23:59:59.000Z' }]
  ])('rejects a %s', (_label, override) => {
    expect(
      isMeetingCaptureReady(
        ['participant-1'],
        ['recording'],
        [consent('participant-1', 'recording', override)],
        NOW
      )
    ).toBe(false)
  })

  it('does not allow capture without both participants and capture types', () => {
    expect(isMeetingCaptureReady([], ['recording'], [], NOW)).toBe(false)
    expect(isMeetingCaptureReady(['participant-1'], [], [], NOW)).toBe(false)
  })
})
