import { win32, posix } from 'node:path'
import {
  canonicalizeExecutionContext,
  ExecutionContextSchema,
  SignedExecutionContextSchema,
  EXECUTION_CONTEXT_SCHEMA_VERSION,
  type ExecutionContext,
  type ExecutionContextHostType,
  type SignedExecutionContext
} from '../../shared/execution-context-contract'
import type { InstallationSigningIdentity } from './installation-signing-key'

// R5 slice 2b: builds and signs an ExecutionContext for one capture launch. Pure given its inputs
// and the injected clock — notBefore=now, notAfter=now+TTL — so the signer is deterministic and
// timer-free. The signature covers the canonical bytes (doc 24 anti-forgery); a stale/forged
// context is caught by the server's validity-window + signature checks.

// workspacePath must be normalized PER HOST before it enters the signed context: the same logical
// path must serialize identically every launch (so a re-signed context re-binds the same session),
// and native vs WSL vs SSH at the "same" path must stay distinguishable. No `/` assumption — native
// follows the running OS's separators; wsl/ssh are POSIX inside their host.
export function normalizeWorkspacePathForHost(
  hostType: ExecutionContextHostType,
  workspacePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (hostType === 'wsl' || hostType === 'ssh') {
    return posix.normalize(workspacePath)
  }
  // native
  if (platform === 'win32') {
    const normalized = win32.normalize(workspacePath)
    // Windows paths are case-insensitive; upper-case the drive letter so casing never forks a bind.
    return normalized.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
  }
  return posix.normalize(workspacePath)
}

export type BuildSignedExecutionContextParams = {
  identity: InstallationSigningIdentity
  hostType: ExecutionContextHostType
  hostId: string
  workspacePath: string
  // OS account the agent runs as; local for native, the REMOTE user for an SSH launch (IDN-008).
  osUser: string
  launchId: string
  agentSessionId: string
  provider: string
  // Injected clock — the pure signer never reads ambient Date.now beyond this value.
  nowMs: number
  ttlMs: number
  platform?: NodeJS.Platform
}

export function buildSignedExecutionContext(
  params: BuildSignedExecutionContextParams
): SignedExecutionContext {
  const context: ExecutionContext = ExecutionContextSchema.parse({
    schemaVersion: EXECUTION_CONTEXT_SCHEMA_VERSION,
    installationId: params.identity.installationId,
    hostType: params.hostType,
    hostId: params.hostId,
    workspacePath: normalizeWorkspacePathForHost(
      params.hostType,
      params.workspacePath,
      params.platform
    ),
    osUser: params.osUser,
    launchId: params.launchId,
    agentSessionId: params.agentSessionId,
    provider: params.provider,
    notBefore: params.nowMs,
    notAfter: params.nowMs + params.ttlMs
  })
  const signature = params.identity.sign(
    Buffer.from(canonicalizeExecutionContext(context), 'utf-8')
  )
  return SignedExecutionContextSchema.parse({
    context,
    installationId: params.identity.installationId,
    signature: signature.toString('base64'),
    publicKeyId: params.identity.publicKeyId
  })
}
