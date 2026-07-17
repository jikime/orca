import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { reconcileAgentEvents } from '../agent-reconcile/agent-event-reconciler'
import type { NormalizedTranscriptRecord } from '../agent-reconcile/agent-reconcile-types'
import { createAgentHookEventTap } from './hook-event-tap'

// A minimal stand-in for agentHookServer.subscribeAgentHookEvents.
function fakeHookSource(): {
  subscribe: (cb: (payload: AgentHookEventPayload) => void) => () => void
  emit: (payload: AgentHookEventPayload) => void
  listenerCount: () => number
} {
  const listeners = new Set<(payload: AgentHookEventPayload) => void>()
  return {
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit: (payload) => {
      for (const listener of listeners) {
        listener(payload)
      }
    },
    listenerCount: () => listeners.size
  }
}

function hookPayload(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: null,
    hookEventName: 'UserPromptSubmit',
    providerSession: { key: 'session_id', id: 'sess-1' },
    payload: { state: 'working', prompt: 'do a thing', agentType: 'claude' },
    ...overrides
  }
}

const CLOCK_MS = Date.parse('2026-07-17T10:00:00.000Z')

function makeTap(overrides: { getOrganizationId?: () => string | null; ringSize?: number } = {}) {
  return createAgentHookEventTap({
    clock: () => CLOCK_MS,
    getOrganizationId: overrides.getOrganizationId ?? (() => 'org-1'),
    ringSize: overrides.ringSize
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createAgentHookEventTap — mapping', () => {
  it('maps each hook event name to its NormalizedHookEvent kind', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)

    source.emit(hookPayload({ hookEventName: 'UserPromptSubmit' }))
    source.emit(
      hookPayload({
        hookEventName: 'PreToolUse',
        toolUseId: 'call-1',
        payload: { state: 'working', prompt: 'do a thing', agentType: 'claude', toolName: 'Bash' }
      })
    )
    source.emit(hookPayload({ hookEventName: 'PostToolUse', toolUseId: 'call-1' }))
    source.emit(hookPayload({ hookEventName: 'Stop' }))

    const events = tap.drain()
    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'pre_tool', 'post_tool', 'stop'])
    expect(events.every((e) => e.provider === 'claude' && e.sessionId === 'sess-1')).toBe(true)
    expect(events.every((e) => e.orgId === 'org-1' && e.hostId === 'local')).toBe(true)
    // pre/post of one call share a toolCallRef so they fold to one tool timeline.
    expect(events[1].toolCallRef).toBe('call-1')
    expect(events[2].toolCallRef).toBe('call-1')
    expect(events[1].toolName).toBe('Bash')
  })

  it('stamps a relay-forwarded connectionId as an ssh host (respects the origin)', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)
    source.emit(hookPayload({ connectionId: 'conn-9' }))
    expect(tap.drain()[0].hostId).toBe('ssh:conn-9')
  })

  it('skips unknown / unmappable events instead of fabricating a kind', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)

    source.emit(hookPayload({ hookEventName: 'PermissionRequest' })) // not a turn kind
    source.emit(hookPayload({ hookEventName: undefined })) // no event name
    source.emit(hookPayload({ payload: { state: 'working', prompt: 'x', agentType: 'unknown' } })) // unknown provider
    source.emit(hookPayload({ providerSession: undefined })) // no provider session id

    expect(tap.drain()).toHaveLength(0)
  })

  it('skips everything when signed out (no org to attribute to)', () => {
    const source = fakeHookSource()
    const tap = makeTap({ getOrganizationId: () => null })
    tap.start(source.subscribe)
    source.emit(hookPayload())
    expect(tap.drain()).toHaveLength(0)
  })

  it('derives a STABLE record key from payload identity and never calls Date.now', () => {
    const dateNow = vi.spyOn(Date, 'now')
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)

    source.emit(hookPayload())
    source.emit(hookPayload()) // same identity → same stable record key (replay-idempotent)

    const events = tap.drain()
    expect(events[0].providerRecordKey).toBe(events[1].providerRecordKey)
    expect(events[0].providerRecordKey.startsWith('user_prompt:')).toBe(true)
    // A distinct prompt yields a distinct key.
    source.emit(
      hookPayload({ payload: { state: 'working', prompt: 'other', agentType: 'claude' } })
    )
    expect(tap.drain()[0].providerRecordKey).not.toBe(events[0].providerRecordKey)
    expect(dateNow).not.toHaveBeenCalled()
  })
})

describe('createAgentHookEventTap — buffer + lifecycle', () => {
  it('buffers events, drains them exactly once, and clears on drain', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)
    source.emit(hookPayload())
    source.emit(hookPayload({ hookEventName: 'Stop' }))
    expect(tap.drain()).toHaveLength(2)
    expect(tap.drain()).toHaveLength(0)
  })

  it('unsubscribes cleanly on stop — no leak and no further buffering', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)
    expect(source.listenerCount()).toBe(1)
    tap.stop()
    expect(source.listenerCount()).toBe(0)
    source.emit(hookPayload())
    expect(tap.drain()).toHaveLength(0)
  })

  it('bounds the ring to its size, dropping the oldest', () => {
    const source = fakeHookSource()
    const tap = makeTap({ ringSize: 2 })
    tap.start(source.subscribe)
    source.emit(hookPayload({ payload: { state: 'working', prompt: 'a', agentType: 'claude' } }))
    source.emit(hookPayload({ payload: { state: 'working', prompt: 'b', agentType: 'claude' } }))
    source.emit(hookPayload({ payload: { state: 'working', prompt: 'c', agentType: 'claude' } }))
    const events = tap.drain()
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.sequence)).toEqual([1, 2])
  })
})

describe('createAgentHookEventTap — reconcile cycle merges hook + transcript', () => {
  it('a hook and a transcript record for the same turn dedupe to one turn', () => {
    const source = fakeHookSource()
    const tap = makeTap()
    tap.start(source.subscribe)
    source.emit(hookPayload({ hookEventName: 'UserPromptSubmit' }))
    const [hookEvent] = tap.drain()

    // Transcript record of the SAME turn (shared provider/sessionId/turnRef).
    const transcript: NormalizedTranscriptRecord = {
      provider: hookEvent.provider,
      sessionId: hookEvent.sessionId,
      kind: 'assistant_message',
      providerRecordKey: `${hookEvent.sessionId}:1`,
      turnRef: hookEvent.turnRef,
      sequence: hookEvent.sequence + 1,
      contentHash: 'h1',
      occurredAt: hookEvent.occurredAt,
      capturedAt: hookEvent.capturedAt,
      orgId: hookEvent.orgId,
      hostId: hookEvent.hostId
    }

    const enqueued: string[] = []
    const result = reconcileAgentEvents({
      hookEvents: [hookEvent],
      transcriptRecords: [transcript],
      enqueue: (event) => enqueued.push(event.id)
    })

    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].sources).toEqual(['hook', 'transcript'])
    expect(result.turns[0].finalized).toBe(true)
    expect(enqueued).toHaveLength(2)
  })
})
