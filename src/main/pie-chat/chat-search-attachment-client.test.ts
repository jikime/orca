import { describe, expect, it, vi } from 'vitest'
import {
  createAttachmentIntent,
  downloadAttachment,
  searchMessages,
  uploadAttachment
} from './chat-search-attachment-client'
import { PieChatError } from './chat-control-plane-http'
import type { PieMessage } from '../../shared/pie-chat-contract'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const MESSAGE = '20000000-0000-4000-8000-000000000003'
const CURSOR = '20000000-0000-4000-8000-000000000007'
const ATTACHMENT = '20000000-0000-4000-8000-000000000008'

function messageFixture(): PieMessage {
  return {
    id: MESSAGE,
    organizationId: ORG,
    channelId: CHANNEL,
    authorId: '20000000-0000-4000-8000-000000000004',
    body: 'find me',
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
    pinned: false
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-search-attachment-client', () => {
  it('searches messages with the q query param and validates results', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [messageFixture()], nextCursor: null }))
    const result = await searchMessages(API, TOKEN, ORG, { query: 'find me' }, fetchImpl)
    expect(result.items).toHaveLength(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/messages/search?q=find+me`)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('carries cursor + limit in the search query when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }))
    await searchMessages(API, TOKEN, ORG, { query: 'x', cursor: CURSOR, limit: 10 }, fetchImpl)
    const url = new URL(fetchImpl.mock.calls[0][0] as string)
    expect(url.searchParams.get('q')).toBe('x')
    expect(url.searchParams.get('cursor')).toBe(CURSOR)
    expect(url.searchParams.get('limit')).toBe('10')
  })

  it('creates an attachment intent with a bearer + Idempotency-Key and returns the presigned url', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          id: ATTACHMENT,
          objectId: 'obj-1',
          uploadUrl: 'https://storage.example/put',
          expiresAt: '2026-07-16T00:15:00.000Z'
        },
        201
      )
    )
    const intent = await createAttachmentIntent(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      { filename: 'a.png', contentType: 'image/png', byteSize: 12, idempotencyKey: 'key-1' },
      fetchImpl
    )
    expect(intent.uploadUrl).toBe('https://storage.example/put')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/attachments/intents`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('key-1')
    expect(JSON.parse(init.body as string)).toEqual({
      filename: 'a.png',
      contentType: 'image/png',
      byteSize: 12
    })
  })

  it('PUTs the bytes to the presigned url with no bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const bytes = new ArrayBuffer(4)
    await uploadAttachment('https://storage.example/put', bytes, 'image/png', fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://storage.example/put')
    expect(init.method).toBe('PUT')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('image/png')
    expect(headers.authorization).toBeUndefined()
    expect(init.body).toBe(bytes)
  })

  it('downloads an attachment via the /download route and validates the payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        url: 'https://storage.example/get',
        filename: 'a.png',
        contentType: 'image/png',
        expiresAt: '2026-07-16T00:05:00.000Z'
      })
    )
    const download = await downloadAttachment(API, TOKEN, ORG, CHANNEL, ATTACHMENT, fetchImpl)
    expect(download.url).toBe('https://storage.example/get')
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/attachments/${ATTACHMENT}/download`
    )
  })

  it('throws PieChatError with the status on a non-ok search response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }))
    await expect(searchMessages(API, TOKEN, ORG, { query: 'x' }, fetchImpl)).rejects.toMatchObject({
      name: 'PieChatError',
      status: 400
    })
  })

  it('throws when the attachment download fails schema validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: 123 }))
    await expect(
      downloadAttachment(API, TOKEN, ORG, CHANNEL, ATTACHMENT, fetchImpl)
    ).rejects.toBeInstanceOf(PieChatError)
  })
})
