import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { ExecutionContextHostType } from '../../shared/execution-context-contract'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import type { ActiveLaunch } from './agent-tracking-types'
import { mapHookEventNameToKind, type AgentHookEventSubscribe } from './hook-event-tap'

// Tracks the live agent launches the signer binds a SignedExecutionContext to. A launch is a live
// agent session on a workspace/host (sessionId, provider, workspacePath, hostType/hostId), derived
// from the same managed-hook stream the tap consumes. Pure/deterministic given the injected clock:
// a launch expires on TTL (staleness) or when its session emits a `stop` (turn ended, nothing to
// sign until the next prompt). getActiveLaunch returns the launch — or null → identity-only ingest.

const DEFAULT_TTL_MS = 5 * 60_000

export type LaunchResolveInput = {
  agentSessionId: string
  provider: string
  hostType: ExecutionContextHostType
  hostId: string
  worktreeId?: string
  launchId: string
}

export type ActiveLaunchRegistryDeps = {
  clock: () => number
  ttlMs?: number
  // The hook payload carries an Orca worktreeId, not a filesystem path. The composition root may map
  // it to a real per-host path; the default uses the worktreeId as the stable per-host workspace
  // identity (null → launch stays unbindable and getActiveLaunch yields null).
  resolveWorkspacePath?: (input: LaunchResolveInput) => string | null
  // The local OS account this process runs as (os.userInfo().username), injected for determinism.
  localOsUser: string
  // osUser-disambiguates-shared-host (IDN-008): a native launch runs as localOsUser; an SSH launch
  // runs as the REMOTE user, resolved from the launch origin here (null → unbindable, never the
  // local user, so a remote launch is never mis-attributed to whoever runs the desktop).
  resolveOsUser?: (input: LaunchResolveInput) => string | null
}

export type ActiveLaunchRegistry = {
  start: (subscribe: AgentHookEventSubscribe) => void
  observe: (payload: AgentHookEventPayload) => void
  getActiveLaunch: (agentSessionId: string) => ActiveLaunch | null
  getCurrentActiveLaunch: () => ActiveLaunch | null
  stop: () => void
}

type TrackedLaunch = ActiveLaunch & { lastSeenAt: number }

function toActiveLaunch(tracked: TrackedLaunch): ActiveLaunch {
  return {
    hostType: tracked.hostType,
    hostId: tracked.hostId,
    workspacePath: tracked.workspacePath,
    osUser: tracked.osUser,
    launchId: tracked.launchId,
    agentSessionId: tracked.agentSessionId,
    provider: tracked.provider
  }
}

export function createActiveLaunchRegistry(deps: ActiveLaunchRegistryDeps): ActiveLaunchRegistry {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const resolveWorkspacePath = deps.resolveWorkspacePath ?? ((input) => input.worktreeId ?? null)
  // Native runs as the local user; a remote/SSH origin has no default (must be injected) so it is
  // never silently attributed to the desktop user.
  const resolveOsUser =
    deps.resolveOsUser ?? ((input) => (input.hostType === 'native' ? deps.localOsUser : null))
  const launches = new Map<string, TrackedLaunch>()
  // Most-recent-first ordering for the runtime's zero-arg current-launch lookup.
  let recencyOrder: string[] = []
  let unsubscribe: (() => void) | null = null

  const forget = (sessionId: string): void => {
    launches.delete(sessionId)
    recencyOrder = recencyOrder.filter((id) => id !== sessionId)
  }

  const isExpired = (tracked: TrackedLaunch): boolean => deps.clock() - tracked.lastSeenAt > ttlMs

  const observe = (payload: AgentHookEventPayload): void => {
    const sessionId = payload.providerSession?.id
    if (!sessionId) {
      return
    }
    // A stop ends the launch: nothing to bind until the session's next prompt.
    if (mapHookEventNameToKind(payload.hookEventName) === 'stop') {
      forget(sessionId)
      return
    }
    const provider = payload.payload.agentType?.trim()
    const launchId = payload.launchToken?.trim()
    if (!provider || provider === 'unknown' || !launchId) {
      return
    }
    // Respect the origin: a relay-forwarded event carries a connectionId (ssh host); local is native.
    const hostType: ExecutionContextHostType = payload.connectionId ? 'ssh' : 'native'
    const hostId = payload.connectionId
      ? toSshExecutionHostId(payload.connectionId)
      : LOCAL_EXECUTION_HOST_ID
    const resolveInput: LaunchResolveInput = {
      agentSessionId: sessionId,
      provider,
      hostType,
      hostId,
      worktreeId: payload.worktreeId?.trim() || undefined,
      launchId
    }
    const workspacePath = resolveWorkspacePath(resolveInput)
    if (!workspacePath) {
      return
    }
    // No osUser (unknown remote user) → unbindable, so a remote launch is never signed as the
    // local user (IDN-008): the launch simply falls back to identity-only ingest.
    const osUser = resolveOsUser(resolveInput)
    if (!osUser) {
      return
    }
    launches.set(sessionId, {
      hostType,
      hostId,
      workspacePath,
      osUser,
      launchId,
      agentSessionId: sessionId,
      provider,
      lastSeenAt: deps.clock()
    })
    recencyOrder = recencyOrder.filter((id) => id !== sessionId)
    recencyOrder.push(sessionId)
  }

  const getActiveLaunch = (agentSessionId: string): ActiveLaunch | null => {
    const tracked = launches.get(agentSessionId)
    if (!tracked) {
      return null
    }
    if (isExpired(tracked)) {
      forget(agentSessionId)
      return null
    }
    return toActiveLaunch(tracked)
  }

  return {
    start: (subscribe) => {
      if (unsubscribe) {
        return
      }
      unsubscribe = subscribe(observe)
    },
    observe,
    getActiveLaunch,
    getCurrentActiveLaunch: () => {
      for (let i = recencyOrder.length - 1; i >= 0; i -= 1) {
        const launch = getActiveLaunch(recencyOrder[i])
        if (launch) {
          return launch
        }
      }
      return null
    },
    stop: () => {
      unsubscribe?.()
      unsubscribe = null
      launches.clear()
      recencyOrder = []
    }
  }
}
