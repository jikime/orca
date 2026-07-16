import { describe, expect, it } from 'vitest'
import type { PieSessionState } from '../../shared/pie-session-contract'
import type { SafeModeState } from '../pie-safe-mode/safe-mode-state'
import {
  collectPieConnectionDiagnostics,
  type PieConnectionDiagnosticsSources,
  type PieDaemonLiveness
} from './pie-connection-diagnostics'

const INACTIVE_SAFE_MODE: SafeModeState = {
  active: false,
  reason: null,
  disabledSubsystems: []
}

function makeSources(overrides: {
  safeModeState?: SafeModeState
  sessionState?: { status: string; instanceId: string }
  encryptionAvailable?: boolean
  backend?: string
  daemonLiveness?: PieDaemonLiveness
  realtimeState?: 'disabled' | 'connected' | 'reconnecting'
  platform?: NodeJS.Platform
}): PieConnectionDiagnosticsSources {
  const sessionState = overrides.sessionState ?? {
    status: 'signed_out',
    instanceId: 'local-desktop'
  }
  return {
    safeModeState: overrides.safeModeState ?? INACTIVE_SAFE_MODE,
    sessionBroker: {
      getState: () => sessionState as unknown as PieSessionState
    },
    safeStorage: {
      isEncryptionAvailable: () => overrides.encryptionAvailable ?? true,
      ...(overrides.backend === undefined
        ? {}
        : { getSelectedStorageBackend: () => overrides.backend as string })
    },
    getDaemonLiveness: () => overrides.daemonLiveness ?? 'active',
    getRealtimeState: () => overrides.realtimeState ?? 'disabled',
    environment: {
      appVersion: '1.4.142',
      electronVersion: '38.0.0',
      platform: overrides.platform ?? 'darwin'
    },
    clock: { now: () => 1_700_000_000_000 }
  }
}

describe('collectPieConnectionDiagnostics', () => {
  it('emits the expected four-way shape with subsystems mocked', () => {
    const section = collectPieConnectionDiagnostics(makeSources({ daemonLiveness: 'active' }))
    expect(section.type).toBe('pie-connection-diagnostics')
    expect(section.schemaVersion).toBe(2)
    expect(section.collectedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(section.session).toEqual({ status: 'signed_out', instanceId: 'local-desktop' })
    expect(section.secureStorage).toEqual({ available: true, backend: 'keychain' })
    expect(section.daemon).toEqual({ liveness: 'active' })
    // Realtime defaults to disabled until the client is dev-gated on.
    expect(section.realtime).toEqual({ state: 'disabled' })
    // Runtime and Relay do not exist yet — reported honestly, not omitted.
    expect(section.runtime).toEqual({ status: 'not-configured' })
    expect(section.relay).toEqual({ status: 'not-configured' })
    expect(section.app).toEqual({
      version: '1.4.142',
      electronVersion: '38.0.0',
      platform: 'darwin'
    })
  })

  it('reflects an active safe-mode state', () => {
    const section = collectPieConnectionDiagnostics(
      makeSources({
        safeModeState: {
          active: true,
          reason: 'crash-burst',
          disabledSubsystems: ['terminal-daemon', 'agent-hooks']
        }
      })
    )
    expect(section.safeMode).toEqual({
      active: true,
      reason: 'crash-burst',
      disabledSubsystems: ['terminal-daemon', 'agent-hooks']
    })
  })

  it('reflects the realtime connection state', () => {
    const section = collectPieConnectionDiagnostics(makeSources({ realtimeState: 'connected' }))
    expect(section.realtime).toEqual({ state: 'connected' })
  })

  it('reports secure storage as unavailable without a trusted backend', () => {
    const section = collectPieConnectionDiagnostics(makeSources({ encryptionAvailable: false }))
    expect(section.secureStorage).toEqual({ available: false, reason: 'encryption-unavailable' })
  })

  it('redacts a secret-shaped value that reaches a status field', () => {
    const canary = `sk-ant-${'A'.repeat(48)}`
    const section = collectPieConnectionDiagnostics(
      makeSources({ sessionState: { status: 'signed_out', instanceId: canary } })
    )
    const serialized = JSON.stringify(section)
    expect(serialized.includes(canary)).toBe(false)
    expect(section.session.instanceId).toBe('[redacted:anthropic-key]')
  })
})
