import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeBackoffMs,
  createUploadPump,
  planBatchOutcome,
  type UploadPumpDeps
} from './agent-event-upload-pump'
import { AgentEventUploadError } from './agent-event-upload-client'
import {
  AgentEventOutboxStore,
  type ClaimedOutboxItem,
  type OutboxAuditRecord
} from './agent-event-outbox-store'
import type {
  AgentEventBatchRequest,
  AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'
import type { SignedExecutionContext } from '../../shared/execution-context-contract'
import { makeEnvelope } from './__fixtures__/agent-event-envelope-fixture'

const ORG = '20000000-0000-4000-8000-000000000001'
const NOW = 1_000_000

let store: AgentEventOutboxStore
let upload: ReturnType<typeof vi.fn>
let audits: OutboxAuditRecord[]

beforeEach(() => {
  store = new AgentEventOutboxStore(':memory:')
  upload = vi.fn()
  audits = []
})

afterEach(() => {
  store.close()
})

function pump(overrides: Partial<UploadPumpDeps> = {}) {
  let counter = 0
  const deps: UploadPumpDeps = {
    store,
    uploadClient: { upload: upload as never },
    organizationId: ORG,
    producerId: 'producer-1',
    isUploadAuthorized: () => true,
    clock: () => NOW,
    newId: () => `id-${(counter += 1)}`,
    batchLimit: 100,
    maxBytes: 1_000_000,
    backoffBaseMs: 1000,
    backoffCapMs: 60_000,
    revokePolicy: 'hold',
    onAudit: (r) => audits.push(r),
    ...overrides
  }
  return createUploadPump(deps)
}

function response(
  results: AgentEventBatchResponse['results'],
  contiguousThrough: number,
  gaps: number[] = []
): AgentEventBatchResponse {
  return {
    batchId: 'batch-server',
    results,
    streamAcks: [{ streamId: 'stream-a', contiguousThrough, gaps }]
  }
}

function seed(count: number): void {
  for (let i = 1; i <= count; i += 1) {
    store.enqueue(makeEnvelope({ id: `evt-${i}`, streamId: 'stream-a', sequence: i }), { now: NOW })
  }
}

describe('planBatchOutcome (pure)', () => {
  const item = (eventId: string, sequence: number): ClaimedOutboxItem => ({
    eventId,
    streamId: 'stream-a',
    sequence,
    byteSize: 10,
    attemptCount: 0,
    assertion: 'observed',
    envelope: makeEnvelope({ id: eventId, sequence })
  })

  it('acks only the contiguous prefix when the server reports a gap', () => {
    const items = [item('evt-1', 1), item('evt-2', 2), item('evt-3', 3)]
    const plan = planBatchOutcome(
      items,
      response(
        [
          { id: 'evt-1', status: 'accepted' },
          { id: 'evt-2', status: 'accepted' },
          { id: 'evt-3', status: 'accepted' }
        ],
        1,
        [2]
      )
    )
    expect(plan.ack).toEqual(['evt-1'])
    expect(plan.nack).toEqual(['evt-2', 'evt-3'])
  })

  it('treats a duplicate within the prefix as acked (idempotent replay)', () => {
    const plan = planBatchOutcome(
      [item('evt-1', 1)],
      response([{ id: 'evt-1', status: 'duplicate' }], 1)
    )
    expect(plan.ack).toEqual(['evt-1'])
  })

  it('drops a permanent_rejected event', () => {
    const plan = planBatchOutcome(
      [item('evt-1', 1)],
      response([{ id: 'evt-1', status: 'permanent_rejected', code: 'SESSION_NOT_FOUND' }], 1)
    )
    expect(plan.ack).toEqual([])
    expect(plan.drop).toHaveLength(1)
    expect(plan.drop[0].code).toBe('SESSION_NOT_FOUND')
  })

  it('holds (nacks) a retryable_rejected item — distinct from ack and from drop', () => {
    const plan = planBatchOutcome(
      [item('evt-1', 1)],
      response([{ id: 'evt-1', status: 'retryable_rejected', retryAfterMs: 500 }], 0)
    )
    // retryable is not ingested (never acked) and not poison (never dropped) → held for retry.
    expect(plan.ack).toEqual([])
    expect(plan.drop).toEqual([])
    expect(plan.nack).toEqual(['evt-1'])
  })
})

describe('computeBackoffMs (pure)', () => {
  it('grows exponentially and caps', () => {
    expect(computeBackoffMs(0, 1000, 60_000)).toBe(1000)
    expect(computeBackoffMs(3, 1000, 60_000)).toBe(8000)
    expect(computeBackoffMs(20, 1000, 60_000)).toBe(60_000)
  })
})

describe('agent-event-upload-pump', () => {
  it('uploads a claimed batch and acks + advances the cursor on success', async () => {
    seed(2)
    upload.mockResolvedValue(
      response(
        [
          { id: 'evt-1', status: 'accepted' },
          { id: 'evt-2', status: 'accepted' }
        ],
        2
      )
    )
    const result = await pump().pumpOnce()
    expect(result).toEqual({ outcome: 'uploaded', acked: 2, dropped: 0, nacked: 0 })
    expect(store.pendingCount()).toBe(0)
    expect(store.getCursor('stream-a')).toBe(2)
  })

  it('CAP-006: holds (never POSTs) when unauthorized under the hold policy', async () => {
    seed(1)
    const result = await pump({ isUploadAuthorized: () => false }).pumpOnce()
    expect(result).toEqual({ outcome: 'held_unauthorized' })
    expect(upload).not.toHaveBeenCalled()
    expect(store.pendingCount()).toBe(1)
  })

  it('CAP-006: revoke-while-offline purges the outbox and NEVER POSTs (purge policy)', async () => {
    seed(2)
    const result = await pump({
      isUploadAuthorized: () => false,
      revokePolicy: 'purge'
    }).pumpOnce()
    expect(result).toEqual({ outcome: 'purged', purged: 2 })
    expect(upload).not.toHaveBeenCalled()
    expect(store.pendingCount()).toBe(0)
    expect(audits.every((a) => a.reason === 'revoked_purged')).toBe(true)
  })

  it('CAP-006: a revoke that lands after claim reclaims the batch without POSTing', async () => {
    seed(1)
    const isUploadAuthorized = vi
      .fn()
      .mockReturnValueOnce(true) // gate #1 passes
      .mockReturnValueOnce(false) // gate #2 (pre-POST) fails
    const result = await pump({ isUploadAuthorized }).pumpOnce()
    expect(result).toEqual({ outcome: 'held_unauthorized_reclaimed', reclaimed: 1 })
    expect(upload).not.toHaveBeenCalled()
    // The claimed row is back to pending (visible for the next authorized tick).
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(1)
  })

  it('acks only the contiguous prefix on a server partial-ack (gap)', async () => {
    seed(3)
    upload.mockResolvedValue(
      response(
        [
          { id: 'evt-1', status: 'accepted' },
          { id: 'evt-2', status: 'accepted' },
          { id: 'evt-3', status: 'accepted' }
        ],
        1,
        [2]
      )
    )
    const result = await pump().pumpOnce()
    expect(result).toMatchObject({ outcome: 'uploaded', acked: 1, nacked: 2 })
    expect(store.getCursor('stream-a')).toBe(1)
    // The two beyond-gap events remain unacked for retry.
    expect(store.pendingCount()).toBe(2)
  })

  it('treats a 409 idempotent replay as acked (no infinite retry)', async () => {
    seed(1)
    upload.mockRejectedValue(new AgentEventUploadError('conflict', 409))
    const result = await pump().pumpOnce()
    expect(result).toEqual({ outcome: 'replayed', acked: 1 })
    expect(store.pendingCount()).toBe(0)
  })

  it('nacks with backoff on a transient error and bumps the attempt', async () => {
    seed(1)
    upload.mockRejectedValue(new AgentEventUploadError('boom', 500))
    const result = await pump().pumpOnce()
    expect(result).toEqual({ outcome: 'error', status: 500, nacked: 1 })
    // Not visible until backoff elapses (base 1000ms at attempt 0).
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(0)
    const reclaimed = store.claimBatch(10, 1_000_000, NOW + 1000)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].attemptCount).toBe(1)
  })

  it('drops and audits a permanent_rejected event', async () => {
    seed(1)
    upload.mockResolvedValue(
      response([{ id: 'evt-1', status: 'permanent_rejected', code: 'PRODUCER_MISMATCH' }], 0)
    )
    const result = await pump().pumpOnce()
    expect(result).toMatchObject({ outcome: 'uploaded', dropped: 1 })
    expect(store.pendingCount()).toBe(0)
    expect(audits[0]).toMatchObject({ eventId: 'evt-1', reason: 'permanent_rejected' })
  })

  it('SYN-003: a single mixed-status batch acks ingested, dead-letters permanent, holds retryable + beyond-gap, advances only the contiguous prefix', async () => {
    seed(5)
    upload.mockResolvedValue(
      response(
        [
          { id: 'evt-1', status: 'accepted' },
          { id: 'evt-2', status: 'duplicate' },
          { id: 'evt-3', status: 'retryable_rejected', retryAfterMs: 2000 },
          { id: 'evt-4', status: 'permanent_rejected', code: 'SESSION_NOT_FOUND' },
          { id: 'evt-5', status: 'accepted' }
        ],
        // The retryable at seq 3 breaks the prefix → the server ingested only 1..2 contiguously.
        2,
        [3, 4]
      )
    )
    const result = await pump().pumpOnce()
    // accepted+duplicate within the prefix acked (2), permanent dropped (1), retryable+beyond-gap held (2).
    expect(result).toEqual({ outcome: 'uploaded', acked: 2, dropped: 1, nacked: 2 })

    // The cursor only advances over the truly-ingested contiguous prefix.
    expect(store.getCursor('stream-a')).toBe(2)

    // The permanent rejection is dead-lettered with a durable audit record — never retried forever.
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ eventId: 'evt-4', reason: 'permanent_rejected' })

    // Only the held rows remain pending (retryable evt-3 + beyond-gap accepted evt-5).
    expect(store.pendingCount()).toBe(2)
    // Held rows are backed off — not visible until the backoff elapses.
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(0)
    const retried = store.claimBatch(10, 1_000_000, NOW + 1000)
    expect(retried.map((c) => c.eventId)).toEqual(['evt-3', 'evt-5'])
    // retryable_rejected is retried with backoff and its attempt is bumped (not acked, not dropped).
    expect(retried.every((c) => c.attemptCount === 1)).toBe(true)
  })

  it('is idle when nothing is claimable', async () => {
    const result = await pump().pumpOnce()
    expect(result).toEqual({ outcome: 'idle' })
    expect(upload).not.toHaveBeenCalled()
  })

  const signedContext = (notAfter: number): SignedExecutionContext => ({
    context: {
      schemaVersion: 1,
      installationId: 'inst-1',
      hostType: 'native',
      hostId: 'host-1',
      workspacePath: '/w',
      osUser: 'dev',
      launchId: 'launch-1',
      agentSessionId: 'session-1',
      provider: 'claude_code',
      notBefore: 0,
      notAfter
    },
    installationId: 'inst-1',
    signature: 'c2ln',
    publicKeyId: 'kid-1'
  })

  it('R5 s2b: attaches the current signed execution context to the batch', async () => {
    seed(1)
    upload.mockResolvedValue(response([{ id: 'evt-1', status: 'accepted' }], 1))
    const ctx = signedContext(NOW + 10_000)
    await pump({ executionContext: () => ctx }).pumpOnce()
    const request = upload.mock.calls[0]?.[1] as AgentEventBatchRequest
    expect(request.executionContext).toEqual(ctx)
  })

  it('R5 s5: a signed-context batch carries a fresh per-batch submission nonce', async () => {
    seed(1)
    upload.mockResolvedValue(response([{ id: 'evt-1', status: 'accepted' }], 1))
    await pump({ executionContext: () => signedContext(NOW + 10_000) }).pumpOnce()
    const request = upload.mock.calls[0]?.[1] as AgentEventBatchRequest
    // Nonce is minted from the injected newId (deterministic), distinct from the batchId.
    expect(request.submissionNonce).toBeDefined()
    expect(request.submissionNonce).not.toBe(request.batchId)
  })

  it('R5 s5: an identity-only batch (no context) carries no submission nonce', async () => {
    seed(1)
    upload.mockResolvedValue(response([{ id: 'evt-1', status: 'accepted' }], 1))
    await pump().pumpOnce()
    const request = upload.mock.calls[0]?.[1] as AgentEventBatchRequest
    expect(request.submissionNonce).toBeUndefined()
  })

  it('R5 s5: refuses to send a NOT-YET-VALID context, holding the batch', async () => {
    seed(1)
    // notBefore in the future relative to the injected clock (NOW).
    const premature: SignedExecutionContext = {
      ...signedContext(NOW + 100_000),
      context: { ...signedContext(NOW + 100_000).context, notBefore: NOW + 10_000 }
    }
    const result = await pump({ executionContext: () => premature }).pumpOnce()
    expect(result).toEqual({ outcome: 'held_premature_context', reclaimed: 1 })
    expect(upload).not.toHaveBeenCalled()
    expect(store.pendingCount()).toBe(1)
  })

  it('R5 s2b: refuses to send an EXPIRED context, holding the batch for a re-signed launch', async () => {
    seed(1)
    const result = await pump({ executionContext: () => signedContext(NOW - 1) }).pumpOnce()
    expect(result).toEqual({ outcome: 'held_expired_context', reclaimed: 1 })
    expect(upload).not.toHaveBeenCalled()
    // Held (nacked with backoff): still pending, not sent stale.
    expect(store.pendingCount()).toBe(1)
    expect(store.claimBatch(10, 1_000_000, NOW)).toHaveLength(0)
  })

  it('R5 s2b: a null context sends no executionContext (identity-only back-compat)', async () => {
    seed(1)
    upload.mockResolvedValue(response([{ id: 'evt-1', status: 'accepted' }], 1))
    await pump({ executionContext: () => null }).pumpOnce()
    const request = upload.mock.calls[0]?.[1] as AgentEventBatchRequest
    expect(request.executionContext).toBeUndefined()
  })
})
