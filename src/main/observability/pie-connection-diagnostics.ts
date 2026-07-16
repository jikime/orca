import type { DesktopSessionBroker } from '../pie-session/desktop-session-broker'
import {
  getPieSecureStorageAvailability,
  type PieSafeStorageLike,
  type PieSecureStorageAvailability
} from '../pie-session/safe-storage-availability'
import type {
  SafeModeReason,
  SafeModeState,
  SafeModeSubsystem
} from '../pie-safe-mode/safe-mode-state'
import { redactValue } from './redactor'

/**
 * Builds the Main/Renderer/Runtime/Relay connection-diagnostics section for the
 * error-tracking bundle. It gathers ONLY status-level fields that exist today —
 * never raw config, env, tokens, or session detail — constructs the object
 * field by field, then runs it through the existing server-mode redactor as a
 * belt-and-suspenders pass before it is emitted (16-desktop-lifecycle.md:123:
 * no raw tokens/secrets in a diagnostic bundle). Runtime and Relay do not exist
 * yet, so they report not-configured to keep the doc's 4-way shape from day one.
 */

export const PIE_CONNECTION_DIAGNOSTICS_SCHEMA_VERSION = 1

export type PieDaemonLiveness = 'active' | 'degraded' | 'not-started' | 'unknown'

export type PieConnectionDiagnosticsSection = {
  type: 'pie-connection-diagnostics'
  schemaVersion: number
  collectedAt: string
  safeMode: {
    active: boolean
    reason: SafeModeReason | null
    disabledSubsystems: SafeModeSubsystem[]
  }
  session: {
    status: string
    instanceId: string
  }
  secureStorage: PieSecureStorageAvailability
  daemon: { liveness: PieDaemonLiveness }
  runtime: { status: 'not-configured' }
  relay: { status: 'not-configured' }
  app: {
    version: string
    electronVersion: string
    platform: string
  }
}

export type PieConnectionDiagnosticsSources = {
  safeModeState: SafeModeState
  // Read-only; only status + instanceId are read, never session credentials.
  sessionBroker: Pick<DesktopSessionBroker, 'getState'>
  safeStorage: PieSafeStorageLike
  getDaemonLiveness: () => PieDaemonLiveness
  environment: {
    appVersion: string
    electronVersion: string
    platform: NodeJS.Platform
  }
  clock: { now: () => number }
}

export function collectPieConnectionDiagnostics(
  sources: PieConnectionDiagnosticsSources
): PieConnectionDiagnosticsSection {
  const sessionState = sources.sessionBroker.getState()
  const section: PieConnectionDiagnosticsSection = {
    type: 'pie-connection-diagnostics',
    schemaVersion: PIE_CONNECTION_DIAGNOSTICS_SCHEMA_VERSION,
    collectedAt: new Date(sources.clock.now()).toISOString(),
    safeMode: {
      active: sources.safeModeState.active,
      reason: sources.safeModeState.reason,
      disabledSubsystems: [...sources.safeModeState.disabledSubsystems]
    },
    session: {
      status: sessionState.status,
      instanceId: sessionState.instanceId
    },
    secureStorage: getPieSecureStorageAvailability(
      sources.safeStorage,
      sources.environment.platform
    ),
    daemon: { liveness: sources.getDaemonLiveness() },
    runtime: { status: 'not-configured' },
    relay: { status: 'not-configured' },
    app: {
      version: sources.environment.appVersion,
      electronVersion: sources.environment.electronVersion,
      platform: sources.environment.platform
    }
  }
  // Why: none of these keys are in the redactor blocklist, so the pass preserves
  // the section's shape and only scrubs any secret-shaped string value that
  // slipped into a status field before it reaches the user preview / upload.
  return redactValue(section, 'server') as PieConnectionDiagnosticsSection
}
