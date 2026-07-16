import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectOrcaInstall } from './orca-install-detection'
import { createProfileSnapshot, isSnapshotComplete } from './profile-snapshot'
import { ProfileSnapshotManifestSchema } from './pie-migration-report'

const SECRET_CANARY = 'refresh-token-CANARY-should-never-be-copied'

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

function writeIndex(ids: string[]): void {
  write(
    'orca-profile-index.json',
    JSON.stringify({ schemaVersion: 1, activeProfileId: ids[0], profiles: ids.map(profileSummary) })
  )
}

function listFilesRecursively(directory: string): string[] {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

const clock = { now: () => 1_700_000_000_000, runId: 'run-fixed-0001' }

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'pie-migration-snapshot-'))
})

afterEach(() => {
  rmSync(userDataPath, { force: true, recursive: true })
})

describe('createProfileSnapshot', () => {
  it('copies profile data while excluding secret stores and the database', () => {
    writeIndex(['local-default'])
    write(join('profiles', 'local-default', 'orca-data.json'), '{"schemaVersion":1}')
    write(join('profiles', 'local-default', 'browser-session-meta.json'), '{}')
    // Secret stores and DB that must never be copied.
    write(
      join('pie', 'session-secrets', 'inst', 'prof', 'acct', 'refresh-token.json.enc'),
      SECRET_CANARY
    )
    write('orchestration.db', 'sqlite-bytes')

    const inventory = detectOrcaInstall(userDataPath)
    const result = createProfileSnapshot({ userDataPath, inventory, clock })

    const backupsRoot = join(userDataPath, 'pie', 'migration-backups')
    for (const file of listFilesRecursively(backupsRoot)) {
      expect(readFileSync(file, 'utf-8').includes(SECRET_CANARY)).toBe(false)
    }

    const actionsByPath = new Map(
      result.manifest.entries.map((entry) => [entry.relativePath, entry.action])
    )
    expect(actionsByPath.get(join('profiles', 'local-default', 'orca-data.json'))).toBe('copied')
    expect(actionsByPath.get(join('pie', 'session-secrets'))).toBe('excluded-secret')
    expect(actionsByPath.get('orchestration.db')).toBe('excluded-database')
    // The excluded secret file was never written under the backup tree.
    expect(
      existsSync(join(backupsRoot, 'run-fixed-0001', 'source', 'pie', 'session-secrets'))
    ).toBe(false)
    expect(ProfileSnapshotManifestSchema.safeParse(result.manifest).success).toBe(true)
  })

  it('records a missing expected data file instead of copying it', () => {
    writeIndex(['local-default', 'local-empty'])
    write(join('profiles', 'local-default', 'orca-data.json'), '{"schemaVersion":1}')

    const inventory = detectOrcaInstall(userDataPath)
    const result = createProfileSnapshot({ userDataPath, inventory, clock })

    const missing = result.manifest.entries.find(
      (entry) => entry.relativePath === join('profiles', 'local-empty', 'orca-data.json')
    )
    expect(missing?.action).toBe('missing')
  })

  it('treats a snapshot without a manifest as incomplete (crash mid-snapshot)', () => {
    writeIndex(['local-default'])
    write(join('profiles', 'local-default', 'orca-data.json'), '{"schemaVersion":1}')

    const inventory = detectOrcaInstall(userDataPath)
    const result = createProfileSnapshot({ userDataPath, inventory, clock })
    expect(isSnapshotComplete(result.snapshotDir)).toBe(true)

    rmSync(result.manifestPath, { force: true })
    expect(isSnapshotComplete(result.snapshotDir)).toBe(false)
  })

  it('does not let a hostile index id escape the backup directory', () => {
    // The hostile id is dropped by detection, so it never reaches a path join.
    write(
      'orca-profile-index.json',
      JSON.stringify({
        schemaVersion: 1,
        activeProfileId: 'local-default',
        profiles: [profileSummary('local-default'), profileSummary('../../escape')]
      })
    )
    write(join('profiles', 'local-default', 'orca-data.json'), '{"schemaVersion":1}')

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.profiles.map((profile) => profile.profileId)).toEqual(['local-default'])

    createProfileSnapshot({ userDataPath, inventory, clock })
    // Nothing named "escape" was written outside the userData sandbox.
    expect(existsSync(join(userDataPath, '..', 'escape'))).toBe(false)
    expect(existsSync(join(userDataPath, '..', '..', 'escape'))).toBe(false)
  })
})
