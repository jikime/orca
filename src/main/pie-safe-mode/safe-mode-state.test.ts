import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetSafeModeStateForTests,
  decideSafeMode,
  getSafeModeState,
  initSafeModeState,
  isSafeModeRequestedByFlag,
  isSafeModeSubsystemDisabled,
  SAFE_MODE_CLI_FLAG,
  SAFE_MODE_ENV_VAR,
  SAFE_MODE_GATED_SUBSYSTEMS
} from './safe-mode-state'

afterEach(() => {
  __resetSafeModeStateForTests()
})

describe('safe-mode decision', () => {
  it('is inactive when neither a flag nor a burst is present', () => {
    expect(decideSafeMode({ flagRequested: false, burstDetected: false })).toEqual({
      active: false,
      reason: null,
      disabledSubsystems: []
    })
  })

  it('activates for a crash burst and disables the gated subsystems', () => {
    const state = decideSafeMode({ flagRequested: false, burstDetected: true })
    expect(state.active).toBe(true)
    expect(state.reason).toBe('crash-burst')
    expect(state.disabledSubsystems).toEqual([...SAFE_MODE_GATED_SUBSYSTEMS])
  })

  it('lets an explicit flag win over a burst', () => {
    const state = decideSafeMode({ flagRequested: true, burstDetected: true })
    expect(state.reason).toBe('flag')
    expect(state.active).toBe(true)
  })
})

describe('safe-mode flag detection', () => {
  it('honors the CLI flag', () => {
    expect(isSafeModeRequestedByFlag(['node', 'app', SAFE_MODE_CLI_FLAG], {})).toBe(true)
  })

  it('honors the env var set to 1', () => {
    expect(isSafeModeRequestedByFlag([], { [SAFE_MODE_ENV_VAR]: '1' })).toBe(true)
    expect(isSafeModeRequestedByFlag([], { [SAFE_MODE_ENV_VAR]: '0' })).toBe(false)
    expect(isSafeModeRequestedByFlag([], {})).toBe(false)
  })
})

describe('safe-mode process state', () => {
  it('defaults to inactive with no disabled subsystems', () => {
    expect(getSafeModeState().active).toBe(false)
    expect(isSafeModeSubsystemDisabled('terminal-daemon')).toBe(false)
  })

  it('reflects an initialized active state', () => {
    initSafeModeState(decideSafeMode({ flagRequested: true, burstDetected: false }))
    expect(getSafeModeState().active).toBe(true)
    expect(isSafeModeSubsystemDisabled('terminal-daemon')).toBe(true)
    expect(isSafeModeSubsystemDisabled('agent-hooks')).toBe(true)
    // On-demand subsystems are not gated at startup today.
    expect(isSafeModeSubsystemDisabled('agent-runtimes')).toBe(false)
  })
})
