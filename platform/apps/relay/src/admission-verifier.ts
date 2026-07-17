import type { RelayRole } from './relay-runtime-deps'

// The relay admits a connection to a room only after an AdmissionVerifier vouches
// for it and assigns a role. This is the ONLY place identity/role is decided;
// the relay then trusts that role for the connection's lifetime (single-driver
// ownership is enforced against it). Kept injectable for B1: a live control-plane
// capability redemption is a B2 concern (see createControlPlaneAdmissionVerifier).

export type AdmissionRequest = {
  sessionId: string
  streamId: string
  // Opaque capability credential presented by the client. In production this is a
  // scoped, short-lived capability token redeemed at the control plane. It is a
  // secret: it MUST NOT be logged or echoed. The relay never interprets it here.
  credential: string
  remoteAddress?: string
}

export type AdmissionDecision =
  | { ok: true; participantId: string; role: RelayRole }
  | { ok: false; reason: string }

export type AdmissionVerifier = {
  verify: (request: AdmissionRequest) => Promise<AdmissionDecision>
}

// Test/dev double: the caller decides the outcome per request. Used by the B1
// suites so admission never depends on a running control plane.
export function createStubAdmissionVerifier(
  decide: (request: AdmissionRequest) => AdmissionDecision | Promise<AdmissionDecision>
): AdmissionVerifier {
  return { verify: async (request) => decide(request) }
}

// B2 seam: redeem the presented capability at the control plane
// (support.remote_session_capabilities: {sessionId, nonce, audience}) and map the
// returned grade to a relay role. Deliberately unimplemented in B1.
export function createControlPlaneAdmissionVerifier(): AdmissionVerifier {
  return {
    verify: async () => {
      // TODO(B2): call control-plane capability redemption; map grade->role.
      throw new Error('control-plane admission verifier is not implemented until B2')
    }
  }
}
