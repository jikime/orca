import { isSafeModeSubsystemDisabled } from '../pie-safe-mode/safe-mode-state'
import { loadPieAuthConfig, type PieAuthConfig } from './pie-auth-config'
import {
  createPieAuthService,
  type PieAuthService,
  type PieAuthServiceDeps
} from './pie-auth-service'

// Module singleton for index.ts wiring: constructed when dev-gated ON and not
// safe-mode-disabled. Login is EXPLICITLY triggered (no production auto-start).
let currentService: PieAuthService | null = null

export function getPieAuthService(): PieAuthService | null {
  return currentService
}

/** The active login's access token for other Main subsystems (realtime), or null.
 *  Main-only — never reaches the renderer. */
export function getPieAuthAccessToken(): string | null {
  return currentService?.getAccessToken() ?? null
}

/** Reactively rotate the access token (e.g. chat client on a 401). Single-flight
 *  in the service; returns false when no service is active. Main-only. */
export function forcePieAuthRefresh(): Promise<boolean> {
  return currentService?.forceRefresh() ?? Promise.resolve(false)
}

/** The active login's control-plane API base URL (includes /v1) for other Main
 *  subsystems (chat), or null when signed out. Main-only — never reaches the renderer. */
export function getPieAuthApiBaseUrl(): string | null {
  return currentService?.getApiBaseUrl() ?? null
}

/** The signed-in org for other Main subsystems (agent-tracking), or null when signed out.
 *  Main-only — never reaches the renderer. */
export function getPieAuthOrganizationId(): string | null {
  const status = currentService?.getStatus()
  return status?.state === 'signed_in' ? status.organizationId : null
}

export function initPieAuthServiceIfEnabled(
  deps: Omit<PieAuthServiceDeps, 'config'> & { config?: PieAuthConfig }
): PieAuthService | null {
  const config = deps.config ?? loadPieAuthConfig()
  const isDisabled = deps.isDisabled ?? (() => isSafeModeSubsystemDisabled('pie-auth'))
  if (!config.enabled || isDisabled()) {
    currentService = null
    return null
  }
  currentService = createPieAuthService({ ...deps, config })
  return currentService
}

export function stopPieAuthService(): void {
  currentService?.stop()
  currentService = null
}

/** Routes a pie://invite token to the auth service (logs in if needed, then joins
 *  the org). No-op when auth is not dev-gated on. */
export async function acceptPieInvite(inviteToken: string): Promise<void> {
  await currentService?.acceptInvite(inviteToken)
}
