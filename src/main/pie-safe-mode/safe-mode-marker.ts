import { existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Persisted crash-burst marker for safe mode. Counts consecutive startups that
 * failed to reach "ready" so that after a burst the next launch can boot with
 * subsystems disabled. Modeled on startup/gpu-fallback-marker.ts: a tiny
 * schema-versioned JSON file in userData, sticky only for the build that
 * observed the burst (an app/Electron version bump clears it and gets a fresh
 * attempt), cleared on a healthy startup. Paths/clock are injected for tests.
 */

export const SAFE_MODE_MARKER_FILE = 'safe-mode.json'
export const SAFE_MODE_MARKER_SCHEMA_VERSION = 1
export const DEFAULT_SAFE_MODE_CRASH_BURST_THRESHOLD = 3

export type SafeModeEnvironment = {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type SafeModeMarker = {
  schemaVersion: number
  failedStartups: number
  updatedAt: number
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
}

export type SafeModeMarkerClock = {
  now: () => number
}

function markerPath(userDataPath: string): string {
  return join(userDataPath, SAFE_MODE_MARKER_FILE)
}

export function readSafeModeMarker(userDataPath: string): SafeModeMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(userDataPath), 'utf-8')) as Partial<
      Record<keyof SafeModeMarker, unknown>
    >
    if (parsed.schemaVersion !== SAFE_MODE_MARKER_SCHEMA_VERSION) {
      return null
    }
    if (
      typeof parsed.failedStartups !== 'number' ||
      !Number.isInteger(parsed.failedStartups) ||
      parsed.failedStartups < 0 ||
      typeof parsed.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt) ||
      typeof parsed.appVersion !== 'string' ||
      typeof parsed.electronVersion !== 'string' ||
      typeof parsed.platform !== 'string'
    ) {
      return null
    }
    return {
      schemaVersion: SAFE_MODE_MARKER_SCHEMA_VERSION,
      failedStartups: parsed.failedStartups,
      updatedAt: parsed.updatedAt,
      appVersion: parsed.appVersion,
      electronVersion: parsed.electronVersion,
      platform: parsed.platform as NodeJS.Platform
    }
  } catch {
    // Missing or corrupt marker means no recorded burst.
  }
  return null
}

export function clearSafeModeMarker(userDataPath: string): void {
  try {
    rmSync(markerPath(userDataPath), { force: true })
  } catch {
    // Best effort; a stale marker is revalidated on the next launch.
  }
}

/** Returns the marker only when it belongs to the current build; a version bump
 *  clears it so an upgrade always gets one fresh hardware/software attempt. */
export function readActiveSafeModeMarker(
  userDataPath: string,
  environment: SafeModeEnvironment
): SafeModeMarker | null {
  const marker = readSafeModeMarker(userDataPath)
  if (!marker) {
    if (existsSync(markerPath(userDataPath))) {
      clearSafeModeMarker(userDataPath)
    }
    return null
  }
  if (
    marker.appVersion !== environment.appVersion ||
    marker.electronVersion !== environment.electronVersion ||
    marker.platform !== environment.platform
  ) {
    clearSafeModeMarker(userDataPath)
    return null
  }
  return marker
}

function writeSafeModeMarker(userDataPath: string, marker: SafeModeMarker): void {
  const target = markerPath(userDataPath)
  mkdirSync(dirname(target), { recursive: true })
  // Why: this counter is written while the app may be crash-looping; a torn
  // write would reset it to 0 and defeat burst detection, so write atomically.
  const tmpPath = `${target}.tmp`
  writeFileSync(tmpPath, JSON.stringify(marker), 'utf-8')
  renameSync(tmpPath, target)
}

/**
 * Records that a startup attempt has begun and returns the number of PRIOR
 * consecutive failed startups (before this attempt). The caller decides safe
 * mode from that count, then this attempt is remembered as failed until
 * markSafeModeStartupHealthy clears it once the app reaches ready.
 */
export function beginSafeModeStartupAttempt(options: {
  userDataPath: string
  environment: SafeModeEnvironment
  clock: SafeModeMarkerClock
}): number {
  const { userDataPath, environment, clock } = options
  const priorFailedStartups =
    readActiveSafeModeMarker(userDataPath, environment)?.failedStartups ?? 0
  writeSafeModeMarker(userDataPath, {
    schemaVersion: SAFE_MODE_MARKER_SCHEMA_VERSION,
    failedStartups: priorFailedStartups + 1,
    updatedAt: clock.now(),
    appVersion: environment.appVersion,
    electronVersion: environment.electronVersion,
    platform: environment.platform
  })
  return priorFailedStartups
}

/** Clears the burst counter once the app has started cleanly (window shown and
 *  no crash within the grace period). */
export function markSafeModeStartupHealthy(userDataPath: string): void {
  clearSafeModeMarker(userDataPath)
}

export function shouldEnterSafeModeFromBurst(
  priorFailedStartups: number,
  threshold: number = DEFAULT_SAFE_MODE_CRASH_BURST_THRESHOLD
): boolean {
  return priorFailedStartups >= threshold
}
