import { describe, expect, it, vi } from 'vitest'
import {
  addChannelMember,
  createChannel,
  createDm,
  createGroupDm,
  listChannelMembers,
  listMembers,
  muteChannel,
  removeChannelMember,
  updateChannel,
  unmuteChannel
} from './chat-channel-admin-client'
import { PieChatError } from './chat-control-plane-http'
import type { PieChannel } from '../../shared/pie-chat-contract'

const API = 'https://cp.example/v1'
const TOKEN = 'access-token-value'
const ORG = '20000000-0000-4000-8000-000000000001'
const CHANNEL = '20000000-0000-4000-8000-000000000002'
const OTHER = '20000000-0000-4000-8000-000000000005'
const THIRD = '20000000-0000-4000-8000-000000000006'

function channelFixture(overrides: Partial<PieChannel> = {}): PieChannel {
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
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('chat-channel-admin-client', () => {
  it('creates a channel with a bearer + Idempotency-Key and a name-only body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(channelFixture(), 201))
    const created = await createChannel(
      API,
      TOKEN,
      ORG,
      { name: 'general', idempotencyKey: 'key-1' },
      fetchImpl
    )
    expect(created.id).toBe(CHANNEL)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['idempotency-key']).toBe('key-1')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'general' })
  })

  it('includes visibility in the create body when supplied', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(channelFixture({ visibility: 'project' }), 201))
    await createChannel(
      API,
      TOKEN,
      ORG,
      { name: 'proj', visibility: 'project', idempotencyKey: 'key-2' },
      fetchImpl
    )
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual({
      name: 'proj',
      visibility: 'project'
    })
  })

  it('creates a 1:1 DM by posting the other user id to /dms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(channelFixture({ kind: 'dm' }), 201))
    const dm = await createDm(API, TOKEN, ORG, OTHER, fetchImpl)
    expect(dm.kind).toBe('dm')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/dms`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ otherUserId: OTHER })
  })

  it('creates a group DM by posting the participant ids to /group-dms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(channelFixture({ kind: 'dm' }), 201))
    await createGroupDm(API, TOKEN, ORG, [OTHER, THIRD], fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/group-dms`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ participantUserIds: [OTHER, THIRD] })
  })

  it('mutes with PUT and unmutes with DELETE on the channel /mute route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await muteChannel(API, TOKEN, ORG, CHANNEL, fetchImpl)
    await unmuteChannel(API, TOKEN, ORG, CHANNEL, fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/mute`)
    expect(fetchImpl.mock.calls[0][1].method).toBe('PUT')
    expect(fetchImpl.mock.calls[1][1].method).toBe('DELETE')
  })

  it('adds an organization member to a channel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await addChannelMember(API, TOKEN, ORG, CHANNEL, OTHER, fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}/members`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ userId: OTHER })
  })

  it('updates channel metadata with OCC and idempotency headers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(channelFixture({ topic: 'Launch', version: 2 })))
    const updated = await updateChannel(
      API,
      TOKEN,
      ORG,
      CHANNEL,
      { update: { topic: 'Launch' }, expectedVersion: 1, idempotencyKey: 'update-1' },
      fetchImpl
    )
    expect(updated.topic).toBe('Launch')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${API}/organizations/${ORG}/channels/${CHANNEL}`)
    expect(init.method).toBe('PATCH')
    expect(init.headers['if-match']).toBe('"channel-1"')
    expect(init.headers['idempotency-key']).toBe('update-1')
  })

  it('lists and removes channel-scoped members', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ userId: OTHER, role: 'member', addedAt: '2026-07-16T00:00:00.000Z' }]
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const roster = await listChannelMembers(API, TOKEN, ORG, CHANNEL, fetchImpl)
    await removeChannelMember(API, TOKEN, ORG, CHANNEL, OTHER, 'remove-1', fetchImpl)
    expect(roster[0].userId).toBe(OTHER)
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `${API}/organizations/${ORG}/channels/${CHANNEL}/members/${OTHER}`
    )
    expect(fetchImpl.mock.calls[1][1].headers['idempotency-key']).toBe('remove-1')
  })

  it('lists members from the membership roster, filtering revoked and deriving a label', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          { userId: OTHER, displayName: 'Grace Hopper', status: 'active' },
          { userId: THIRD, status: 'revoked' }
        ]
      })
    )
    const members = await listMembers(API, TOKEN, ORG, fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${API}/organizations/${ORG}/memberships`)
    expect(members).toHaveLength(1)
    expect(members[0].userId).toBe(OTHER)
    expect(members[0].displayName).toBe('Grace Hopper')
  })

  it('throws PieChatError with the status on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    await expect(
      createChannel(API, TOKEN, ORG, { name: 'x', idempotencyKey: 'k' }, fetchImpl)
    ).rejects.toMatchObject({ name: 'PieChatError', status: 403 })
  })

  it('throws when a created channel fails schema validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'not-a-uuid' }, 201))
    await expect(
      createChannel(API, TOKEN, ORG, { name: 'x', idempotencyKey: 'k' }, fetchImpl)
    ).rejects.toBeInstanceOf(PieChatError)
  })
})
