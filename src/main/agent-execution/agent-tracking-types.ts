import type { ExecutionContextHostType } from '../../shared/execution-context-contract'
import type { NormalizedTranscriptRecord } from '../agent-reconcile/agent-reconcile-types'
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
  // Transcript producer (CAP-001 complete source). TODO(pie-r5-hooklive): the live managed-hook
  // receiver joins as a second producer feeding hookEvents into the same reconciler.
  scanTranscripts: () => Promise<readonly NormalizedTranscriptRecord[]>
  // The launch to sign a context for; omitted → identity-only ingest until a live launch source lands.
  getActiveLaunch?: () => ActiveLaunch | null
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
