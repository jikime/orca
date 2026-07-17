// Client-side mirror of the AUTHORITATIVE driver/consent state that the control
// plane (A2 capability + A3 arbitration) owns. It holds no authority of its own —
// it only reflects the decisions pushed over the control-plane realtime (here the
// signals are injected seams) and exposes two kinds of gate:
//   • hasLocalDriverRole()  — the local driver client's send permission.
//   • isAuthorizedDriver()/isInputAllowed() — the host receiver's defense-in-depth
//     gate, re-checked PER FRAME so a stale "was driver" is never trusted.
// It also emits best-effort local audit for every takeover-relevant transition.
// The control plane keeps the FK-anchored source-of-truth audit (A3); this local
// emission matches the doc's FK-free best-effort audit pattern.

export type RelayParticipant = { participantId: string; role: 'driver' | 'viewer' }

export type TakeoverAuditEvent =
  | { kind: 'driver_granted'; driverId: string }
  | { kind: 'driver_handoff'; fromDriverId: string | null; toDriverId: string }
  | { kind: 'driver_revoked'; driverId: string | null }
  | { kind: 'input_blocked_consent_revoked' }
  | { kind: 'input_blocked_policy_expired' }
  | {
      kind: 'control_rejected'
      reason: 'not_driver' | 'input_blocked' | 'malformed'
      sender?: RelayParticipant
    }

export type TakeoverAuditSink = (event: TakeoverAuditEvent) => void

export type CollabDriverStateMirrorConfig = {
  // The relay participant id of THIS client, used to answer hasLocalDriverRole().
  localParticipantId: string
  audit: TakeoverAuditSink
}

export type CollabDriverStateMirror = {
  // Local driver client's send gate: true only while A3 names this client driver.
  hasLocalDriverRole(): boolean
  // Host receiver gates (defense-in-depth; called per incoming control frame).
  isAuthorizedDriver(sender: RelayParticipant): boolean
  isInputAllowed(): boolean
  // Control-plane realtime signals (injected seams).
  onDriverGranted(driverId: string): void
  onDriverHandoff(toDriverId: string): void
  onDriverRevoked(): void
  onConsentConfirmed(): void
  onConsentRevoked(): void
  onPolicyExpired(): void
  // Reboot / user-switch: drop ALL cached authority. Nothing is reused until the
  // control plane re-confirms fresh driver + consent state (principle 39).
  onSessionInvalidated(): void
}

export function createCollabDriverStateMirror(
  config: CollabDriverStateMirrorConfig
): CollabDriverStateMirror {
  // driverId === null means no driver holds the session right now.
  let driverId: string | null = null
  let consentActive = false
  let policyExpired = false

  return {
    hasLocalDriverRole: () => driverId !== null && driverId === config.localParticipantId,
    isAuthorizedDriver: (sender) => driverId !== null && sender.participantId === driverId,
    isInputAllowed: () => consentActive && !policyExpired,
    onDriverGranted(id) {
      driverId = id
      config.audit({ kind: 'driver_granted', driverId: id })
    },
    onDriverHandoff(toDriverId) {
      // Synchronous swap: the old driver is no longer authorized the instant the
      // new one is, so there is no window where both write.
      const fromDriverId = driverId
      driverId = toDriverId
      config.audit({ kind: 'driver_handoff', fromDriverId, toDriverId })
    },
    onDriverRevoked() {
      const revoked = driverId
      driverId = null
      config.audit({ kind: 'driver_revoked', driverId: revoked })
    },
    onConsentConfirmed() {
      consentActive = true
    },
    onConsentRevoked() {
      // Immediate block on revoke (principle 7): flip the gate before anything can
      // read it again.
      consentActive = false
      config.audit({ kind: 'input_blocked_consent_revoked' })
    },
    onPolicyExpired() {
      policyExpired = true
      config.audit({ kind: 'input_blocked_policy_expired' })
    },
    onSessionInvalidated() {
      // Do NOT reuse any cached capability/driver identity across reboot or
      // user-switch; force re-validation from a clean, un-authorized state.
      driverId = null
      consentActive = false
      policyExpired = false
    }
  }
}
