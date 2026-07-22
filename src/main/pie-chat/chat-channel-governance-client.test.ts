import { describe, expect, it, vi } from 'vitest'
import {
  applyChannelRetention,
  exportChannel,
  listChannelAudit
} from './chat-channel-governance-client'
import { PieChatError } from './chat-control-plane-http'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const AUDIT = '20000000-0000-4000-8000-000000000003'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-channel-governance-client', () => {
  it('lists validated channel audit entries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: AUDIT,
            actorId: null,
            action: 'channel.retention_applied',
            targetType: 'channel',
            targetId: CHANNEL,
            reason: null,
            occurredAt: '2026-07-21T00:00:00.000Z'
          }
        ]
      })
    )
    const entries = await listChannelAudit(API, TOKEN, ORG, CHANNEL, fetchImpl)
    expect(entries[0]?.action).toBe('channel.retention_applied')
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/audit`)
  })

  it('exports a validated channel snapshot', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ exportedAt: '2026-07-21T00:00:00.000Z', truncated: false, messages: [] })
      )
    const exported = await exportChannel(API, TOKEN, ORG, CHANNEL, fetchImpl)
    expect(exported).toMatchObject({ truncated: false, messages: [] })
  })

  it('applies retention with POST and returns the redacted count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, redactedCount: 7 }))
    await expect(
      applyChannelRetention(API, TOKEN, ORG, CHANNEL, { idempotencyKey: 'retain-1' }, fetchImpl)
    ).resolves.toBe(7)
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      'idempotency-key': 'retain-1'
    })
  })

  it('rejects malformed and non-success responses', async () => {
    const invalid = vi.fn().mockResolvedValue(jsonResponse({ items: [{ id: 'invalid' }] }))
    await expect(listChannelAudit(API, TOKEN, ORG, CHANNEL, invalid)).rejects.toBeInstanceOf(
      PieChatError
    )
    const forbidden = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    await expect(exportChannel(API, TOKEN, ORG, CHANNEL, forbidden)).rejects.toMatchObject({
      status: 403
    })
  })
})
