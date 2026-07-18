import { isSafeModeSubsystemDisabled } from '../pie-safe-mode/safe-mode-state'
import { createRealtimeChangesFetcher } from './realtime-changes-fetch'
import { deriveApiBaseUrl, loadPieRealtimeConfig } from './realtime-config'
import {
  createRealtimeConnection,
  type RealtimeClientStatus,
  type RealtimeConnection,
  type RealtimeConnectionOptions
} from './realtime-connection'
import type {
  PieRealtimeEphemeral,
  PieRealtimeResourceChanged
} from '../../shared/pie-realtime-contract'

let currentConnection: RealtimeConnection | null = null
let currentStatus: RealtimeClientStatus = { state: 'disabled' }

/** Read-only status surface for diagnostics; the module is Main-only and does not
 *  expose raw messages to the renderer this slice. */
export function getPieRealtimeStatus(): RealtimeClientStatus {
  return currentStatus
}

export type StartPieRealtimeOptions = {
  env?: NodeJS.ProcessEnv
  isDisabled?: () => boolean
  onChange?: (message: PieRealtimeResourceChanged) => void
  // Additive: ephemeral presence/typing frames routed to the chat renderer.
  onEphemeral?: (message: PieRealtimeEphemeral) => void
  // Supplies the current access token (from the auth lifecycle via the composition
  // root). Both the WS upgrade and the REST resync fetch use it. Defaults to null
  // (unauthenticated) so dev-gated realtime without login degrades to the server's
  // auth response rather than crashing.
  getAccessToken?: () => string | null
  // Test seam for the socket/fetch transport.
  connectionOverrides?: Partial<RealtimeConnectionOptions>
}

/**
 * Starts the Realtime client only when it is dev-gated ON (PIE_REALTIME_URL +
 * org) and safe mode has not disabled 'pie-realtime'. Returns null (and leaves
 * status 'disabled') otherwise — no connection attempt is made.
 */
export function startPieRealtimeIfEnabled(
  options: StartPieRealtimeOptions = {}
): RealtimeConnection | null {
  const config = loadPieRealtimeConfig(options.env)
  const isDisabled = options.isDisabled ?? (() => isSafeModeSubsystemDisabled('pie-realtime'))
  if (!config.enabled || !config.wsUrl || !config.organizationId || isDisabled()) {
    currentStatus = { state: 'disabled' }
    return null
  }

  const getAccessToken = options.getAccessToken ?? (() => null)
  const connection = createRealtimeConnection({
    url: config.wsUrl,
    instanceId: config.instanceId,
    organizationId: config.organizationId,
    isDisabled,
    getAccessToken,
    fetchChanges: createRealtimeChangesFetcher({
      apiBaseUrl: deriveApiBaseUrl(config.wsUrl),
      organizationId: config.organizationId,
      getAccessToken
    }),
    onStatus: (status) => {
      currentStatus = status
    },
    onChange: options.onChange,
    onEphemeral: options.onEphemeral,
    ...options.connectionOverrides
  })
  currentConnection = connection
  connection.start()
  return connection
}

export function stopPieRealtime(): void {
  currentConnection?.stop()
  currentConnection = null
  currentStatus = { state: 'disabled' }
}

export function __resetPieRealtimeForTests(): void {
  currentConnection = null
  currentStatus = { state: 'disabled' }
}
