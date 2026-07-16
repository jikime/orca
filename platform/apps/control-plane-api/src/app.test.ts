import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

const VALID_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c'

function appWithPing(ok: boolean) {
  return buildApp({ ping: async () => ok })
}

describe('control-plane-api', () => {
  it('reports liveness on /healthz', async () => {
    const response = await appWithPing(true).inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('reports readiness when the database answers', async () => {
    const response = await appWithPing(true).inject({ method: 'GET', url: '/readyz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ready' })
  })

  it('returns 503 problem+json when the database is unreachable', async () => {
    const response = await appWithPing(false).inject({ method: 'GET', url: '/readyz' })
    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const problem = response.json()
    expect(problem.code).toBe('SERVICE_UNAVAILABLE')
    expect(problem.status).toBe(503)
    expect(problem.requestId).toMatch(/^[0-9a-f]{32}$/)
  })

  it('adopts an inbound traceparent and echoes it', async () => {
    const response = await appWithPing(false).inject({
      method: 'GET',
      url: '/readyz',
      headers: { traceparent: VALID_TRACEPARENT }
    })
    expect(response.headers.traceparent).toBe(VALID_TRACEPARENT)
    expect(response.json().requestId).toBe(TRACE_ID)
  })

  it('mints a fresh traceparent when none is supplied', async () => {
    const response = await appWithPing(true).inject({ method: 'GET', url: '/healthz' })
    expect(response.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  it('answers unknown routes with a NOT_FOUND problem+json', async () => {
    const response = await appWithPing(true).inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json().code).toBe('NOT_FOUND')
  })

  it('validates a 2020-12 body schema via Ajv2020 (accepts valid input)', async () => {
    const response = await appWithPing(true).inject({
      method: 'POST',
      url: '/internal/echo',
      payload: { message: 'hi' }
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ echoed: 'hi' })
  })

  it('rejects a body that violates the 2020-12 schema with a validation problem', async () => {
    const response = await appWithPing(true).inject({
      method: 'POST',
      url: '/internal/echo',
      payload: { wrong: true }
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('VALIDATION_FAILED')
  })
})
