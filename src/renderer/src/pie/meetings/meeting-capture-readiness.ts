import type { MeetingCaptureConsent, MeetingCaptureType } from './meeting-types'

export function isMeetingCaptureReady(
  participantIds: readonly string[],
  captureTypes: readonly MeetingCaptureType[],
  consents: readonly MeetingCaptureConsent[],
  now = Date.now()
): boolean {
  if (participantIds.length === 0 || captureTypes.length === 0) {
    return false
  }
  return participantIds.every((participantId) =>
    captureTypes.every((captureType) =>
      consents.some(
        (consent) =>
          consent.participantId === participantId &&
          consent.captureType === captureType &&
          consent.status === 'granted' &&
          consent.currentPolicy &&
          (!consent.expiresAt || new Date(consent.expiresAt).getTime() > now)
      )
    )
  )
}
