/**
 * Process-wide safe-mode decision and read-only state. Safe mode boots the app
 * with risky subsystems disabled so a user can recover after a crash burst or
 * on demand. The state is decided once in Main during startup and is READ-ONLY
 * afterward: no IPC handler may mutate it, because a compromised renderer must
 * not be able to force subsystem security off.
 */

export type SafeModeSubsystem =
  | 'terminal-daemon'
  | 'agent-hooks'
  | 'agent-runtimes'
  | 'pie-runtime-handshake'
  | 'pie-realtime'
  | 'pie-auth'

export type SafeModeReason = 'crash-burst' | 'flag'

export type SafeModeState = {
  active: boolean
  reason: SafeModeReason | null
  disabledSubsystems: SafeModeSubsystem[]
}

// Subsystems safe mode actually gates today. agent-runtimes and
// pie-runtime-handshake launch on demand (not at startup) and are not yet
// guarded — tracked as a known gap in the desktop-lifecycle docs. pie-realtime
// checks isSafeModeSubsystemDisabled before connecting, so it is gated here.
export const SAFE_MODE_GATED_SUBSYSTEMS: readonly SafeModeSubsystem[] = [
  'terminal-daemon',
  'agent-hooks',
  'pie-realtime',
  // The login flow opens the system browser + network; gated so a crash-burst
  // recovery boot never auto-starts it (it checks before running).
  'pie-auth'
]

export const SAFE_MODE_CLI_FLAG = '--safe-mode'
export const SAFE_MODE_ENV_VAR = 'PIE_SAFE_MODE'

export function isSafeModeRequestedByFlag(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): boolean {
  return argv.includes(SAFE_MODE_CLI_FLAG) || env[SAFE_MODE_ENV_VAR] === '1'
}

/**
 * Pure decision: an explicit flag/env request wins over a crash burst so a user
 * can always force safe mode; both disable the same gated subsystems.
 */
export function decideSafeMode(input: {
  flagRequested: boolean
  burstDetected: boolean
}): SafeModeState {
  if (input.flagRequested) {
    return { active: true, reason: 'flag', disabledSubsystems: [...SAFE_MODE_GATED_SUBSYSTEMS] }
  }
  if (input.burstDetected) {
    return {
      active: true,
      reason: 'crash-burst',
      disabledSubsystems: [...SAFE_MODE_GATED_SUBSYSTEMS]
    }
  }
  return { active: false, reason: null, disabledSubsystems: [] }
}

const INACTIVE_SAFE_MODE_STATE: SafeModeState = {
  active: false,
  reason: null,
  disabledSubsystems: []
}

let currentSafeModeState: SafeModeState = INACTIVE_SAFE_MODE_STATE

export function initSafeModeState(state: SafeModeState): SafeModeState {
  currentSafeModeState = state
  return currentSafeModeState
}

export function getSafeModeState(): SafeModeState {
  return currentSafeModeState
}

export function isSafeModeSubsystemDisabled(subsystem: SafeModeSubsystem): boolean {
  return currentSafeModeState.disabledSubsystems.includes(subsystem)
}

export function __resetSafeModeStateForTests(): void {
  currentSafeModeState = INACTIVE_SAFE_MODE_STATE
}
