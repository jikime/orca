import { afterEach, describe, expect, it } from 'vitest'
import { deriveApiBaseUrl, loadPieRealtimeConfig } from './realtime-config'
import {
  __resetPieRealtimeForTests,
  getPieRealtimeStatus,
  resumePieRealtime,
  suspendPieRealtime,
  startPieRealtimeIfEnabled
} from './realtime-service'

afterEach(() => {
  __resetPieRealtimeForTests()
})

describe('pie realtime config', () => {
  it('is disabled without an explicit URL + org (no auto-connect)', () => {
    expect(loadPieRealtimeConfig({}).enabled).toBe(false)
    expect(
      loadPieRealtimeConfig({ PIE_REALTIME_URL: 'ws://localhost:8080/v1/realtime' }).enabled
    ).toBe(false)
  })

  it('is enabled with URL + org', () => {
    const config = loadPieRealtimeConfig({
      PIE_REALTIME_URL: 'ws://localhost:8080/v1/realtime',
      PIE_REALTIME_ORG_ID: '11111111-1111-4111-8111-111111111111'
    })
    expect(config.enabled).toBe(true)
    expect(config.instanceId).toBe('pie-desktop-dev')
  })

  it('derives the REST origin from the WS URL', () => {
    expect(deriveApiBaseUrl('ws://localhost:8080/v1/realtime')).toBe('http://localhost:8080')
    expect(deriveApiBaseUrl('wss://api.example.com/v1/realtime')).toBe('https://api.example.com')
  })
})

describe('startPieRealtimeIfEnabled gates', () => {
  it('does nothing when the env gate is off', () => {
    const connection = startPieRealtimeIfEnabled({ env: {} })
    expect(connection).toBeNull()
    expect(getPieRealtimeStatus().state).toBe('disabled')
  })

  it('does nothing when safe mode disables the subsystem', () => {
    const connection = startPieRealtimeIfEnabled({
      env: {
        PIE_REALTIME_URL: 'ws://localhost:8080/v1/realtime',
        PIE_REALTIME_ORG_ID: '11111111-1111-4111-8111-111111111111'
      },
      isDisabled: () => true
    })
    expect(connection).toBeNull()
    expect(getPieRealtimeStatus().state).toBe('disabled')
  })

  it('suspends on logout and reconnects with retained config after login', () => {
    let opened = 0
    let closed = 0
    startPieRealtimeIfEnabled({
      env: {
        PIE_REALTIME_URL: 'ws://localhost:8080/v1/realtime',
        PIE_REALTIME_ORG_ID: '11111111-1111-4111-8111-111111111111'
      },
      getAccessToken: () => 'token',
      connectionOverrides: {
        socketFactory: () => {
          opened += 1
          return { send: () => {}, close: () => void (closed += 1) }
        }
      }
    })
    expect(opened).toBe(1)
    suspendPieRealtime()
    expect(closed).toBe(1)
    expect(getPieRealtimeStatus().state).toBe('stopped')
    resumePieRealtime()
    expect(opened).toBe(2)
    expect(getPieRealtimeStatus().state).toBe('connecting')
  })
})
