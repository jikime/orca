export type WorkerConfig = {
  databaseUrl: string
  heartbeatIntervalMs: number
  serviceName: string
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
    heartbeatIntervalMs: Number.parseInt(env.PIE_WORKER_HEARTBEAT_MS ?? '15000', 10),
    serviceName: 'control-plane-worker'
  }
}
