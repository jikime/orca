import { describe, expect, it, vi } from 'vitest'
import { AgentEventUploadError, createAgentEventUploadClient } from './agent-event-upload-client'
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  type AgentEventBatchRequest,
  type AgentEventBatchResponse
} from '../../shared/agent-event-batch-contract'
import { makeEnvelope } from './__fixtures__/agent-event-envelope-fixture'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'

function request(): AgentEventBatchRequest {
  return {
    batchId: 'batch-1',
    producerId: 'producer-1',
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    events: [makeEnvelope({ id: 'evt-1', sequence: 1 })],
    clientCheckpoint: { streamId: 'stream-a', lastServerAck: 0 }
  }
}

function response(): AgentEventBatchResponse {
  return {
    batchId: 'batch-1',
    results: [{ id: 'evt-1', status: 'accepted' }],
    streamAcks: [{ streamId: 'stream-a', contiguousThrough: 1, gaps: [] }]
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function deps(fetchImpl: typeof fetch): Parameters<typeof createAgentEventUploadClient>[0] {
  return { getApiBaseUrl: () => API, getAccessToken: () => TOKEN, fetchImpl }
}

describe('agent-event-upload-client', () => {
  it('POSTs the batch with a bearer, Idempotency-Key, and the colon-suffixed URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response()))
    const client = createAgentEventUploadClient(deps(fetchImpl))
    const result = await client.upload(ORG, request(), 'idem-1')

    expect(result.results[0].status).toBe('accepted')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/agent-events:batch`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['idempotency-key']).toBe('idem-1')
    expect(JSON.parse(init.body as string).protocolVersion).toBe(AGENT_EVENT_PROTOCOL_VERSION)
  })

  it('throws with the status on a non-ok response (e.g. 409)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    const client = createAgentEventUploadClient(deps(fetchImpl))
    await expect(client.upload(ORG, request(), 'idem-1')).rejects.toMatchObject({
      name: 'AgentEventUploadError',
      status: 409
    })
  })

  it('throws when the response fails schema validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ batchId: 'x', results: 'nope' }))
    const client = createAgentEventUploadClient(deps(fetchImpl))
    await expect(client.upload(ORG, request(), 'idem-1')).rejects.toBeInstanceOf(
      AgentEventUploadError
    )
  })

  it('refuses to build a request when signed out (no base URL or token)', async () => {
    const fetchImpl = vi.fn()
    const client = createAgentEventUploadClient({
      getApiBaseUrl: () => null,
      getAccessToken: () => null,
      fetchImpl
    })
    await expect(client.upload(ORG, request(), 'idem-1')).rejects.toBeInstanceOf(
      AgentEventUploadError
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never puts the token in the error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const client = createAgentEventUploadClient(deps(fetchImpl))
    let message = ''
    try {
      await client.upload(ORG, request(), 'idem-1')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain(TOKEN)
    expect(message).toContain('500')
  })
})
