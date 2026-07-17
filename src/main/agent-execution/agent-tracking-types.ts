import type { ExecutionContextHostType } from '../../shared/execution-context-contract'
import type {
  NormalizedHookEvent,
  NormalizedTranscriptRecord
} from '../agent-reconcile/agent-reconcile-types'
import type { AgentHookEventSubscribe } from './hook-event-tap'
import type { LaunchResolveInput } from './active-launch-registry'
import type { AgentEventOutboxStore } from '../agent-outbox/agent-event-outbox-store'
import type { AgentEventUploadClient } from '../agent-outbox/agent-event-upload-client'
import type { SqliteGuardResult } from '../agent-outbox/agent-event-outbox-sqlite-guard'
import type {
  InstallationSigningKeyOptions,
  InstallationSigningKeyResult
} from '../agent-execution-context/installation-signing-key'
import type { PieAgentTrackingConfig } from './agent-tracking-config'
import type { RegisterInstallationKeyParams } from './installation-key-registration-client'

// Shared seams for the agent-execution-tracking composition. Kept separate so the service (start/stop
// lifecycle) and the runtime (pump/scan/signing loop) can both reference them without a cycle.

export type AgentTrackingLog = (message: string, meta?: Record<string, unknown>) => void

// The active capture launch to sign an ExecutionContext for. Null (no live launch source yet) →
// identity-only ingest, which the pump supports for back-compat.
export type ActiveLaunch = {
  hostType: ExecutionContextHostType
  hostId: string
  workspacePath: string
  // OS account the agent runs as; local for native, the REMOTE user for an SSH launch (IDN-008).
  osUser: string
  launchId: string
  agentSessionId: string
  provider: string
}

export type InstallationKeyLike = { getOrCreate: () => InstallationSigningKeyResult }

export type StartAgentTrackingDeps = {
  env?: NodeJS.ProcessEnv
  isDisabled?: () => boolean
  // Auth seams — re-read every cycle so a revoke/rotate/org-switch is reflected immediately (CAP-006).
  getAccessToken: () => string | null
  getApiBaseUrl: () => string | null
  getOrganizationId: () => string | null
  // Installation signing-key material (Electron safeStorage + user-data dir in production).
  safeStorage: InstallationSigningKeyOptions['safeStorage']
  getUserDataPath: () => string
  platform?: NodeJS.Platform
  // Transcript producer (CAP-001 complete source).
  scanTranscripts: () => Promise<readonly NormalizedTranscriptRecord[]>
  // Live managed-hook producer: the second source. Drained each scan cycle and merged with the
  // transcript records in the same reconciler. The service builds it from the hook-event tap when a
  // subscription seam is present; composeTracking tests inject it directly to stay pure.
  drainHookEvents?: () => readonly NormalizedHookEvent[]
  // The launch to sign a context for; omitted → identity-only ingest. The service wires this to the
  // active-launch registry (fed by the hook stream) when a hook subscription seam is present.
  getActiveLaunch?: () => ActiveLaunch | null
  // Additive tap onto the live managed-hook pipeline (agentHookServer.subscribeAgentHookEvents).
  // When present, the service starts the hook-event tap + launch registry; absent → transcript-only
  // (unchanged behavior). Inert until a subscriber registers, so agent-status is never affected.
  subscribeAgentHookEvents?: AgentHookEventSubscribe
  // Optional real-path resolver for the launch registry (default uses the hook's worktreeId).
  resolveLaunchWorkspacePath?: (input: LaunchResolveInput) => string | null
  // The local OS user (default os.userInfo().username); injected for deterministic tests.
  getLocalOsUser?: () => string
  // Optional remote-user resolver for SSH launches (default: remote launch stays unbindable so it is
  // never signed as the local desktop user — IDN-008).
  resolveLaunchOsUser?: (input: LaunchResolveInput) => string | null
  // Deterministic seams.
  clock?: () => number
  newId?: () => string
  fetchImpl?: typeof fetch
  scheduleInterval?: (fn: () => void, ms: number) => { clear: () => void }
  // Test seams.
  config?: PieAgentTrackingConfig
  probeSqliteImpl?: (path: string) => SqliteGuardResult
  createStore?: (path: string) => AgentEventOutboxStore
  createInstallationKey?: (options: InstallationSigningKeyOptions) => InstallationKeyLike
  uploadClient?: AgentEventUploadClient
  registerKey?: (
    deps: {
      getApiBaseUrl: () => string | null
      getAccessToken: () => string | null
      fetchImpl?: typeof fetch
      newId?: () => string
    },
    params: RegisterInstallationKeyParams
  ) => Promise<void>
  log?: AgentTrackingLog
}

export type AgentTrackingHandle = {
  pumpOnce: () => Promise<void>
  scanOnce: () => Promise<void>
  stop: () => void
}
