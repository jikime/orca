import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  type MeetingResource,
  type PieDatabase
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import type { MeetingCalendarService } from './meeting-calendar-service'
import type { MeetingMediaService } from './meeting-media-service'

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let ownerId = ''
const calendarExports: MeetingResource[] = []

const calendar: MeetingCalendarService = {
  configuredProviders: () => ['google_workspace'],
  calendarId: (provider) => (provider === 'google_workspace' ? 'primary' : null),
  upsertEvent: async (_provider, input) => {
    calendarExports.push(input.meeting)
    return { eventId: `event-${input.meeting.id}`, webUrl: 'https://calendar.test/event' }
  }
}

const media: MeetingMediaService = {
  serverUrl: 'ws://127.0.0.1:7880',
  diagnoseConnectivity: async () => ({ reachable: true, latencyMs: 10 }),
  ensureRoom: async () => undefined,
  closeRoom: async () => undefined,
  issueParticipantToken: async ({ userId }) => ({
    token: `guest-media.${userId}`,
    expiresAt: new Date(Date.now() + 300_000).toISOString()
  }),
  startRecording: async () => ({
    videoEgressId: randomUUID(),
    audioEgressId: null,
    transcriptionDispatchId: null
  }),
  stopRecording: async () => undefined,
  muteParticipantMicrophone: async () => true,
  removeParticipant: async () => undefined,
  receiveWebhook: async () => null
}

function request(token: string | null, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

function org(path: string): string {
  return `/v1/organizations/${orgId}${path}`
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(`SKIPPED meeting M5: Docker unavailable — ${String(error)}`)
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({
    ping: async () => true,
    db,
    registry,
    tokenVerifier: createTestTokenVerifier(),
    meetingCalendar: calendar,
    meetingMedia: media
  })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `m5-${orgId.slice(0, 8)}`,
    displayName: 'Meeting M5'
  })
  ownerId = (
    await seedMembershipFixture(db, {
      organizationId: orgId,
      issuer: TEST_ISSUER,
      subject: 'owner',
      email: 'owner@pie.test',
      displayName: 'Owner',
      roleIds: ['organization_owner']
    })
  ).userId
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('meeting M5 schedule, calendar, context, and guest access', () => {
  it('exports a recurring remote-session meeting and keeps its context backlink', async (ctx) => {
    if (!harness) return ctx.skip()
    const scopeId = randomUUID()
    const createdResponse = await request('owner', org('/meetings'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        title: 'Remote support review',
        scopeKind: 'remote_session',
        scopeId,
        scheduledStart: '2026-07-22T05:00:00.000Z',
        scheduledEnd: '2026-07-22T06:00:00.000Z',
        timeZone: 'Asia/Seoul',
        recurrence: 'weekly'
      })
    })
    expect(createdResponse.status).toBe(201)
    const meeting = (await createdResponse.json()) as MeetingResource
    expect(meeting).toMatchObject({ timeZone: 'Asia/Seoul', recurrence: 'weekly' })

    const addOwner = await request('owner', org(`/meetings/${meeting.id}/participants`), {
      method: 'POST',
      body: JSON.stringify({ userId: ownerId })
    })
    expect(addOwner.status).toBe(201)
    const exported = await request('owner', org(`/meetings/${meeting.id}/calendar-exports`), {
      method: 'POST',
      body: JSON.stringify({ provider: 'google_workspace' })
    })
    expect(exported.status).toBe(201)
    expect(await exported.json()).toMatchObject({
      syncStatus: 'synced',
      eventId: `event-${meeting.id}`
    })
    expect(calendarExports.at(-1)?.id).toBe(meeting.id)

    const live = await request('owner', org(`/meetings/${meeting.id}:transition`), {
      method: 'POST',
      headers: { 'if-match': `"meeting-${meeting.version}"` },
      body: JSON.stringify({ toStatus: 'live' })
    })
    const liveMeeting = (await live.json()) as MeetingResource
    const ended = await request('owner', org(`/meetings/${meeting.id}:transition`), {
      method: 'POST',
      headers: { 'if-match': `"meeting-${liveMeeting.version}"` },
      body: JSON.stringify({ toStatus: 'ended' })
    })
    expect(ended.status).toBe(200)

    const scoped = await request(
      'owner',
      org(`/meetings?scopeKind=remote_session&scopeId=${scopeId}`)
    )
    const page = (await scoped.json()) as { items: MeetingResource[] }
    expect(page.items.map((item) => item.id)).toContain(meeting.id)
    expect(page.items).toContainEqual(
      expect.objectContaining({
        seriesId: meeting.id,
        occurrenceIndex: 1,
        status: 'scheduled',
        scheduledStart: '2026-07-29T05:00:00.000Z'
      })
    )
  })

  it('enforces limited guest expiry/revocation and host admission before media', async (ctx) => {
    if (!harness) return ctx.skip()
    const meetingResponse = await request('owner', org('/meetings'), {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: JSON.stringify({ title: 'Guest call' })
    })
    const meeting = (await meetingResponse.json()) as MeetingResource
    const linkResponse = await request('owner', org(`/meetings/${meeting.id}/guest-links`), {
      method: 'POST',
      body: JSON.stringify({
        identityMode: 'limited_guest',
        visibility: 'meeting_only',
        expiresInHours: 24
      })
    })
    expect(linkResponse.status).toBe(201)
    const created = (await linkResponse.json()) as {
      link: { id: string; version: number }
      rawToken: string
    }
    const redeemedResponse = await request(null, '/v1/public/meeting-guests:redeem', {
      method: 'POST',
      body: JSON.stringify({ token: created.rawToken, displayName: 'External guest' })
    })
    expect(redeemedResponse.status).toBe(201)
    const redeemed = (await redeemedResponse.json()) as {
      accessToken: string
      participant: { id: string; version: number; accessStatus: string }
    }
    expect(redeemed.participant.accessStatus).toBe('invited')

    const liveResponse = await request('owner', org(`/meetings/${meeting.id}:transition`), {
      method: 'POST',
      headers: { 'if-match': `"meeting-${meeting.version}"` },
      body: JSON.stringify({ toStatus: 'live' })
    })
    expect(liveResponse.status).toBe(200)
    const waiting = await request(null, '/v1/public/meeting-guests/waiting-room', {
      method: 'POST',
      body: JSON.stringify({ accessToken: redeemed.accessToken })
    })
    expect(waiting.status).toBe(200)
    const waitingParticipant = (await waiting.json()) as { id: string; version: number }
    const admitted = await request(
      'owner',
      org(`/meeting-participant-controls/${waitingParticipant.id}:admit`),
      {
        method: 'POST',
        headers: { 'if-match': `"meeting-participant-${waitingParticipant.version}"` }
      }
    )
    expect(admitted.status).toBe(200)
    const mediaToken = await request(null, '/v1/public/meeting-guests/media-token', {
      method: 'POST',
      body: JSON.stringify({ accessToken: redeemed.accessToken })
    })
    expect(mediaToken.status).toBe(200)

    const revoked = await request('owner', org(`/meeting-guest-links/${created.link.id}:revoke`), {
      method: 'POST',
      headers: { 'if-match': `"meeting-guest-link-${created.link.version}"` }
    })
    expect(revoked.status).toBe(200)
    const deniedAfterRevoke = await request(null, '/v1/public/meeting-guests/media-token', {
      method: 'POST',
      body: JSON.stringify({ accessToken: redeemed.accessToken })
    })
    expect(deniedAfterRevoke.status).toBe(401)
  })
})
