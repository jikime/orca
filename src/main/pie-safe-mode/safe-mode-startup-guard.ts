import { isSafeModeSubsystemDisabled, type SafeModeSubsystem } from './safe-mode-state'

export type SafeModeGuardDeps = {
  isDisabled: (subsystem: SafeModeSubsystem) => boolean
  log: (message: string) => void
}

const defaultDeps: SafeModeGuardDeps = {
  isDisabled: isSafeModeSubsystemDisabled,
  log: (message) => console.warn(message)
}

/**
 * Wraps a startup-service launcher so it becomes a no-op when safe mode has
 * disabled its subsystem. Additive by design: existing wiring keeps calling the
 * same async start function; in safe mode it resolves immediately without
 * launching, so a crash-looping subsystem cannot re-run on the recovery boot.
 */
export function guardStartupService<Args extends unknown[]>(
  subsystem: SafeModeSubsystem,
  start: (...args: Args) => Promise<void>,
  deps: SafeModeGuardDeps = defaultDeps
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    if (deps.isDisabled(subsystem)) {
      deps.log(`[safe-mode] skipping ${subsystem} startup`)
      return
    }
    await start(...args)
  }
}
