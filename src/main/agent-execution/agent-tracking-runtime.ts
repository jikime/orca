import type { SignedExecutionContext } from '../../shared/execution-context-contract'
import { buildSignedExecutionContext } from '../agent-execution-context/execution-context-signer'
import type { InstallationSigningIdentity } from '../agent-execution-context/installation-signing-key'
import { reconcileAgentEvents } from '../agent-reconcile/agent-event-reconciler'
import type { AgentEventOutboxStore } from '../agent-outbox/agent-event-outbox-store'
import { createAgentEventUploadClient } from '../agent-outbox/agent-event-upload-client'
import { createUploadPump } from '../agent-outbox/agent-event-upload-pump'
import type { PieAgentTrackingConfig } from './agent-tracking-config'
import type {
  AgentTrackingHandle,
  AgentTrackingLog,
  StartAgentTrackingDeps
} from './agent-tracking-types'

// The running loop: builds the upload pump + reconcile-into-outbox scan cycle and the unref'd
// schedulers. Split from the service so the lifecycle file stays small; all timing/auth/signing is
// re-evaluated per cycle from injected seams (CAP-006, doc 24 no-stale-context).

const DEFAULT_BATCH_LIMIT = 128
const DEFAULT_BATCH_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_BACKOFF_BASE_MS = 1_000
const DEFAULT_BACKOFF_CAP_MS = 60_000
const OUTBOX_MAX_ROWS = 50_000
const OUTBOX_MAX_BYTES = 64 * 1024 * 1024
// Re-sign a little before expiry so a steady pump never presents a just-expired context.
const CONTEXT_REFRESH_SKEW_MS = 30_000
const IDENTITY_ONLY_PRODUCER_ID = 'pie-desktop-local'

export function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function defaultScheduleInterval(fn: () => void, ms: number): { clear: () => void } {
  const timer = setInterval(fn, ms)
  // unref so the pump/scan cadence never keeps the app alive on quit (no busy loop).
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
  return { clear: () => clearInterval(timer) }
}

export type ComposeTrackingArgs = {
  deps: StartAgentTrackingDeps
  config: PieAgentTrackingConfig
  store: AgentEventOutboxStore
  identity: InstallationSigningIdentity | null
  organizationId: string
  clock: () => number
  newId: () => string
  log: AgentTrackingLog
}

export function composeTracking(args: ComposeTrackingArgs): AgentTrackingHandle {
  const { deps, config, store, identity, organizationId, clock, newId, log } = args

  const uploadClient =
    deps.uploadClient ??
    createAgentEventUploadClient({
      getApiBaseUrl: deps.getApiBaseUrl,
      getAccessToken: deps.getAccessToken,
      fetchImpl: deps.fetchImpl
    })

  // CAP-006: re-checked before every claim/upload. A revoked/rotated login or an org switch stops
  // uploads on the very next cycle.
  const isUploadAuthorized = (): boolean =>
    Boolean(deps.getAccessToken()) &&
    Boolean(deps.getApiBaseUrl()) &&
    deps.getOrganizationId() === organizationId

  let signedContext: SignedExecutionContext | null = null
  const refreshSignedContext = (now: number): void => {
    const launch = identity ? (deps.getActiveLaunch?.() ?? null) : null
    if (!identity || !launch) {
      signedContext = null
      return
    }
    const stillFresh =
      signedContext !== null &&
      signedContext.context.launchId === launch.launchId &&
      now < signedContext.context.notAfter - CONTEXT_REFRESH_SKEW_MS
    if (stillFresh) {
      return
    }
    signedContext = buildSignedExecutionContext({
      identity,
      hostType: launch.hostType,
      hostId: launch.hostId,
      workspacePath: launch.workspacePath,
      launchId: launch.launchId,
      agentSessionId: launch.agentSessionId,
      provider: launch.provider,
      nowMs: now,
      ttlMs: config.contextTtlMs,
      platform: deps.platform
    })
  }

  const pump = createUploadPump({
    store,
    uploadClient,
    organizationId,
    producerId: identity?.installationId ?? IDENTITY_ONLY_PRODUCER_ID,
    isUploadAuthorized,
    executionContext: () => signedContext,
    clock,
    newId,
    batchLimit: DEFAULT_BATCH_LIMIT,
    maxBytes: DEFAULT_BATCH_MAX_BYTES,
    backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
    backoffCapMs: DEFAULT_BACKOFF_CAP_MS,
    // Hold (do not purge) on revoke: dev-gated capture keeps events for a possible re-grant.
    revokePolicy: 'hold',
    onAudit: (record) => log('[pie-agent-tracking] outbox audit', { reason: record.reason })
  })

  const quota = {
    limits: { maxRows: OUTBOX_MAX_ROWS, maxBytes: OUTBOX_MAX_BYTES },
    onAudit: (record: { reason: string }) =>
      log('[pie-agent-tracking] enqueue audit', { reason: record.reason }),
    // SYN-002: surface degradation stage changes (no payload content) so ops can see the outbox
    // shed non-observed load before it fills the disk.
    onStageTransition: (transition: { from: string; to: string }) =>
      log('[pie-agent-tracking] outbox quota stage', {
        from: transition.from,
        to: transition.to
      })
  }

  let pumping = false
  const pumpOnce = async (): Promise<void> => {
    if (pumping) {
      return
    }
    pumping = true
    try {
      refreshSignedContext(clock())
      await pump.pumpOnce()
    } catch (error) {
      log('[pie-agent-tracking] pump cycle failed', { reason: errorReason(error) })
    } finally {
      pumping = false
    }
  }

  let scanning = false
  const scanOnce = async (): Promise<void> => {
    if (scanning) {
      return
    }
    scanning = true
    try {
      const records = await deps.scanTranscripts()
      // Second producer: the live managed-hook tap drains here and merges with the transcript
      // scanner; the reconciler dedupes the two (CAP-001/002/003). Reconcile when EITHER source has
      // events so a hook-only turn is not dropped when the transcript has not flushed yet.
      const hookEvents = deps.drainHookEvents?.() ?? []
      if (records.length === 0 && hookEvents.length === 0) {
        return
      }
      reconcileAgentEvents({
        hookEvents,
        transcriptRecords: records,
        enqueue: (event) => {
          store.enqueue(event, { now: clock(), quota })
        }
      })
    } catch (error) {
      log('[pie-agent-tracking] scan cycle failed', { reason: errorReason(error) })
    } finally {
      scanning = false
    }
  }

  const schedule = deps.scheduleInterval ?? defaultScheduleInterval
  const pumpTimer = schedule(() => void pumpOnce(), config.pumpIntervalMs)
  const scanTimer = schedule(() => void scanOnce(), config.scanIntervalMs)

  let stopped = false
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    pumpTimer.clear()
    scanTimer.clear()
    try {
      store.close()
    } catch {
      // Closing a half-open store on quit must never throw.
    }
  }

  return { pumpOnce, scanOnce, stop }
}
