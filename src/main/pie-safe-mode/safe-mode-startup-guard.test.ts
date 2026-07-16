import { describe, expect, it, vi } from 'vitest'
import { guardStartupService } from './safe-mode-startup-guard'

describe('guardStartupService', () => {
  it('runs the start function when the subsystem is not disabled', async () => {
    const start = vi.fn(async () => {})
    const guarded = guardStartupService('terminal-daemon', start, {
      isDisabled: () => false,
      log: () => {}
    })
    await guarded()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('skips the start function and logs when the subsystem is disabled', async () => {
    const start = vi.fn(async () => {})
    const log = vi.fn()
    const guarded = guardStartupService('agent-hooks', start, {
      isDisabled: (subsystem) => subsystem === 'agent-hooks',
      log
    })
    await guarded()
    expect(start).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[safe-mode] skipping agent-hooks startup')
  })

  it('forwards arguments to the wrapped start function', async () => {
    const start = vi.fn(async (_signal: AbortSignal) => {})
    const guarded = guardStartupService('terminal-daemon', start, {
      isDisabled: () => false,
      log: () => {}
    })
    const signal = new AbortController().signal
    await guarded(signal)
    expect(start).toHaveBeenCalledWith(signal)
  })
})
