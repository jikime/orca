import { randomUUID } from 'node:crypto'
import { AgentEventOutboxStore } from '../agent-outbox/agent-event-outbox-store'
import { probeSqlite } from '../agent-outbox/agent-event-outbox-sqlite-guard'
import {
  InstallationSigningKey,
  type InstallationSigningIdentity
} from '../agent-execution-context/installation-signing-key'
import { isSafeModeSubsystemDisabled } from '../pie-safe-mode/safe-mode-state'
import { loadPieAgentTrackingConfig, resolveAgentOutboxPath } from './agent-tracking-config'
import { composeTracking, errorReason } from './agent-tracking-runtime'
import { registerInstallationKey } from './installation-key-registration-client'
import type {
  AgentTrackingHandle,
  AgentTrackingLog,
  StartAgentTrackingDeps
} from './agent-tracking-types'

// Electron composition root for the R5 agent-execution-tracking pipeline. Dev-gated
// (PIE_AGENT_TRACKING) and safe-mode gated ('pie-agent-tracking'), so it is a strict no-op by
// default and never touches SQLite/network unless explicitly enabled AND signed in. All app-facing
// concerns are INJECTED seams (auth getters, scanner, clock, client, key, scheduler) so the whole
// subsystem is unit-testable without Electron. It composes the merged pieces — never changes them.

export type {
  ActiveLaunch,
  AgentTrackingHandle,
  AgentTrackingLog,
  StartAgentTrackingDeps
} from './agent-tracking-types'

let currentHandle: AgentTrackingHandle | null = null

/**
 * Starts the agent-execution-tracking pipeline only when dev-gated ON, not safe-mode disabled, and
 * a signed-in org is present. Returns null (a strict no-op) otherwise — no outbox opened, no timers,
 * no network. Degrades safely (logs, stays inert) if packaged SQLite cannot run the outbox schema.
 */
export function startAgentTrackingIfEnabled(
  deps: StartAgentTrackingDeps
): AgentTrackingHandle | null {
  const config = deps.config ?? loadPieAgentTrackingConfig(deps.env)
  const isDisabled = deps.isDisabled ?? (() => isSafeModeSubsystemDisabled('pie-agent-tracking'))
  const organizationId = deps.getOrganizationId()
  if (!config.enabled || isDisabled() || !organizationId) {
    return null
  }

  const log = deps.log ?? (() => {})
  const clock = deps.clock ?? Date.now
  const newId = deps.newId ?? randomUUID
  const outboxPath = resolveAgentOutboxPath(deps.getUserDataPath())

  // Degrade-not-crash: an unusable packaged SQLite must never crash capture/app. Log a structured
  // diagnostic (no secrets) and leave the subsystem inert.
  const probe = (deps.probeSqliteImpl ?? probeSqlite)(outboxPath)
  if (!probe.usable) {
    log('[pie-agent-tracking] sqlite unusable; tracking disabled', { reason: probe.reason ?? null })
    currentHandle = null
    return null
  }

  let store: AgentEventOutboxStore
  try {
    store = (deps.createStore ?? ((path) => new AgentEventOutboxStore(path)))(outboxPath)
  } catch (error) {
    log('[pie-agent-tracking] outbox open failed; tracking disabled', {
      reason: errorReason(error)
    })
    return null
  }

  const identity = resolveSigningIdentity(deps, log)
  if (identity) {
    // Register the PUBLIC key once at start (idempotent server-side). Failure logs + continues at
    // identity-based trust — registration must never block capture.
    void registerPublicKeyOnce(deps, organizationId, identity, log)
  }

  const handle = composeTracking({
    deps,
    config,
    store,
    identity,
    organizationId,
    clock,
    newId,
    log
  })
  currentHandle = handle
  return handle
}

function resolveSigningIdentity(
  deps: StartAgentTrackingDeps,
  log: AgentTrackingLog
): InstallationSigningIdentity | null {
  const factory = deps.createInstallationKey ?? ((options) => new InstallationSigningKey(options))
  const result = factory({
    safeStorage: deps.safeStorage,
    getUserDataPath: deps.getUserDataPath,
    platform: deps.platform
  }).getOrCreate()
  if (result.status === 'ready') {
    return result.identity
  }
  // Secure storage unavailable → no persisted private key. Fall back to identity-only ingest; never
  // a plaintext key.
  log('[pie-agent-tracking] signing key unavailable; identity-only ingest', {
    reason: result.reason
  })
  return null
}

async function registerPublicKeyOnce(
  deps: StartAgentTrackingDeps,
  organizationId: string,
  identity: InstallationSigningIdentity,
  log: AgentTrackingLog
): Promise<void> {
  const register = deps.registerKey ?? registerInstallationKey
  try {
    await register(
      {
        getApiBaseUrl: deps.getApiBaseUrl,
        getAccessToken: deps.getAccessToken,
        fetchImpl: deps.fetchImpl,
        newId: deps.newId
      },
      {
        organizationId,
        installationId: identity.installationId,
        publicKeyPem: identity.publicKeyPem
      }
    )
  } catch (error) {
    log('[pie-agent-tracking] installation-key registration failed; continuing', {
      reason: errorReason(error)
    })
  }
}

/** Clears timers, flushes/closes the outbox, and is idempotent. Safe to call when never started. */
export function stopAgentTracking(): void {
  currentHandle?.stop()
  currentHandle = null
}

export function __resetAgentTrackingForTests(): void {
  currentHandle = null
}
