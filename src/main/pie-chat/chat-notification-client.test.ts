import { describe, expect, it, vi } from 'vitest'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from './chat-notification-client'
import { PieChatError } from './chat-control-plane-http'
import type { PieNotification } from '../../shared/pie-chat-contract'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '20000000-0000-4000-8000-000000000010'
const NOTIF = '20000000-0000-4000-8000-0000000000c1'

function notificationFixture(overrides: Partial<PieNotification> = {}): PieNotification {
  return {
    id: NOTIF,
    organizationId: ORG,
    userId: '20000000-0000-4000-8000-0000000000aa',
    type: 'mention',
    channelId: CHANNEL,
    messageId: MESSAGE,
    seen: false,
    read: false,
    createdAt: '2026-07-16T00:00:00.000Z',
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-notification-client', () => {
  it('lists notifications with a bearer on the org notifications route', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [notificationFixture()], nextCursor: null }))
    const result = await listNotifications(API, TOKEN, ORG, fetchImpl)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe(NOTIF)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/notifications`)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('marks one notification read via POST on the /:id/read route', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(notificationFixture({ read: true, seen: true })))
    const updated = await markNotificationRead(API, TOKEN, ORG, NOTIF, fetchImpl)
    expect(updated.read).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/notifications/${NOTIF}/read`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('marks all read via the colon-suffixed :read-all action and returns the count', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ updated: 3 }))
    const count = await markAllNotificationsRead(API, TOKEN, ORG, fetchImpl)
    expect(count).toBe(3)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/notifications:read-all`)
    expect(init.method).toBe('POST')
  })

  it('throws PieChatError with the status on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    await expect(listNotifications(API, TOKEN, ORG, fetchImpl)).rejects.toMatchObject({
      name: 'PieChatError',
      status: 403
    })
  })

  it('throws when a listed notification fails schema validation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [{ id: 'not-a-uuid' }], nextCursor: null }))
    await expect(listNotifications(API, TOKEN, ORG, fetchImpl)).rejects.toBeInstanceOf(PieChatError)
  })
})
