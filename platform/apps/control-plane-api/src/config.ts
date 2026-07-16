export type ApiConfig = {
  host: string
  port: number
  databaseUrl: string
  serviceName: string
}

// Why: each process reads its OWN database credential (doc 30 separates app and
// worker credentials); fall back to DATABASE_URL for single-URL local dev.
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const databaseUrl = env.PIE_API_DATABASE_URL ?? env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('control-plane-api requires PIE_API_DATABASE_URL or DATABASE_URL')
  }
  return {
    host: env.PIE_API_HOST ?? '0.0.0.0',
    port: Number.parseInt(env.PIE_API_PORT ?? '8080', 10),
    databaseUrl,
    serviceName: 'control-plane-api'
  }
}
