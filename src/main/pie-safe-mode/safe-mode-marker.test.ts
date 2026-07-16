import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginSafeModeStartupAttempt,
  DEFAULT_SAFE_MODE_CRASH_BURST_THRESHOLD,
  markSafeModeStartupHealthy,
  readActiveSafeModeMarker,
  readSafeModeMarker,
  SAFE_MODE_MARKER_FILE,
  shouldEnterSafeModeFromBurst,
  type SafeModeEnvironment
} from './safe-mode-marker'

let userDataPath = ''
let clockValue = 0
const clock = { now: () => clockValue }

const environment: SafeModeEnvironment = {
  appVersion: '1.4.142',
  electronVersion: '38.0.0',
  platform: 'darwin'
}

function attempt(env: SafeModeEnvironment = environment): number {
  return beginSafeModeStartupAttempt({ userDataPath, environment: env, clock })
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'pie-safe-mode-marker-'))
  clockValue = 1_700_000_000_000
})

afterEach(() => {
  rmSync(userDataPath, { force: true, recursive: true })
})

describe('safe-mode marker', () => {
  it('starts a fresh install at zero prior failures and records the attempt', () => {
    expect(attempt()).toBe(0)
    const marker = readSafeModeMarker(userDataPath)
    expect(marker?.failedStartups).toBe(1)
    expect(marker?.appVersion).toBe('1.4.142')
  })

  it('counts consecutive unhealthy startups', () => {
    expect(attempt()).toBe(0)
    expect(attempt()).toBe(1)
    expect(attempt()).toBe(2)
    expect(readSafeModeMarker(userDataPath)?.failedStartups).toBe(3)
  })

  it('enters safe mode only once the burst threshold is reached', () => {
    expect(shouldEnterSafeModeFromBurst(DEFAULT_SAFE_MODE_CRASH_BURST_THRESHOLD - 1)).toBe(false)
    expect(shouldEnterSafeModeFromBurst(DEFAULT_SAFE_MODE_CRASH_BURST_THRESHOLD)).toBe(true)
    // Three failed startups → the fourth launch reads prior=3 and enters safe mode.
    attempt()
    attempt()
    const priorOnFourthLaunch = attempt()
    expect(shouldEnterSafeModeFromBurst(priorOnFourthLaunch)).toBe(false)
    expect(shouldEnterSafeModeFromBurst(attempt())).toBe(true)
  })

  it('clears the counter on a healthy startup', () => {
    attempt()
    attempt()
    markSafeModeStartupHealthy(userDataPath)
    expect(readSafeModeMarker(userDataPath)).toBeNull()
    expect(attempt()).toBe(0)
  })

  it('resets the counter when the build changes (version bump)', () => {
    attempt()
    attempt()
    const upgraded: SafeModeEnvironment = { ...environment, appVersion: '1.5.0' }
    expect(readActiveSafeModeMarker(userDataPath, upgraded)).toBeNull()
    expect(attempt(upgraded)).toBe(0)
  })

  it('treats a corrupt marker as no recorded burst', () => {
    writeFileSync(join(userDataPath, SAFE_MODE_MARKER_FILE), '{ not json', 'utf-8')
    expect(readSafeModeMarker(userDataPath)).toBeNull()
    expect(attempt()).toBe(0)
  })

  it('writes the marker atomically, leaving no temp file behind', () => {
    attempt()
    const leftovers = readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
    // The persisted marker is valid JSON.
    expect(() =>
      JSON.parse(readFileSync(join(userDataPath, SAFE_MODE_MARKER_FILE), 'utf-8'))
    ).not.toThrow()
    expect(existsSync(join(userDataPath, SAFE_MODE_MARKER_FILE))).toBe(true)
  })
})
