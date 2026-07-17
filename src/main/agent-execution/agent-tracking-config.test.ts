import { describe, expect, it } from 'vitest'
import { loadPieAgentTrackingConfig, resolveAgentOutboxPath } from './agent-tracking-config'

describe('loadPieAgentTrackingConfig', () => {
  it('is disabled by default (flag unset) so normal Orca use is unaffected', () => {
    expect(loadPieAgentTrackingConfig({}).enabled).toBe(false)
  })

  it('is disabled for any value other than "1"', () => {
    expect(loadPieAgentTrackingConfig({ PIE_AGENT_TRACKING: 'true' }).enabled).toBe(false)
    expect(loadPieAgentTrackingConfig({ PIE_AGENT_TRACKING: '0' }).enabled).toBe(false)
  })

  it('is enabled only with PIE_AGENT_TRACKING=1', () => {
    const config = loadPieAgentTrackingConfig({ PIE_AGENT_TRACKING: '1' })
    expect(config.enabled).toBe(true)
    expect(config.pumpIntervalMs).toBeGreaterThan(0)
    expect(config.scanIntervalMs).toBeGreaterThan(0)
    expect(config.contextTtlMs).toBeGreaterThan(0)
  })

  it('reads positive integer overrides and ignores invalid ones', () => {
    const config = loadPieAgentTrackingConfig({
      PIE_AGENT_TRACKING: '1',
      PIE_AGENT_TRACKING_PUMP_MS: '2500',
      PIE_AGENT_TRACKING_SCAN_MS: 'not-a-number'
    })
    expect(config.pumpIntervalMs).toBe(2500)
    // Invalid override falls back to the default (a positive number).
    expect(config.scanIntervalMs).toBeGreaterThan(0)
  })
})

describe('resolveAgentOutboxPath', () => {
  it('derives the outbox path under the user-data dir via path utils (cross-platform)', () => {
    const path = resolveAgentOutboxPath('/home/u/.config/orca')
    expect(path).toContain('agent-events.db')
    expect(path).toContain('pie')
    expect(path).toContain('agent-outbox')
  })
})
