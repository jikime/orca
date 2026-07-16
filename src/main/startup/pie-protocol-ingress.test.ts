import type { App, Event } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  extractPieProtocolUrl,
  isPieProtocolUrl,
  registerPieProtocolOpenUrlHandler
} from './pie-protocol-ingress'

describe('extractPieProtocolUrl', () => {
  it('finds one Pie URL among executable and platform arguments', () => {
    expect(
      extractPieProtocolUrl([
        '/Applications/Pie.app/Contents/MacOS/Pie',
        '--flag',
        'pie://auth/callback?code=abc'
      ])
    ).toEqual({ status: 'single', url: 'pie://auth/callback?code=abc' })
  })

  it('rejects an ambiguous command line rather than choosing one callback', () => {
    expect(extractPieProtocolUrl(['pie://auth/one', 'PIE://auth/two'])).toEqual({
      status: 'ambiguous'
    })
  })

  it('does not treat an embedded URL in an unrelated argument as a protocol launch', () => {
    expect(extractPieProtocolUrl(['--redirect=pie://auth/callback'])).toEqual({ status: 'none' })
  })
})

describe('registerPieProtocolOpenUrlHandler', () => {
  it('intercepts Pie URLs and unregisters the exact listener', () => {
    let listener: ((event: Event, url: string) => void) | undefined
    const app = {
      off: vi.fn(),
      on: vi.fn((_event: string, nextListener: (event: Event, url: string) => void) => {
        listener = nextListener
      })
    } as unknown as Pick<App, 'off' | 'on'>
    const onUrl = vi.fn()
    const unregister = registerPieProtocolOpenUrlHandler(app, onUrl)
    const event = { preventDefault: vi.fn() } as unknown as Event

    listener?.(event, 'pie://auth/callback')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(onUrl).toHaveBeenCalledWith('pie://auth/callback')

    unregister()
    expect(app.off).toHaveBeenCalledWith('open-url', listener)
  })

  it('leaves unrelated URL events untouched', () => {
    let listener: ((event: Event, url: string) => void) | undefined
    const app = {
      off: vi.fn(),
      on: vi.fn((_event: string, nextListener: (event: Event, url: string) => void) => {
        listener = nextListener
      })
    } as unknown as Pick<App, 'off' | 'on'>
    const onUrl = vi.fn()
    registerPieProtocolOpenUrlHandler(app, onUrl)
    const event = { preventDefault: vi.fn() } as unknown as Event

    listener?.(event, 'https://pielab.ai/auth/callback')
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(onUrl).not.toHaveBeenCalled()
  })
})

describe('isPieProtocolUrl', () => {
  it('matches the scheme case-insensitively without trimming untrusted input', () => {
    expect(isPieProtocolUrl('PIE://auth/callback')).toBe(true)
    expect(isPieProtocolUrl(' pie://auth/callback')).toBe(false)
  })
})
