import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  executionContextSigningBytes,
  type ExecutionContextHostType,
  type SignedExecutionContext
} from './execution-context-canonical'
import { loadInstallationKeyTx } from './installation-key-store'

// R5 slice 2b: server-side verification of a SIGNED ExecutionContext (doc 24 anti-forgery). A
// batch may carry a signed context that names exactly one agentSessionId; verification proves the
// producer holds the private key for a registered installation, that the context is within its
// validity window, and that every event in the batch targets the bound session. On success the
// session records the SIGNED SessionBinding (host discrimination — native/wsl/ssh). This is
// additive: a batch WITHOUT a context ingests exactly as R5 s1 did (local_observed).

export type ExecutionContextRejectionCode =
  | 'CONTEXT_MALFORMED'
  | 'INSTALLATION_MISMATCH'
  | 'CONTEXT_SESSION_MISMATCH'
  | 'CONTEXT_EXPIRED'
  | 'CONTEXT_NOT_YET_VALID'
  | 'KEY_NOT_REGISTERED'
  | 'SIGNATURE_INVALID'
  | 'BINDING_HOST_MISMATCH'

export type VerifiedBinding = {
  installationId: string
  hostType: ExecutionContextHostType
  hostId: string
  workspacePath: string
  notAfter: Date
  publicKeyId: string
}

export type VerifyExecutionContextInput = {
  actorUserId: string
  receivedAtMs: number
  // Distinct agentSessionId of the batch's events — all must equal the context's bound session.
  agentSessionIds: string[]
  signed: SignedExecutionContext
}

export type VerifyExecutionContextResult =
  | { ok: true; binding: VerifiedBinding }
  | { ok: false; code: ExecutionContextRejectionCode }

/**
 * Verifies a signed ExecutionContext under the caller's tenant tx (RLS-scoped). Steps run in a
 * fixed order so the first failing invariant is the reported reason. The key lookup is org-scoped,
 * so a key registered in another org is invisible → KEY_NOT_REGISTERED (cross-tenant isolation).
 */
export async function verifyExecutionContextTx(
  trx: Transaction<Database>,
  input: VerifyExecutionContextInput
): Promise<VerifyExecutionContextResult> {
  const { signed } = input
  const context = signed.context
  // 1. The signed envelope's installationId must match the context it wraps.
  if (signed.installationId !== context.installationId) {
    return { ok: false, code: 'INSTALLATION_MISMATCH' }
  }
  // 2. Every event in the batch must target the single session the context binds.
  if (input.agentSessionIds.some((id) => id !== context.agentSessionId)) {
    return { ok: false, code: 'CONTEXT_SESSION_MISMATCH' }
  }
  // 3. Validity window (server clock): not-yet-valid before, expired after.
  if (input.receivedAtMs < context.notBefore) {
    return { ok: false, code: 'CONTEXT_NOT_YET_VALID' }
  }
  if (input.receivedAtMs > context.notAfter) {
    return { ok: false, code: 'CONTEXT_EXPIRED' }
  }
  // 4. The producer's key must be registered in THIS org (RLS makes cross-tenant keys invisible).
  const key = await loadInstallationKeyTx(trx, {
    userId: input.actorUserId,
    installationId: context.installationId
  })
  if (!key) {
    return { ok: false, code: 'KEY_NOT_REGISTERED' }
  }
  // 5. Ed25519 verify over the canonical signing bytes (a forged/wrong-key signature fails here;
  // a malformed key or signature throws and is treated as an invalid signature, not a crash).
  let signatureValid = false
  try {
    signatureValid = cryptoVerify(
      null,
      executionContextSigningBytes(context),
      createPublicKey(key.public_key),
      Buffer.from(signed.signature, 'base64')
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return { ok: false, code: 'SIGNATURE_INVALID' }
  }
  // 6. Verified: the binding is the context's host identity plus the stored key's fingerprint.
  return {
    ok: true,
    binding: {
      installationId: context.installationId,
      hostType: context.hostType,
      hostId: context.hostId,
      workspacePath: context.workspacePath,
      notAfter: new Date(context.notAfter),
      publicKeyId: key.public_key_id
    }
  }
}

/**
 * Records the verified SessionBinding on the session. If the session already carries a binding to a
 * DIFFERENT host identity (installation/host_type/host_id/workspace) it is a conflict — the caller
 * maps it to BINDING_HOST_MISMATCH (one session must not be silently re-bound to another host).
 * Re-applying the SAME binding is idempotent. Returns {conflict:true} without mutating on conflict.
 */
export async function applySessionBindingTx(
  trx: Transaction<Database>,
  organizationId: string,
  sessionId: string,
  binding: VerifiedBinding
): Promise<{ conflict: boolean }> {
  const current = await trx
    .selectFrom('execution.agent_sessions')
    .select([
      'binding_installation_id',
      'binding_host_type',
      'binding_host_id',
      'binding_workspace_path'
    ])
    .where('id', '=', sessionId)
    .executeTakeFirst()
  if (!current) {
    // No such session in this org — nothing to bind (the per-event loop rejects its events).
    return { conflict: false }
  }
  const alreadyBound =
    current.binding_installation_id !== null ||
    current.binding_host_type !== null ||
    current.binding_host_id !== null ||
    current.binding_workspace_path !== null
  if (
    alreadyBound &&
    (current.binding_installation_id !== binding.installationId ||
      current.binding_host_type !== binding.hostType ||
      current.binding_host_id !== binding.hostId ||
      current.binding_workspace_path !== binding.workspacePath)
  ) {
    return { conflict: true }
  }
  await trx
    .updateTable('execution.agent_sessions')
    .set({
      binding_trust_domain: 'installation_signed',
      binding_installation_id: binding.installationId,
      binding_host_type: binding.hostType,
      binding_host_id: binding.hostId,
      binding_workspace_path: binding.workspacePath,
      binding_not_after: binding.notAfter
    })
    .where('id', '=', sessionId)
    .execute()
  return { conflict: false }
}
