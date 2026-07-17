import { describe, expect, it, vi } from 'vitest'
import {
  addReaction,
  listPins,
  pinMessage,
  removeReaction,
  unpinMessage
} from './chat-message-actions-client'
import type { PieMessage } from '../../shared/pie-chat-contract'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '20000000-0000-4000-8000-000000000003'

function messageFixture(overrides: Partial<PieMessage> = {}): PieMessage {
  return {
    id: MESSAGE,
    organizationId: ORG,
    channelId: CHANNEL,
    authorId: '20000000-0000-4000-8000-000000000004',
    body: 'hello',
    visibility: 'internal',
    version: 1,
    threadRootMessageId: null,
    replyCount: 0,
    reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
    attachments: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    edited: false,
    revisionCount: 0,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    pinned: true,
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-message-actions-client', () => {
  it('adds a reaction with a bearer + Idempotency-Key and returns the updated message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(messageFixture()))
    const updated = await addReaction(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      MESSAGE,
      { emoji: '👍', idempotencyKey: 'key-1' },
      fetchImpl
    )
    expect(updated.reactions[0].emoji).toBe('👍')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/messages/${MESSAGE}/reactions`
    )
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['idempotency-key']).toBe('key-1')
    expect(JSON.parse(init.body as string)).toEqual({ emoji: '👍' })
  })

  it('removes a reaction via the emoji query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await removeReaction(API, TOKEN, ORG, CHANNEL, MESSAGE, '👍', fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/reactions?emoji=')
    expect(init.method).toBe('DELETE')
  })

  it('pins with PUT and unpins with DELETE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await pinMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, fetchImpl)
    await unpinMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, fetchImpl)
    expect(fetchImpl.mock.calls[0][1].method).toBe('PUT')
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/messages/${MESSAGE}/pin`
    )
    expect(fetchImpl.mock.calls[1][1].method).toBe('DELETE')
  })

  it('lists pins and validates the pinned-messages shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ message: messageFixture(), pinnedBy: ORG, pinnedAt: '2026-07-16T00:00:00.000Z' }]
      })
    )
    const pins = await listPins(API, TOKEN, ORG, CHANNEL, fetchImpl)
    expect(pins).toHaveLength(1)
    expect(pins[0].message.id).toBe(MESSAGE)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/pins`)
  })

  it('throws PieChatError with the status on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }))
    await expect(pinMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, fetchImpl)).rejects.toMatchObject({
      name: 'PieChatError',
      status: 409
    })
  })
})
