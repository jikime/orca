import { LiveKitMeetingMediaService } from './livekit-meeting-media'
import type { MeetingMediaService } from './meeting-media-service'

export type MeetingMediaConfig = {
  serverUrl: string
  apiUrl: string
  apiKey: string
  apiSecret: string
  tokenTtlSeconds: number
  recordingStorage?: {
    endpoint: string
    bucket: string
    accessKey: string
    secretKey: string
    region: string
    forcePathStyle: boolean
  }
  transcriptionAgentName?: string
}

function recordingStorageFromEnv(
  env: NodeJS.ProcessEnv
): MeetingMediaConfig['recordingStorage'] | undefined {
  const endpoint = env.PIE_LIVEKIT_EGRESS_S3_ENDPOINT
  const bucket = env.PIE_OBJECT_STORAGE_BUCKET
  const accessKey = env.PIE_OBJECT_STORAGE_ACCESS_KEY
  const secretKey = env.PIE_OBJECT_STORAGE_SECRET_KEY
  const values = [endpoint, bucket, accessKey, secretKey]
  if (values.every((value) => !value)) return undefined
  if (values.some((value) => !value)) {
    throw new Error(
      'PIE_LIVEKIT_EGRESS_S3_ENDPOINT and PIE_OBJECT_STORAGE_BUCKET/access/secret must be set together'
    )
  }
  const parsed = new URL(endpoint!)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('PIE_LIVEKIT_EGRESS_S3_ENDPOINT must use http:// or https://')
  }
  return {
    endpoint: parsed.toString().replace(/\/$/, ''),
    bucket: bucket!,
    accessKey: accessKey!,
    secretKey: secretKey!,
    region: env.PIE_OBJECT_STORAGE_REGION ?? 'us-east-1',
    forcePathStyle: env.PIE_OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false'
  }
}

function apiUrlFor(serverUrl: string): string {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.toString().replace(/\/$/, '')
}

export function loadMeetingMediaConfig(
  env: NodeJS.ProcessEnv = process.env
): MeetingMediaConfig | null {
  const serverUrl = env.PIE_LIVEKIT_WS_URL
  const apiKey = env.PIE_LIVEKIT_API_KEY
  const apiSecret = env.PIE_LIVEKIT_API_SECRET
  if (!serverUrl && !apiKey && !apiSecret) return null
  if (!serverUrl || !apiKey || !apiSecret) {
    throw new Error(
      'PIE_LIVEKIT_WS_URL, PIE_LIVEKIT_API_KEY, and PIE_LIVEKIT_API_SECRET must be set together'
    )
  }
  const parsed = new URL(serverUrl)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('PIE_LIVEKIT_WS_URL must use ws:// or wss://')
  }
  if (parsed.protocol === 'ws:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') {
    throw new Error('PIE_LIVEKIT_WS_URL must use wss:// unless it is a loopback address')
  }
  const tokenTtlSeconds = Number.parseInt(env.PIE_LIVEKIT_TOKEN_TTL_SECONDS ?? '300', 10)
  if (!Number.isInteger(tokenTtlSeconds) || tokenTtlSeconds < 60 || tokenTtlSeconds > 3600) {
    throw new Error('PIE_LIVEKIT_TOKEN_TTL_SECONDS must be between 60 and 3600')
  }
  const recordingStorage = recordingStorageFromEnv(env)
  return {
    serverUrl: parsed.toString().replace(/\/$/, ''),
    apiUrl: apiUrlFor(serverUrl),
    apiKey,
    apiSecret,
    tokenTtlSeconds,
    ...(recordingStorage ? { recordingStorage } : {}),
    ...(env.PIE_MEETING_TRANSCRIPTION_AGENT_NAME
      ? { transcriptionAgentName: env.PIE_MEETING_TRANSCRIPTION_AGENT_NAME }
      : {})
  }
}

export function loadMeetingMediaFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MeetingMediaService | null {
  const config = loadMeetingMediaConfig(env)
  return config ? new LiveKitMeetingMediaService(config) : null
}
