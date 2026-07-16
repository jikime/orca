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
