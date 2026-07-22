import { describe, expect, it, vi } from 'vitest'
import {
  deleteMessage,
  editMessage,
  getMessage,
  listChannels,
  listMessages,
  markRead,
  PieChatError,
  sendMessage
} from './chat-control-plane-client'
import type { PieChannel, PieMessage } from '../../shared/pie-chat-contract'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '20000000-0000-4000-8000-000000000003'

function channelFixture(): PieChannel {
  return {
    id: CHANNEL,
    organizationId: ORG,
    name: 'general',
    kind: 'channel',
    scopeType: 'organization',
    scopeId: null,
    visibility: 'internal',
    topic: '',
    description: '',
    version: 1,
    archivedAt: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z'
  }
}

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
    reactions: [],
    attachments: [],
    createdAt: '2026-07-16T00:00:00.000Z',
    edited: false,
    revisionCount: 0,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    pinned: false,
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-control-plane-client', () => {
  it('lists channels with a bearer header and validates the response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [channelFixture()], nextCursor: null }))
    const channels = await listChannels(API, TOKEN, ORG, fetchImpl)

    expect(channels).toHaveLength(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels`)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('lists messages with pagination query params', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [messageFixture()], nextCursor: null }))
    const result = await listMessages(API, TOKEN, ORG, CHANNEL, { limit: 50 }, fetchImpl)

    expect(result.items).toHaveLength(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/messages?limit=50`
    )
  })

  it('fetches one exact message for notification navigation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(messageFixture()))
    const result = await getMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, fetchImpl)
    expect(result.id).toBe(MESSAGE)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/messages/${MESSAGE}`
    )
  })

  it('requests the latest page and an older-history cursor', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [messageFixture()], nextCursor: MESSAGE }))
    await listMessages(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      { limit: 50, before: MESSAGE, latest: true },
      fetchImpl
    )

    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/messages?limit=50&before=${MESSAGE}&latest=true`
    )
  })

  it('sends a message with a bearer and an Idempotency-Key header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(messageFixture(), 201))
    await sendMessage(API, TOKEN, ORG, CHANNEL, { body: 'hi', idempotencyKey: 'key-1' }, fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/messages`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['idempotency-key']).toBe('key-1')
    expect(JSON.parse(init.body as string)).toEqual({ body: 'hi' })
  })

  it('edits a message with an If-Match OCC header', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(messageFixture({ edited: true, revisionCount: 1 })))
    const updated = await editMessage(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      MESSAGE,
      { body: 'edited', expectedVersion: 3 },
      fetchImpl
    )

    expect(updated.edited).toBe(true)
    const init = fetchImpl.mock.calls[0][1]
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>)['if-match']).toBe('"message-3"')
  })

  it('soft-deletes a message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, undefined, fetchImpl)

    const init = fetchImpl.mock.calls[0][1]
    expect(init.method).toBe('DELETE')
  })

  it('includes a moderator reason when deleting another user message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteMessage(API, TOKEN, ORG, CHANNEL, MESSAGE, 'policy violation', fetchImpl)

    const init = fetchImpl.mock.calls[0][1]
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(init.body).toBe(JSON.stringify({ reason: 'policy violation' }))
  })

  it('marks a channel read with an Idempotency-Key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    await markRead(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      { lastReadMessageId: MESSAGE, idempotencyKey: 'key-2' },
      fetchImpl
    )

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/read`)
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('key-2')
  })

  it('throws PieChatError with the status on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    await expect(listChannels(API, TOKEN, ORG, fetchImpl)).rejects.toMatchObject({
      name: 'PieChatError',
      status: 403
    })
  })

  it('throws when the response fails schema validation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [{ id: 'not-a-uuid' }], nextCursor: null }))
    await expect(listChannels(API, TOKEN, ORG, fetchImpl)).rejects.toBeInstanceOf(PieChatError)
  })

  it('never puts the token in the error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    const error = await sendMessage(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      { body: 'x', idempotencyKey: 'k' },
      fetchImpl
    ).catch((caught) => caught as Error)
    expect(error.message).not.toContain(TOKEN)
  })
})
