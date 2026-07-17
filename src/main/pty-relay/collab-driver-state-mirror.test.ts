import { expect, test, vi } from 'vitest'
import {
  createCollabDriverStateMirror,
  type TakeoverAuditEvent
} from './collab-driver-state-mirror'

// Pure gate/audit logic of the client driver-state mirror. The relay E2E proofs
// in pty-relay-control.test.ts wire this to a real driver/host over the relay.

function makeMirror(localParticipantId = 'me') {
  const events: TakeoverAuditEvent[] = []
  const mirror = createCollabDriverStateMirror({
    localParticipantId,
    audit: (event) => events.push(event)
  })
  return { mirror, events }
}

test('a fresh mirror grants no role and blocks input until the control plane confirms', () => {
  const { mirror } = makeMirror('me')
  expect(mirror.hasLocalDriverRole()).toBe(false)
  expect(mirror.isInputAllowed()).toBe(false)
  expect(mirror.isAuthorizedDriver({ participantId: 'me', role: 'driver' })).toBe(false)
})

test('driver grant to the local id enables the local role and audits the grant', () => {
  const { mirror, events } = makeMirror('me')
  mirror.onConsentConfirmed()
  mirror.onDriverGranted('me')
  expect(mirror.hasLocalDriverRole()).toBe(true)
  expect(mirror.isAuthorizedDriver({ participantId: 'me', role: 'driver' })).toBe(true)
  expect(mirror.isInputAllowed()).toBe(true)
  expect(events).toContainEqual({ kind: 'driver_granted', driverId: 'me' })
})

test('a grant to another participant does not give the local client the role', () => {
  const { mirror } = makeMirror('me')
  mirror.onDriverGranted('someone-else')
  expect(mirror.hasLocalDriverRole()).toBe(false)
  expect(mirror.isAuthorizedDriver({ participantId: 'someone-else', role: 'driver' })).toBe(true)
})

test('handoff moves authority atomically and audits from/to', () => {
  const { mirror, events } = makeMirror('me')
  mirror.onDriverGranted('driver-a')
  mirror.onDriverHandoff('driver-b')
  expect(mirror.isAuthorizedDriver({ participantId: 'driver-a', role: 'driver' })).toBe(false)
  expect(mirror.isAuthorizedDriver({ participantId: 'driver-b', role: 'driver' })).toBe(true)
  expect(events).toContainEqual({
    kind: 'driver_handoff',
    fromDriverId: 'driver-a',
    toDriverId: 'driver-b'
  })
})

test('revoke clears authority and audits the revoked id', () => {
  const { mirror, events } = makeMirror('me')
  mirror.onDriverGranted('me')
  mirror.onDriverRevoked()
  expect(mirror.hasLocalDriverRole()).toBe(false)
  expect(mirror.isAuthorizedDriver({ participantId: 'me', role: 'driver' })).toBe(false)
  expect(events).toContainEqual({ kind: 'driver_revoked', driverId: 'me' })
})

test('consent revoke blocks input immediately and audits the block', () => {
  const { mirror, events } = makeMirror('me')
  mirror.onConsentConfirmed()
  mirror.onDriverGranted('me')
  expect(mirror.isInputAllowed()).toBe(true)
  mirror.onConsentRevoked()
  expect(mirror.isInputAllowed()).toBe(false)
  expect(events).toContainEqual({ kind: 'input_blocked_consent_revoked' })
})

test('policy expiry blocks input and audits the block', () => {
  const { mirror, events } = makeMirror('me')
  mirror.onConsentConfirmed()
  mirror.onDriverGranted('me')
  mirror.onPolicyExpired()
  expect(mirror.isInputAllowed()).toBe(false)
  expect(events).toContainEqual({ kind: 'input_blocked_policy_expired' })
})

test('session invalidation drops cached authority; nothing is reused until re-confirmed', () => {
  const { mirror } = makeMirror('me')
  mirror.onConsentConfirmed()
  mirror.onDriverGranted('me')
  expect(mirror.hasLocalDriverRole()).toBe(true)

  // Reboot / user-switch: cached capability + driver identity must NOT survive.
  mirror.onSessionInvalidated()
  expect(mirror.hasLocalDriverRole()).toBe(false)
  expect(mirror.isInputAllowed()).toBe(false)
  expect(mirror.isAuthorizedDriver({ participantId: 'me', role: 'driver' })).toBe(false)

  // Only fresh, re-validated state restores authority.
  mirror.onConsentConfirmed()
  mirror.onDriverGranted('me')
  expect(mirror.hasLocalDriverRole()).toBe(true)
  expect(mirror.isInputAllowed()).toBe(true)
})

test('audit sink is invoked for every takeover transition (best-effort local audit)', () => {
  const audit = vi.fn()
  const mirror = createCollabDriverStateMirror({ localParticipantId: 'me', audit })
  mirror.onDriverGranted('me')
  mirror.onDriverHandoff('other')
  mirror.onDriverRevoked()
  mirror.onConsentRevoked()
  mirror.onPolicyExpired()
  const kinds = audit.mock.calls.map((c) => (c[0] as TakeoverAuditEvent).kind)
  expect(kinds).toEqual([
    'driver_granted',
    'driver_handoff',
    'driver_revoked',
    'input_blocked_consent_revoked',
    'input_blocked_policy_expired'
  ])
})
