import { createTenantObjectKeyBuilder } from '@pie/object-storage-adapter'
import {
  AccessToken,
  AgentDispatchClient,
  AudioCodec,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  RoomServiceClient,
  S3Upload,
  WebhookReceiver
} from 'livekit-server-sdk'
import type { MeetingMediaConfig } from './meeting-media-config'
import type {
  MeetingMediaService,
  MeetingMediaRecordingSession,
  MeetingMediaToken,
  MeetingMediaWebhookEvent
} from './meeting-media-service'

export class LiveKitMeetingMediaService implements MeetingMediaService {
  readonly serverUrl: string
  private readonly config: MeetingMediaConfig
  private readonly rooms: RoomServiceClient
  private readonly egress: EgressClient
  private readonly dispatches: AgentDispatchClient
  private readonly webhooks: WebhookReceiver

  constructor(config: MeetingMediaConfig) {
    this.config = config
    this.serverUrl = config.serverUrl
    this.rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret)
    this.egress = new EgressClient(config.apiUrl, config.apiKey, config.apiSecret)
    this.dispatches = new AgentDispatchClient(config.apiUrl, config.apiKey, config.apiSecret)
    this.webhooks = new WebhookReceiver(config.apiKey, config.apiSecret)
  }

  async ensureRoom(input: {
    roomName: string
    organizationId: string
    meetingId: string
    title: string
  }): Promise<void> {
    const existing = await this.rooms.listRooms([input.roomName])
    if (existing.length > 0) return
    try {
      await this.rooms.createRoom({
        name: input.roomName,
        emptyTimeout: 10 * 60,
        departureTimeout: 60,
        maxParticipants: 100,
        metadata: JSON.stringify({
          organizationId: input.organizationId,
          meetingId: input.meetingId,
          title: input.title
        })
      })
    } catch (error) {
      // Concurrent token requests may both observe no room; accept the winner's room only.
      const concurrent = await this.rooms.listRooms([input.roomName])
      if (concurrent.length === 0) throw error
    }
  }

  async issueParticipantToken(input: {
    roomName: string
    userId: string
    role: 'host' | 'participant'
  }): Promise<MeetingMediaToken> {
    const issuedAt = Date.now()
    const accessToken = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity: input.userId,
      ttl: this.config.tokenTtlSeconds,
      metadata: JSON.stringify({ role: input.role })
    })
    accessToken.addGrant({
      roomJoin: true,
      room: input.roomName,
      roomAdmin: input.role === 'host',
      canPublish: true,
      canSubscribe: true,
      // Chat remains in Pie's durable channel domain instead of ephemeral media data packets.
      canPublishData: false
    })
    return {
      token: await accessToken.toJwt(),
      expiresAt: new Date(issuedAt + this.config.tokenTtlSeconds * 1000).toISOString()
    }
  }

  async closeRoom(roomName: string): Promise<void> {
    const existing = await this.rooms.listRooms([roomName])
    if (existing.length > 0) {
      await this.rooms.deleteRoom(roomName)
    }
  }

  private recordingOutput(filepath: string, fileType: EncodedFileType): EncodedFileOutput {
    const storage = this.config.recordingStorage
    if (!storage) throw new Error('meeting recording storage is not configured')
    return new EncodedFileOutput({
      fileType,
      filepath,
      output: {
        case: 's3',
        value: new S3Upload({
          endpoint: storage.endpoint,
          bucket: storage.bucket,
          accessKey: storage.accessKey,
          secret: storage.secretKey,
          region: storage.region,
          forcePathStyle: storage.forcePathStyle
        })
      }
    })
  }

  async startRecording(input: {
    roomName: string
    organizationId: string
    meetingId: string
    recordingId: string
  }): Promise<MeetingMediaRecordingSession> {
    const keys = createTenantObjectKeyBuilder(input.organizationId)
    let videoEgressId: string | null = null
    let audioEgressId: string | null = null
    let transcriptionDispatchId: string | null = null
    try {
      const video = await this.egress.startRoomCompositeEgress(
        input.roomName,
        this.recordingOutput(
          `${keys.keyForObject('recordings', input.recordingId)}.mp4`,
          EncodedFileType.MP4
        ),
        { layout: 'grid' }
      )
      videoEgressId = video.egressId
      const audio = await this.egress.startRoomCompositeEgress(
        input.roomName,
        this.recordingOutput(
          `${keys.keyForObject('transcripts', input.recordingId)}.mp3`,
          EncodedFileType.MP3
        ),
        {
          audioOnly: true,
          // A compact mono-quality MP3 keeps normal meetings below the transcription upload limit.
          encodingOptions: new EncodingOptions({
            audioCodec: AudioCodec.AC_MP3,
            audioBitrate: 16,
            audioFrequency: 16_000
          })
        }
      )
      audioEgressId = audio.egressId
      if (this.config.transcriptionAgentName) {
        const dispatch = await this.dispatches.createDispatch(
          input.roomName,
          this.config.transcriptionAgentName,
          {
            metadata: JSON.stringify({
              organizationId: input.organizationId,
              meetingId: input.meetingId,
              recordingId: input.recordingId
            })
          }
        )
        transcriptionDispatchId = dispatch.id
      }
      return { videoEgressId, audioEgressId, transcriptionDispatchId }
    } catch (error) {
      await Promise.allSettled([
        ...(videoEgressId ? [this.egress.stopEgress(videoEgressId)] : []),
        ...(audioEgressId ? [this.egress.stopEgress(audioEgressId)] : []),
        ...(transcriptionDispatchId
          ? [this.dispatches.deleteDispatch(transcriptionDispatchId, input.roomName)]
          : [])
      ])
      throw error
    }
  }

  async stopRecording(input: {
    roomName: string
    videoEgressId: string | null
    audioEgressId: string | null
    transcriptionDispatchId: string | null
  }): Promise<void> {
    const work = [
      ...(input.videoEgressId ? [this.egress.stopEgress(input.videoEgressId)] : []),
      ...(input.audioEgressId ? [this.egress.stopEgress(input.audioEgressId)] : []),
      ...(input.transcriptionDispatchId
        ? [this.dispatches.deleteDispatch(input.transcriptionDispatchId, input.roomName)]
        : [])
    ]
    const results = await Promise.allSettled(work)
    if (work.length > 0 && results.every((result) => result.status === 'rejected')) {
      throw new AggregateError(
        results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
        'all meeting recording stop operations failed'
      )
    }
  }

  async receiveWebhook(
    rawBody: string,
    authorization: string | undefined
  ): Promise<MeetingMediaWebhookEvent | null> {
    const event = await this.webhooks.receive(rawBody, authorization)
    const occurredAt = Number(event.createdAt) * 1000
    if (event.event === 'egress_ended') {
      const info = event.egressInfo
      if (!event.id || !info?.roomName || !info.egressId) return null
      const fileDuration = info.fileResults[0]?.duration
      const durationNanoseconds =
        fileDuration && fileDuration > 0n ? fileDuration : info.endedAt - info.startedAt
      return {
        eventId: event.id,
        eventType: 'egress_ended',
        roomName: info.roomName,
        egressId: info.egressId,
        succeeded: info.status === EgressStatus.EGRESS_COMPLETE,
        durationSeconds: Math.max(0, Number(durationNanoseconds) / 1_000_000_000),
        errorCode:
          info.status === EgressStatus.EGRESS_COMPLETE
            ? null
            : `LIVEKIT_EGRESS_${info.status}_${info.errorCode}`,
        occurredAt: new Date(occurredAt).toISOString()
      }
    }
    if (event.event !== 'participant_joined' && event.event !== 'participant_left') return null
    if (!event.id || !event.room?.name || !event.participant?.identity) return null
    return {
      eventId: event.id,
      eventType: event.event,
      roomName: event.room.name,
      participantIdentity: event.participant.identity,
      occurredAt: new Date(occurredAt).toISOString()
    }
  }
}
