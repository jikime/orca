import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentEventBatchRequest,
  AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'
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
  // Closes the current handle's :memory: outbox and clears the module singleton between tests.
  stopAgentTracking()
  __resetAgentTrackingForTests()
})

const IDENTITY: InstallationSigningIdentity = {
  installationId: 'inst-1',
  publicKeyPem: 'PEM',
  publicKeyId: 'kid',
  sign: () => Buffer.from('sig')
}

// The server acks everything in the batch — simulates a healthy ingest so the pump acks + prunes.
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

// Two records of one turn (same session + turnRef → one stream, contiguous sequences).
function transcriptRecords(): NormalizedTranscriptRecord[] {
  const base = {
    provider: 'claude_code',
    sessionId: 'sess-1',
    turnRef: 'sess-1:0',
    occurredAt: '2026-07-16T10:00:00.000Z',
    capturedAt: '2026-07-16T10:00:00.500Z',
    orgId: 'org-1',
    hostId: 'local'
  }
  return [
    { ...base, kind: 'user_prompt', providerRecordKey: 'sess-1:0', sequence: 0, contentHash: 'h0' },
    {
      ...base,
      kind: 'assistant_message',
      providerRecordKey: 'sess-1:1',
      sequence: 1,
      contentHash: 'h1'
    }
  ]
}

function makeDeps(overrides: Partial<StartAgentTrackingDeps> = {}): {
  deps: StartAgentTrackingDeps
  auth: { token: string | null; base: string | null; org: string | null }
  uploadClient: { upload: ReturnType<typeof vi.fn> }
  createStore: ReturnType<typeof vi.fn>
  probeSqliteImpl: ReturnType<typeof vi.fn>
  registerKey: ReturnType<typeof vi.fn>
  scheduleInterval: ReturnType<typeof vi.fn>
  clears: ReturnType<typeof vi.fn>[]
} {
  const auth = {
    token: 'tok' as string | null,
    base: 'https://cp/v1' as string | null,
    org: 'org-1' as string | null
  }
  const uploadClient = {
    upload: vi.fn(async (_org: string, req: AgentEventBatchRequest) => ackAllResponse(req))
  }
  const createStore = vi.fn(() => new AgentEventOutboxStore(':memory:'))
  const probeSqliteImpl = vi.fn(() => ({
    usable: true,
    sqliteVersion: '3.45',
    walSupported: false
  }))
  const registerKey = vi.fn(async () => {})
  const clears: ReturnType<typeof vi.fn>[] = []
  const scheduleInterval = vi.fn((_fn: () => void, _ms: number) => {
    const clear = vi.fn()
    clears.push(clear)
    return { clear }
  })
  let idSeq = 0
  const deps: StartAgentTrackingDeps = {
    env: { PIE_AGENT_TRACKING: '1' },
    getAccessToken: () => auth.token,
    getApiBaseUrl: () => auth.base,
    getOrganizationId: () => auth.org,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from(''),
      decryptString: () => ''
    },
    getUserDataPath: () => '/tmp/orca-agent-tracking-test',
    scanTranscripts: vi.fn(async () => [] as NormalizedTranscriptRecord[]),
    clock: () => 1_000,
    newId: () => `id-${idSeq++}`,
    scheduleInterval,
    probeSqliteImpl,
    createStore,
    createInstallationKey: () => ({ getOrCreate: () => ({ status: 'ready', identity: IDENTITY }) }),
    uploadClient: uploadClient as unknown as AgentEventUploadClient,
    registerKey,
    ...overrides
  }
  return {
    deps,
    auth,
    uploadClient,
    createStore,
    probeSqliteImpl,
    registerKey,
    scheduleInterval,
    clears
  }
}

function storeOf(createStore: ReturnType<typeof vi.fn>): AgentEventOutboxStore {
  return createStore.mock.results[0].value as AgentEventOutboxStore
}

describe('startAgentTrackingIfEnabled — gates', () => {
  it('is a strict no-op when the dev-gate flag is off (no outbox, no timers, no network)', () => {
    const t = makeDeps({ env: {} })
    const handle = startAgentTrackingIfEnabled(t.deps)
    expect(handle).toBeNull()
    expect(t.probeSqliteImpl).not.toHaveBeenCalled()
    expect(t.createStore).not.toHaveBeenCalled()
    expect(t.scheduleInterval).not.toHaveBeenCalled()
    expect(t.registerKey).not.toHaveBeenCalled()
  })

  it('is a no-op when safe mode disables the subsystem', () => {
    const t = makeDeps({ isDisabled: () => true })
    expect(startAgentTrackingIfEnabled(t.deps)).toBeNull()
    expect(t.createStore).not.toHaveBeenCalled()
  })

  it('is a no-op when signed out (no org)', () => {
    const t = makeDeps()
    t.auth.org = null
    expect(startAgentTrackingIfEnabled(t.deps)).toBeNull()
    expect(t.createStore).not.toHaveBeenCalled()
  })
})

describe('startAgentTrackingIfEnabled — running', () => {
  it('opens the outbox, registers the installation key once, and schedules pump + scan', () => {
    const t = makeDeps()
    const handle = startAgentTrackingIfEnabled(t.deps)
    expect(handle).not.toBeNull()
    expect(t.createStore).toHaveBeenCalledTimes(1)
    expect(t.registerKey).toHaveBeenCalledTimes(1)
    expect(t.registerKey.mock.calls[0][1]).toMatchObject({
      organizationId: 'org-1',
      installationId: 'inst-1'
    })
    expect(t.scheduleInterval).toHaveBeenCalledTimes(2)
  })

  it('a scanner tick feeds reconciled envelopes into the outbox, and the pump uploads them', async () => {
    const t = makeDeps({ scanTranscripts: vi.fn(async () => transcriptRecords()) })
    const handle = startAgentTrackingIfEnabled(t.deps)!
    const store = storeOf(t.createStore)

    await handle.scanOnce()
    expect(store.pendingCount()).toBe(2)

    await handle.pumpOnce()
    expect(t.uploadClient.upload).toHaveBeenCalledTimes(1)
    const request = t.uploadClient.upload.mock.calls[0][1] as AgentEventBatchRequest
    expect(request.events).toHaveLength(2)
    // Server acked the batch → nothing left unacked.
    expect(store.pendingCount()).toBe(0)
  })

  it('CAP-006: an auth revoke mid-cycle holds the batch — the pump does not upload', async () => {
    const t = makeDeps({ scanTranscripts: vi.fn(async () => transcriptRecords()) })
    const handle = startAgentTrackingIfEnabled(t.deps)!
    const store = storeOf(t.createStore)

    await handle.scanOnce()
    expect(store.pendingCount()).toBe(2)

    t.auth.token = null // login revoked between scan and pump
    await handle.pumpOnce()
    expect(t.uploadClient.upload).not.toHaveBeenCalled()
    expect(store.pendingCount()).toBe(2) // held, never uploaded
  })

  it('stopAgentTracking clears timers, closes the outbox, and is idempotent', () => {
    const t = makeDeps()
    startAgentTrackingIfEnabled(t.deps)
    const store = storeOf(t.createStore)
    const closeSpy = vi.spyOn(store, 'close')

    expect(t.clears).toHaveLength(2)
    stopAgentTracking()
    for (const clear of t.clears) {
      expect(clear).toHaveBeenCalledTimes(1)
    }
    expect(closeSpy).toHaveBeenCalledTimes(1)

    stopAgentTracking()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('startAgentTrackingIfEnabled — degrade', () => {
  it('stays inert (logs, no crash, no store) when packaged SQLite is unusable', () => {
    const log = vi.fn()
    const t = makeDeps({
      log,
      probeSqliteImpl: vi.fn(() => ({
        usable: false,
        sqliteVersion: null,
        walSupported: false,
        reason: 'sqlite too old'
      }))
    })
    const handle = startAgentTrackingIfEnabled(t.deps)
    expect(handle).toBeNull()
    expect(t.createStore).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
  })
})
