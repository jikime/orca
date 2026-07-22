import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererDevCspPlugin } from '../../build-plugins/renderer-dev-csp'

const productionHtml = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8')

// Why: 'wasm-unsafe-eval' legitimately contains the substring "unsafe-eval";
// this matches only the bare script-eval token we must never ship in production.
const BARE_UNSAFE_EVAL = /(?<!wasm-)'unsafe-eval'/

function extractCspContent(html: string): string {
  const match = html.match(/http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i)
  if (!match) {
    throw new Error('no CSP meta tag found')
  }
  return match[1]
}

describe('production renderer CSP', () => {
  it('ships a Content-Security-Policy meta tag', () => {
    const csp = extractCspContent(productionHtml)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("connect-src 'self'")
  })

  it('allows WebAssembly compilation but never bare unsafe-eval', () => {
    const csp = extractCspContent(productionHtml)
    expect(csp).toContain("'wasm-unsafe-eval'")
    expect(BARE_UNSAFE_EVAL.test(csp)).toBe(false)
  })

  it('limits meeting signaling to TLS or loopback in production', () => {
    const csp = extractCspContent(productionHtml)
    expect(csp).not.toContain('http://localhost')
    expect(csp).toContain('wss:')
    expect(csp).toContain('https:')
    expect(csp).toContain('ws://127.0.0.1:*')
    expect(csp).toContain('ws://[::1]:*')
    expect(csp).toContain('http://127.0.0.1:*')
    expect(csp).toContain('http://[::1]:*')
    expect(csp).not.toContain('ws://localhost')
  })
})

describe('renderer-dev-csp plugin', () => {
  const plugin = createRendererDevCspPlugin()

  it('only applies to the dev server', () => {
    expect(plugin.apply).toBe('serve')
  })

  it('rewrites the CSP to add HMR origins in dev', () => {
    const transform = plugin.transformIndexHtml
    const handler = typeof transform === 'function' ? transform : transform?.handler
    const rewritten = handler?.call(plugin, productionHtml, {
      path: '/index.html',
      filename: 'index.html'
    }) as string
    const csp = extractCspContent(rewritten)
    expect(csp).toContain('ws://localhost:*')
    expect(csp).toContain('http://localhost:*')
    expect(csp).toContain('ws://127.0.0.1:*')
    expect(csp).toContain('http://127.0.0.1:*')
    // Dev may eval; that relaxation must live here, not in the committed HTML.
    expect(BARE_UNSAFE_EVAL.test(csp)).toBe(true)
  })
})
