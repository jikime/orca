import { expect, test, vi } from 'vitest'
import { createPtyRelayHostViewport } from './pty-relay-host-viewport'

// Host integration proofs: an effective-size change drives the injected resize
// with the negotiated min, and the host's own viewport is part of the min.

test('registering the host at its own size does not resize (already that size)', () => {
  const resize = vi.fn()
  createPtyRelayHostViewport({
    hostParticipantId: 'host',
    hostViewport: { cols: 100, rows: 40 },
    resize
  })
  expect(resize).not.toHaveBeenCalled()
})

test('a viewer reporting a smaller size resizes the PTY to the min', () => {
  const resize = vi.fn()
  const hv = createPtyRelayHostViewport({
    hostParticipantId: 'host',
    hostViewport: { cols: 120, rows: 50 },
    resize
  })
  hv.reportViewerViewport('viewer-1', { cols: 90, rows: 30 })
  expect(resize).toHaveBeenCalledTimes(1)
  expect(resize).toHaveBeenCalledWith(90, 30)
  expect(hv.effectiveSize()).toEqual({ cols: 90, rows: 30 })
})

test('two viewers reporting sizes drive a resize to the element-wise min', () => {
  const resize = vi.fn()
  const hv = createPtyRelayHostViewport({
    hostParticipantId: 'host',
    hostViewport: { cols: 200, rows: 60 },
    resize
  })
  hv.reportViewerViewport('viewer-1', { cols: 100, rows: 45 })
  hv.reportViewerViewport('viewer-2', { cols: 120, rows: 30 })
  // min cols = 100 (viewer-1), min rows = 30 (viewer-2), host is 200x60.
  expect(hv.effectiveSize()).toEqual({ cols: 100, rows: 30 })
  expect(resize).toHaveBeenLastCalledWith(100, 30)
})

test('a larger viewer behind the min does not trigger a resize', () => {
  const resize = vi.fn()
  const hv = createPtyRelayHostViewport({
    hostParticipantId: 'host',
    hostViewport: { cols: 90, rows: 30 },
    resize
  })
  hv.reportViewerViewport('viewer-1', { cols: 200, rows: 60 }) // larger than host
  expect(resize).not.toHaveBeenCalled()
  expect(hv.effectiveSize()).toEqual({ cols: 90, rows: 30 })
})

test('dropping the min viewer grows the PTY back and resizes', () => {
  const resize = vi.fn()
  const hv = createPtyRelayHostViewport({
    hostParticipantId: 'host',
    hostViewport: { cols: 120, rows: 50 },
    resize
  })
  hv.reportViewerViewport('viewer-1', { cols: 80, rows: 24 }) // becomes the min
  expect(resize).toHaveBeenLastCalledWith(80, 24)
  hv.dropViewer('viewer-1')
  // back to the host's own size.
  expect(resize).toHaveBeenLastCalledWith(120, 50)
  expect(hv.effectiveSize()).toEqual({ cols: 120, rows: 50 })
})
