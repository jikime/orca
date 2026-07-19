export type InstanceDiscoveryDocument = {
  schemaVersion: 1
  instanceId: string
  displayName: string
  deploymentType: 'saas' | 'local_docker' | 'self_hosted' | 'on_prem'
  apiBaseUrl: string
  auth: {
    protocol: 'oidc'
    issuer: string
    clientId: string
    redirectModes: Array<'loopback' | 'private_uri_scheme'>
  }
  realtimeUrl: string
  mediaUrl?: string
  protocol: { api: string; realtime: string }
  minimumClientVersion: string
  capabilities: Record<string, boolean>
  expiresAt: string
}

export type DiscoveryConfig = {
  instanceId: string
  displayName: string
  deploymentType: InstanceDiscoveryDocument['deploymentType']
  apiBaseUrl: string
  issuer: string
  clientId: string
  realtimeUrl: string
  mediaUrl?: string
  minimumClientVersion: string
  ttlSeconds: number
}

// Sane loopback defaults for local dev (the discovery schema allows http://127.0.0.1).
export function loadDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  const mediaUrl =
    env.PIE_LIVEKIT_WS_URL && env.PIE_LIVEKIT_API_KEY && env.PIE_LIVEKIT_API_SECRET
      ? (env.PIE_DISCOVERY_MEDIA_URL ?? liveKitHttpUrl(env.PIE_LIVEKIT_WS_URL))
      : undefined
  return {
    instanceId: env.PIE_INSTANCE_ID ?? 'pie-local-dev',
    displayName: env.PIE_INSTANCE_DISPLAY_NAME ?? 'Pie (local dev)',
    deploymentType:
      (env.PIE_DEPLOYMENT_TYPE as DiscoveryConfig['deploymentType']) ?? 'local_docker',
    apiBaseUrl: env.PIE_DISCOVERY_API_BASE_URL ?? 'http://127.0.0.1:8080/v1',
    issuer: env.PIE_DISCOVERY_ISSUER ?? 'http://127.0.0.1:8080/realms/pie',
    clientId: env.PIE_DISCOVERY_CLIENT_ID ?? 'pie-desktop',
    realtimeUrl: env.PIE_DISCOVERY_REALTIME_URL ?? 'ws://127.0.0.1:8080/v1/realtime',
    ...(mediaUrl ? { mediaUrl } : {}),
    // Honest minimum-supported policy; overridable per deployment.
    minimumClientVersion: env.PIE_MINIMUM_CLIENT_VERSION ?? '0.1.0',
    ttlSeconds: Number.parseInt(env.PIE_DISCOVERY_TTL_SECONDS ?? '300', 10)
  }
}

function liveKitHttpUrl(serverUrl: string | undefined): string | undefined {
  if (!serverUrl) return undefined
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.toString().replace(/\/$/, '')
}

/**
 * Builds the discovery document with HONEST values: only endpoints that exist
 * today (api, realtime), capabilities reflecting features actually implemented in
 * R2, and the configured minimum-supported version.
 */
export function buildInstanceDiscovery(
  config: DiscoveryConfig,
  now: number
): InstanceDiscoveryDocument {
  return {
    schemaVersion: 1,
    instanceId: config.instanceId,
    displayName: config.displayName,
    deploymentType: config.deploymentType,
    apiBaseUrl: config.apiBaseUrl,
    auth: {
      protocol: 'oidc',
      issuer: config.issuer,
      clientId: config.clientId,
      redirectModes: ['loopback', 'private_uri_scheme']
    },
    realtimeUrl: config.realtimeUrl,
    ...(config.mediaUrl ? { mediaUrl: config.mediaUrl } : {}),
    protocol: { api: '1.0', realtime: '1.0' },
    minimumClientVersion: config.minimumClientVersion,
    capabilities: {
      organizationRead: true,
      resourceChanges: true,
      artifactUpload: true,
      remoteSupport: false,
      videoMeeting: Boolean(config.mediaUrl)
    },
    expiresAt: new Date(now + config.ttlSeconds * 1000).toISOString()
  }
}
