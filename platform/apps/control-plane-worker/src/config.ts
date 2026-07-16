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
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
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
    maxBackoffMs: intFromEnv(env.PIE_WORKER_MAX_BACKOFF_MS, 300_000)
  }
}
