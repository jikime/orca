import { describe, expect, it } from 'vitest'
import { resolveSubmissionNonce, type SubmissionNonceCache } from './agent-batch-submission-nonce'

function counter(): () => string {
  let n = 0
  return () => `nonce-${(n += 1)}`
}

describe('resolveSubmissionNonce (pure)', () => {
  it('mints a fresh nonce per distinct batchId', () => {
    const cache: SubmissionNonceCache = new Map()
    const mint = counter()
    expect(resolveSubmissionNonce('batch-a', cache, mint)).toBe('nonce-1')
    expect(resolveSubmissionNonce('batch-b', cache, mint)).toBe('nonce-2')
  })

  it('retry-safe: the SAME batchId reuses its nonce (never a fresh one)', () => {
    const cache: SubmissionNonceCache = new Map()
    const mint = counter()
    const first = resolveSubmissionNonce('batch-a', cache, mint)
    const retry = resolveSubmissionNonce('batch-a', cache, mint)
    expect(retry).toBe(first)
    // A different batch still gets a distinct nonce, so no two batchIds share a nonce.
    expect(resolveSubmissionNonce('batch-b', cache, mint)).not.toBe(first)
  })

  it('is deterministic under an injected mint (no ambient randomness)', () => {
    const a: SubmissionNonceCache = new Map()
    const b: SubmissionNonceCache = new Map()
    expect(resolveSubmissionNonce('batch-x', a, counter())).toBe(
      resolveSubmissionNonce('batch-x', b, counter())
    )
  })

  it('bounds the cache with FIFO eviction of terminal batchIds', () => {
    const cache: SubmissionNonceCache = new Map()
    const mint = counter()
    resolveSubmissionNonce('oldest', cache, mint, 2)
    resolveSubmissionNonce('mid', cache, mint, 2)
    resolveSubmissionNonce('newest', cache, mint, 2)
    // 'oldest' was evicted once size passed 2, so re-resolving mints a new nonce for it.
    expect(cache.has('oldest')).toBe(false)
    expect(cache.has('mid')).toBe(true)
    expect(cache.has('newest')).toBe(true)
  })
})
