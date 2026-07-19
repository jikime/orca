import { randomBytes } from 'node:crypto'

export type WorkerConfig = {
  databaseUrl: string
  heartbeatIntervalMs: number
  serviceName: string
  workerId: string
  batchSize: number
  leaseMs: number
  pollIntervalMs: number
  maxAttempts: number
  baseBackoffMs: number
  maxBackoffMs: number
  metricsIntervalMs: number
  meetingProcessing: MeetingProcessingConfig | null
}

export type MeetingProcessingConfig = {
  objectStorage: {
    endpoint: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
    region: string
    forcePathStyle: boolean
  }
  openAiApiKey: string
  openAiBaseUrl: string
  transcriptionModel: string
  minutesModel: string
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function meetingProcessingFromEnv(env: NodeJS.ProcessEnv): MeetingProcessingConfig | null {
  const endpoint = env.PIE_OBJECT_STORAGE_ENDPOINT
  const bucket = env.PIE_OBJECT_STORAGE_BUCKET
  const accessKeyId = env.PIE_OBJECT_STORAGE_ACCESS_KEY
  const secretAccessKey = env.PIE_OBJECT_STORAGE_SECRET_KEY
  const openAiApiKey = env.OPENAI_API_KEY
  const values = [endpoint, bucket, accessKeyId, secretAccessKey]
  if (values.every((value) => !value)) return null
  if (values.some((value) => !value)) {
    throw new Error('meeting processing requires all PIE_OBJECT_STORAGE_* settings together')
  }
  if (!openAiApiKey) return null
  return {
    objectStorage: {
      endpoint: endpoint!,
      bucket: bucket!,
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      region: env.PIE_OBJECT_STORAGE_REGION ?? 'us-east-1',
      forcePathStyle: env.PIE_OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false'
    },
    openAiApiKey,
    openAiBaseUrl: (env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, ''),
    transcriptionModel: env.PIE_MEETING_TRANSCRIPTION_MODEL ?? 'gpt-4o-transcribe-diarize',
    minutesModel: env.PIE_MEETING_MINUTES_MODEL ?? 'gpt-5.6-luna'
  }
}

// Why: the worker reads its OWN credential (pie_worker in production) separate
// from the API's; DATABASE_URL is the single-URL local-dev fallback.
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.PIE_WORKER_DATABASE_URL ?? env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('control-plane-worker requires PIE_WORKER_DATABASE_URL or DATABASE_URL')
  }
  return {
    databaseUrl,
    heartbeatIntervalMs: intFromEnv(env.PIE_WORKER_HEARTBEAT_MS, 15_000),
    serviceName: 'control-plane-worker',
    // Unique per process so claim ownership and lease diagnostics are traceable.
    workerId:
      env.PIE_WORKER_ID ?? `control-plane-worker-${process.pid}-${randomBytes(3).toString('hex')}`,
    batchSize: intFromEnv(env.PIE_WORKER_BATCH_SIZE, 32),
    leaseMs: intFromEnv(env.PIE_WORKER_LEASE_MS, 30_000),
    pollIntervalMs: intFromEnv(env.PIE_WORKER_POLL_MS, 1_000),
    maxAttempts: intFromEnv(env.PIE_WORKER_MAX_ATTEMPTS, 5),
    baseBackoffMs: intFromEnv(env.PIE_WORKER_BASE_BACKOFF_MS, 1_000),
    maxBackoffMs: intFromEnv(env.PIE_WORKER_MAX_BACKOFF_MS, 300_000),
    metricsIntervalMs: intFromEnv(env.PIE_WORKER_METRICS_INTERVAL_MS, 30_000),
    meetingProcessing: meetingProcessingFromEnv(env)
  }
}
