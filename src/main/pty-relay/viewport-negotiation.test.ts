import { expect, test } from 'vitest'
import { createViewportNegotiator, type PtyViewport } from './viewport-negotiation'

// Min-size negotiation proofs: a single PTY can only be one size, so the effective
// size is the element-wise MIN across live participants (cols/rows independently)
// so no viewer ever sees wrapped/truncated output.

const FALLBACK: PtyViewport = { cols: 80, rows: 24 }

function trackChanges(): {
  onChange: (size: PtyViewport) => void
  sizes: PtyViewport[]
} {
  const sizes: PtyViewport[] = []
  return { onChange: (size) => sizes.push({ ...size }), sizes }
}

test('effective size is the element-wise min across N participants', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  n.setViewport('a', { cols: 120, rows: 50 })
  n.setViewport('b', { cols: 80, rows: 40 })
  n.setViewport('c', { cols: 100, rows: 30 })
  // min cols = 80 (b), min rows = 30 (c) — chosen independently.
  expect(n.effectiveSize()).toEqual({ cols: 80, rows: 30 })
})

test('a participant joining larger than the current min does not resize', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  const { onChange, sizes } = trackChanges()
  n.onEffectiveSizeChanged(onChange)
  n.setViewport('a', { cols: 90, rows: 30 }) // differs from fallback — one change
  expect(sizes).toEqual([{ cols: 90, rows: 30 }])
  n.setViewport('b', { cols: 120, rows: 50 }) // larger — behind the min
  expect(sizes).toEqual([{ cols: 90, rows: 30 }]) // no extra change
  expect(n.effectiveSize()).toEqual({ cols: 90, rows: 30 })
})

test('a participant joining smaller than the current min resizes', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  const { onChange, sizes } = trackChanges()
  n.setViewport('a', { cols: 120, rows: 50 })
  n.onEffectiveSizeChanged(onChange)
  n.setViewport('b', { cols: 90, rows: 30 }) // smaller — new min
  expect(sizes).toEqual([{ cols: 90, rows: 30 }])
})

test('when the min participant leaves, the size grows back and a resize fires', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  const { onChange, sizes } = trackChanges()
  n.setViewport('a', { cols: 120, rows: 50 })
  n.setViewport('b', { cols: 90, rows: 30 }) // b is the min
  n.onEffectiveSizeChanged(onChange)
  n.removeParticipant('b')
  // only a remains, so the effective size grows back to a's viewport.
  expect(sizes).toEqual([{ cols: 120, rows: 50 }])
  expect(n.effectiveSize()).toEqual({ cols: 120, rows: 50 })
})

test('participants with invalid or missing sizes are ignored', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  n.setViewport('a', { cols: 100, rows: 40 })
  n.setViewport('zero', { cols: 0, rows: 40 }) // invalid cols — ignored
  n.setViewport('nan', { cols: Number.NaN, rows: 30 }) // invalid — ignored
  n.setViewport('neg', { cols: 100, rows: -5 }) // invalid rows — ignored
  expect(n.effectiveSize()).toEqual({ cols: 100, rows: 40 })
})

test('with no valid viewports the effective size is the host fallback, never zero', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  expect(n.effectiveSize()).toEqual({ cols: 80, rows: 24 })
  n.setViewport('bad', { cols: 0, rows: 0 })
  expect(n.effectiveSize()).toEqual({ cols: 80, rows: 24 })
})

test('an invalid host fallback still never yields a zero/negative size', () => {
  const n = createViewportNegotiator({ hostFallback: { cols: 0, rows: 0 } })
  const size = n.effectiveSize()
  expect(size.cols).toBeGreaterThanOrEqual(1)
  expect(size.rows).toBeGreaterThanOrEqual(1)
})

test('re-reporting an identical size does not fire a redundant change', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  const { onChange, sizes } = trackChanges()
  n.onEffectiveSizeChanged(onChange)
  n.setViewport('a', { cols: 90, rows: 30 })
  n.setViewport('a', { cols: 90, rows: 30 }) // same — dedupe
  n.setViewport('b', { cols: 90, rows: 30 }) // equal min — dedupe
  expect(sizes).toEqual([{ cols: 90, rows: 30 }])
})

test('unsubscribing stops further change notifications', () => {
  const n = createViewportNegotiator({ hostFallback: FALLBACK })
  const { onChange, sizes } = trackChanges()
  const unsubscribe = n.onEffectiveSizeChanged(onChange)
  n.setViewport('a', { cols: 90, rows: 30 })
  unsubscribe()
  n.setViewport('b', { cols: 70, rows: 20 })
  expect(sizes).toEqual([{ cols: 90, rows: 30 }])
})
