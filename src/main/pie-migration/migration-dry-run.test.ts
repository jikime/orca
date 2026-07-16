import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runPieMigrationDryRun } from './migration-dry-run'
import { PieMigrationDryRunReportSchema } from './pie-migration-report'

const TOKEN_CANARY = 'ghp_CANARY_TOKEN_must_not_appear_in_any_report'

let userDataPath = ''

function write(relativePath: string, contents: string): void {
  const absolute = join(userDataPath, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf-8')
}

function profileSummary(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3
  }
}

function profileDataPath(id: string): string {
  return join('profiles', id, 'orca-data.json')
}

function targetPath(relativePath: string): string {
  return join('pie', 'migration-target', relativePath)
}

// Builds a tree that exercises every planned action:
// index (no target) + local-create → create, local-merge → merge,
// local-conflict → conflict, local-missing → missing, terminal-history → sensitive.
function writeMixedFixture(): void {
  const ids = ['local-create', 'local-merge', 'local-conflict', 'local-missing']
  write(
    'orca-profile-index.json',
    JSON.stringify({ schemaVersion: 1, activeProfileId: ids[0], profiles: ids.map(profileSummary) })
  )
  write(profileDataPath('local-create'), '{"schemaVersion":1,"which":"create"}')

  write(profileDataPath('local-merge'), '{"schemaVersion":1,"which":"merge"}')
  write(targetPath(profileDataPath('local-merge')), '{"schemaVersion":1,"which":"merge"}')

  write(profileDataPath('local-conflict'), '{"schemaVersion":1,"which":"source"}')
  write(targetPath(profileDataPath('local-conflict')), '{"schemaVersion":1,"which":"target"}')

  // local-missing is listed in the index but has no data file on disk.
  write(join('terminal-history', 'session-1.log'), 'ls -la')
}

const clock = { now: () => 1_700_000_000_000, runId: 'run-alpha' }

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'pie-migration-dryrun-'))
})

afterEach(() => {
  rmSync(userDataPath, { force: true, recursive: true })
})

describe('runPieMigrationDryRun', () => {
  it('returns an empty report for a fresh install', () => {
    const { report } = runPieMigrationDryRun({ userDataPath, clock })
    expect(report.sourceInstall).toBe('none')
    expect(report.items).toEqual([])
    expect(report.counts).toEqual({ create: 0, merge: 0, conflict: 0, missing: 0, sensitive: 0 })
    expect(report.snapshot).toBeNull()
  })

  it('classifies every planned action with correct counts', () => {
    writeMixedFixture()
    const { report } = runPieMigrationDryRun({ userDataPath, clock })

    expect(report.sourceInstall).toBe('multi-profile')
    expect(report.counts).toEqual({
      create: 2,
      merge: 1,
      conflict: 1,
      missing: 1,
      sensitive: 1
    })
    expect(PieMigrationDryRunReportSchema.safeParse(report).success).toBe(true)

    const actionByPath = new Map(
      report.items.map((item) => [item.relativePath, item.plannedAction])
    )
    expect(actionByPath.get('orca-profile-index.json')).toBe('create')
    expect(actionByPath.get(profileDataPath('local-merge'))).toBe('merge')
    expect(actionByPath.get(profileDataPath('local-conflict'))).toBe('conflict')
    expect(actionByPath.get(profileDataPath('local-missing'))).toBe('missing')
    expect(actionByPath.get('terminal-history')).toBe('sensitive-device-only')
  })

  it('is idempotent apart from runId and timestamp', () => {
    writeMixedFixture()
    const first = runPieMigrationDryRun({ userDataPath, clock: { now: () => 1, runId: 'run-1' } })
    const second = runPieMigrationDryRun({ userDataPath, clock: { now: () => 2, runId: 'run-2' } })

    const normalize = (report: typeof first.report): unknown => ({
      ...report,
      runId: 'x',
      createdAt: 0
    })
    expect(normalize(first.report)).toEqual(normalize(second.report))
  })

  it('never writes token contents into the report or the snapshot manifest', () => {
    writeMixedFixture()
    write(
      profileDataPath('local-create'),
      JSON.stringify({ schemaVersion: 1, secret: TOKEN_CANARY })
    )

    const { report, reportPath, snapshot } = runPieMigrationDryRun({
      userDataPath,
      clock,
      createSnapshot: true
    })

    expect(JSON.stringify(report).includes(TOKEN_CANARY)).toBe(false)
    expect(readFileSync(reportPath, 'utf-8').includes(TOKEN_CANARY)).toBe(false)
    expect(snapshot).not.toBeNull()
    expect(readFileSync(snapshot!.manifestPath, 'utf-8').includes(TOKEN_CANARY)).toBe(false)
    expect(report.snapshot?.runId).toBe(snapshot!.runId)
  })
})
