import { describe, expect, it } from 'vitest'
import { decodeJwt } from 'jose'
import { LiveKitMeetingMediaService } from './livekit-meeting-media'
import { loadMeetingMediaConfig } from './meeting-media-config'
import { meetingMediaRoomName, parseMeetingMediaRoomName } from './meeting-media-service'

describe('meeting media boundary', () => {
  const organizationId = '7b47cb66-989a-4c66-b02d-1484c47e8349'
  const meetingId = '6230ab42-bef7-47eb-a901-34998fa1a91e'

  it('round-trips tenant-scoped room names and rejects malformed names', () => {
    const name = meetingMediaRoomName(organizationId, meetingId)
    expect(parseMeetingMediaRoomName(name)).toEqual({ organizationId, meetingId })
    expect(parseMeetingMediaRoomName(`pie_${organizationId}_not-a-uuid`)).toBeNull()
    expect(parseMeetingMediaRoomName(`other_${organizationId}_${meetingId}`)).toBeNull()
  })

  it('derives the server API URL and bounds short-lived token TTLs', () => {
    expect(
      loadMeetingMediaConfig({
        PIE_LIVEKIT_WS_URL: 'wss://media.example.test',
        PIE_LIVEKIT_API_KEY: 'key',
        PIE_LIVEKIT_API_SECRET: 'secret',
        PIE_LIVEKIT_TOKEN_TTL_SECONDS: '600'
      })
    ).toEqual({
      serverUrl: 'wss://media.example.test',
      apiUrl: 'https://media.example.test',
      apiKey: 'key',
      apiSecret: 'secret',
      tokenTtlSeconds: 600
    })
    expect(() =>
      loadMeetingMediaConfig({
        PIE_LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
        PIE_LIVEKIT_API_KEY: 'key'
      })
    ).toThrow(/must be set together/)
    expect(() =>
      loadMeetingMediaConfig({
        PIE_LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
        PIE_LIVEKIT_API_KEY: 'key',
        PIE_LIVEKIT_API_SECRET: 'secret',
        PIE_LIVEKIT_TOKEN_TTL_SECONDS: '30'
      })
    ).toThrow(/between 60 and 3600/)
    expect(() =>
      loadMeetingMediaConfig({
        PIE_LIVEKIT_WS_URL: 'ws://media.example.test',
        PIE_LIVEKIT_API_KEY: 'key',
        PIE_LIVEKIT_API_SECRET: 'secret'
      })
    ).toThrow(/must use wss/)
  })

  it('issues a room-scoped participant token without exposing the API secret', async () => {
    const media = new LiveKitMeetingMediaService({
      serverUrl: 'ws://127.0.0.1:7880',
      apiUrl: 'http://127.0.0.1:7880',
      apiKey: 'test-key',
      apiSecret: 'test-secret-01234567890123456789',
      tokenTtlSeconds: 300
    })
    const issued = await media.issueParticipantToken({
      roomName: 'pie_room',
      userId: organizationId,
      role: 'participant'
    })
    const claims = decodeJwt(issued.token) as {
      sub?: string
      video?: Record<string, unknown>
    }
    expect(claims.sub).toBe(organizationId)
    expect(claims.video).toMatchObject({
      room: 'pie_room',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false
    })
    expect(issued.token).not.toContain('test-secret')
  })
})
