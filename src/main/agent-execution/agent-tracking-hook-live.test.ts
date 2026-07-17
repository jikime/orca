import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEventBatchRequest,
  AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import type { AgentEventUploadClient } from '../agent-outbox/agent-event-upload-client'
import { AgentEventOutboxStore } from '../agent-outbox/agent-event-outbox-store'
import type { NormalizedTranscriptRecord } from '../agent-reconcile/agent-reconcile-types'
import type { InstallationSigningIdentity } from '../agent-execution-context/installation-signing-key'
import {
  __resetAgentTrackingForTests,
  startAgentTrackingIfEnabled,
  stopAgentTracking,
  type StartAgentTrackingDeps
} from './agent-tracking-service'

afterEach(() => {
  stopAgentTracking()
  __resetAgentTrackingForTests()
})

const IDENTITY: InstallationSigningIdentity = {
  installationId: 'inst-1',
  publicKeyPem: 'PEM',
  publicKeyId: 'kid',
  sign: () => Buffer.from('sig')
}

function ackAllResponse(req: AgentEventBatchRequest): AgentEventBatchResponse {
  const maxByStream = new Map<string, number>()
  for (const event of req.events) {
    maxByStream.set(
      event.piestream,
      Math.max(maxByStream.get(event.piestream) ?? 0, event.piesequence)
    )
  }
  return {
    batchId: req.batchId,
    results: req.events.map((event) => ({ id: event.id, status: 'accepted' as const })),
    streamAcks: [...maxByStream].map(([streamId, contiguousThrough]) => ({
      streamId,
      contiguousThrough,
      gaps: []
    }))
  }
}

function fakeHookSource(): {
  subscribe: StartAgentTrackingDeps['subscribeAgentHookEvents']
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
    launchToken: 'launch-1',
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'sess-1' },
    payload: { state: 'working', prompt: 'hi', agentType: 'claude' },
    ...overrides
  }
}

function transcriptRecords(): NormalizedTranscriptRecord[] {
  const base = {
    provider: 'claude_code',
    sessionId: 'txn-sess',
    turnRef: 'txn-sess:0',
    occurredAt: '2026-07-17T10:00:00.000Z',
    capturedAt: '2026-07-17T10:00:00.500Z',
    orgId: 'org-1',
    hostId: 'local'
  }
  return [
    {
      ...base,
      kind: 'user_prompt',
      providerRecordKey: 'txn-sess:0',
      sequence: 0,
      contentHash: 'h0'
    },
    {
      ...base,
      kind: 'assistant_message',
      providerRecordKey: 'txn-sess:1',
      sequence: 1,
      contentHash: 'h1'
    }
  ]
}

function makeDeps(overrides: Partial<StartAgentTrackingDeps> = {}): {
  deps: StartAgentTrackingDeps
  uploadClient: { upload: ReturnType<typeof vi.fn> }
  createStore: ReturnType<typeof vi.fn>
  source: ReturnType<typeof fakeHookSource>
} {
  const uploadClient = {
    upload: vi.fn(async (_org: string, req: AgentEventBatchRequest) => ackAllResponse(req))
  }
  const createStore = vi.fn(() => new AgentEventOutboxStore(':memory:'))
  const source = fakeHookSource()
  let idSeq = 0
  const deps: StartAgentTrackingDeps = {
    env: { PIE_AGENT_TRACKING: '1' },
    getAccessToken: () => 'tok',
    getApiBaseUrl: () => 'https://cp/v1',
    getOrganizationId: () => 'org-1',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from(''),
      decryptString: () => ''
    },
    getUserDataPath: () => '/tmp/orca-agent-tracking-hooklive-test',
    scanTranscripts: vi.fn(async () => [] as NormalizedTranscriptRecord[]),
    subscribeAgentHookEvents: source.subscribe,
    getLocalOsUser: () => 'dev',
    clock: () => 1_000,
    newId: () => `id-${idSeq++}`,
    scheduleInterval: vi.fn((_fn: () => void, _ms: number) => ({ clear: vi.fn() })),
    probeSqliteImpl: vi.fn(() => ({ usable: true, sqliteVersion: '3.45', walSupported: false })),
    createStore,
    createInstallationKey: () => ({ getOrCreate: () => ({ status: 'ready', identity: IDENTITY }) }),
    uploadClient: uploadClient as unknown as AgentEventUploadClient,
    registerKey: vi.fn(async () => {}),
    ...overrides
  }
  return { deps, uploadClient, createStore, source }
}

function storeOf(createStore: ReturnType<typeof vi.fn>): AgentEventOutboxStore {
  return createStore.mock.results[0].value as AgentEventOutboxStore
}

describe('agent-tracking live hook producer', () => {
  it('subscribes to the hook pipeline only while the dev-gated subsystem runs', () => {
    const off = makeDeps({ env: {} })
    expect(startAgentTrackingIfEnabled(off.deps)).toBeNull()
    // No subscriber registered when the subsystem is a no-op.
    expect(off.source.listenerCount()).toBe(0)

    const on = makeDeps()
    const handle = startAgentTrackingIfEnabled(on.deps)!
    // Tap + registry each subscribe.
    expect(on.source.listenerCount()).toBe(2)
    handle.stop()
    expect(on.source.listenerCount()).toBe(0)
  })

  it('merges live hook events with transcript records in the reconcile cycle', async () => {
    const t = makeDeps({ scanTranscripts: vi.fn(async () => transcriptRecords()) })
    const handle = startAgentTrackingIfEnabled(t.deps)!
    const store = storeOf(t.createStore)

    t.source.emit(hookPayload()) // one live hook turn
    await handle.scanOnce()

    // 1 hook event + 2 transcript records → both producers reached the outbox.
    expect(store.pendingCount()).toBe(3)
  })

  it('binds the signed ExecutionContext to a REAL launch from the hook stream', async () => {
    const t = makeDeps()
    const handle = startAgentTrackingIfEnabled(t.deps)!
    const store = storeOf(t.createStore)

    t.source.emit(hookPayload()) // registers launch-1 for sess-1
    await handle.scanOnce()
    expect(store.pendingCount()).toBe(1)

    await handle.pumpOnce()
    const request = t.uploadClient.upload.mock.calls[0][1] as AgentEventBatchRequest
    expect(request.executionContext?.context.launchId).toBe('launch-1')
    expect(request.executionContext?.context.agentSessionId).toBe('sess-1')
    expect(request.executionContext?.context.workspacePath).toBe('wt-1')
    expect(request.executionContext?.context.osUser).toBe('dev') // native → local os user (IDN-008)
  })

  it('stays identity-only when there is no live launch to bind', async () => {
    const t = makeDeps()
    const handle = startAgentTrackingIfEnabled(t.deps)!
    const store = storeOf(t.createStore)

    // A hook with no launch token cannot bind a context.
    t.source.emit(hookPayload({ launchToken: undefined }))
    await handle.scanOnce()
    await handle.pumpOnce()
    if (t.uploadClient.upload.mock.calls.length > 0) {
      const request = t.uploadClient.upload.mock.calls[0][1] as AgentEventBatchRequest
      expect(request.executionContext).toBeUndefined()
    }
    expect(store.pendingCount()).toBe(0)
  })
})
