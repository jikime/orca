import { describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { PUBLIC_PAGE_ROUTES } from './public-pages-routes'

function app() {
  return buildApp({ ping: async () => true })
}

describe('public utility pages', () => {
  it.each(PUBLIC_PAGE_ROUTES)('serves %s with a strict CSP and no inline script', async (route) => {
    const response = await app().inject({ method: 'GET', url: route })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')

    const csp = response.headers['content-security-policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    // Strict: no script is allowed at all, and nothing may run inline.
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('script-src')

    const body = response.body
    expect(body).not.toContain('<script')
    // No inline styles either — styling comes from the same-origin stylesheet.
    expect(body).not.toContain('<style')
    expect(body).toContain('/public/pie.css')
  })

  it('serves the shared stylesheet as same-origin CSS', async () => {
    const response = await app().inject({ method: 'GET', url: '/public/pie.css' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/css')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  })
})
