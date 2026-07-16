export type PieRealtimeConfig = {
  enabled: boolean
  wsUrl: string | null
  organizationId: string | null
  instanceId: string
}

// Dev-gated: the client only connects when an explicit WS URL + org are provided
// (e.g. PIE_REALTIME_URL). There is NO auto-connect in production defaults —
// instance discovery and connection profiles are a later slice (doc 31).
export function loadPieRealtimeConfig(env: NodeJS.ProcessEnv = process.env): PieRealtimeConfig {
  const wsUrl = env.PIE_REALTIME_URL?.trim() || null
  const organizationId = env.PIE_REALTIME_ORG_ID?.trim() || null
  const instanceId = env.PIE_REALTIME_INSTANCE_ID?.trim() || 'pie-desktop-dev'
  return {
    enabled: Boolean(wsUrl && organizationId),
    wsUrl,
    organizationId,
    instanceId
  }
}

/** The REST origin for listResourceChanges, derived from the WS URL (ws→http). */
export function deriveApiBaseUrl(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.origin
}
