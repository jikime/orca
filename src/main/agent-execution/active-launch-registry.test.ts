import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { createActiveLaunchRegistry } from './active-launch-registry'

function hookPayload(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: null,
    hookEventName: 'UserPromptSubmit',
    launchToken: 'launch-1',
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'sess-1' },
    payload: { state: 'working', prompt: 'hi', agentType: 'claude' },
    ...overrides
  }
}

function mutableClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('createActiveLaunchRegistry — tracking', () => {
  it('tracks a launch from a hook and returns it for the signer (native → local os user)', () => {
    const registry = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'dev' })
    registry.observe(hookPayload())

    const launch = registry.getActiveLaunch('sess-1')
    expect(launch).toEqual({
      hostType: 'native',
      hostId: 'local',
      workspacePath: 'wt-1', // default resolver uses the hook's worktreeId
      osUser: 'dev', // native binds to the local OS user
      launchId: 'launch-1',
      agentSessionId: 'sess-1',
      provider: 'claude'
    })
    expect(registry.getCurrentActiveLaunch()).toEqual(launch)
  })

  it('binds a relay-forwarded launch to its ssh host with the REMOTE os user, not the local one', () => {
    const registry = createActiveLaunchRegistry({
      clock: () => 1_000,
      localOsUser: 'desktop-user',
      // IDN-008: the remote os user comes from the launch origin (connection), never localOsUser.
      resolveOsUser: (input) => (input.hostType === 'ssh' ? `remote:${input.hostId}` : null)
    })
    registry.observe(hookPayload({ connectionId: 'conn-2' }))
    const launch = registry.getActiveLaunch('sess-1')
    expect(launch?.hostType).toBe('ssh')
    expect(launch?.hostId).toBe('ssh:conn-2')
    expect(launch?.osUser).toBe('remote:ssh:conn-2')
  })

  it('does not track an ssh launch whose remote os user is unknown (never the local user)', () => {
    // Default resolver yields no osUser for a remote origin → unbindable, so a remote launch is
    // never signed as the desktop user (IDN-008 safe fallback to identity-only ingest).
    const registry = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'desktop-user' })
    registry.observe(hookPayload({ connectionId: 'conn-2' }))
    expect(registry.getActiveLaunch('sess-1')).toBeNull()
  })

  it('does not track an unbindable launch (no launch token or no workspace)', () => {
    const noToken = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'dev' })
    noToken.observe(hookPayload({ launchToken: undefined }))
    expect(noToken.getActiveLaunch('sess-1')).toBeNull()

    const noWorkspace = createActiveLaunchRegistry({
      clock: () => 1_000,
      localOsUser: 'dev',
      resolveWorkspacePath: () => null
    })
    noWorkspace.observe(hookPayload())
    expect(noWorkspace.getActiveLaunch('sess-1')).toBeNull()
  })

  it('resolves the workspace path through the injected resolver', () => {
    const registry = createActiveLaunchRegistry({
      clock: () => 1_000,
      localOsUser: 'dev',
      resolveWorkspacePath: (input) => `/work/${input.worktreeId}`
    })
    registry.observe(hookPayload())
    expect(registry.getActiveLaunch('sess-1')?.workspacePath).toBe('/work/wt-1')
  })

  it('getCurrentActiveLaunch returns the most recently observed launch', () => {
    const registry = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'dev' })
    registry.observe(hookPayload({ providerSession: { key: 'session_id', id: 'sess-1' } }))
    registry.observe(
      hookPayload({
        providerSession: { key: 'session_id', id: 'sess-2' },
        launchToken: 'launch-2'
      })
    )
    expect(registry.getCurrentActiveLaunch()?.agentSessionId).toBe('sess-2')
  })
})

describe('createActiveLaunchRegistry — expiry', () => {
  it('expires a launch after its TTL', () => {
    const clock = mutableClock()
    const registry = createActiveLaunchRegistry({
      clock: clock.now,
      ttlMs: 5_000,
      localOsUser: 'dev'
    })
    registry.observe(hookPayload())
    expect(registry.getActiveLaunch('sess-1')).not.toBeNull()

    clock.advance(5_001)
    expect(registry.getActiveLaunch('sess-1')).toBeNull()
    expect(registry.getCurrentActiveLaunch()).toBeNull()
  })

  it('expires a launch when its session emits a stop', () => {
    const registry = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'dev' })
    registry.observe(hookPayload())
    expect(registry.getActiveLaunch('sess-1')).not.toBeNull()

    registry.observe(hookPayload({ hookEventName: 'Stop' }))
    expect(registry.getActiveLaunch('sess-1')).toBeNull()
  })
})

describe('createActiveLaunchRegistry — lifecycle', () => {
  it('unsubscribes and clears launches on stop', () => {
    const listeners = new Set<(payload: AgentHookEventPayload) => void>()
    const subscribe = (cb: (payload: AgentHookEventPayload) => void): (() => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
    const registry = createActiveLaunchRegistry({ clock: () => 1_000, localOsUser: 'dev' })
    registry.start(subscribe)
    for (const listener of listeners) {
      listener(hookPayload())
    }
    expect(registry.getActiveLaunch('sess-1')).not.toBeNull()

    registry.stop()
    expect(listeners.size).toBe(0)
    expect(registry.getActiveLaunch('sess-1')).toBeNull()
  })
})
