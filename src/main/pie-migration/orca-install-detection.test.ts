import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectOrcaInstall } from './orca-install-detection'

let userDataPath = ''

type ProfileSummaryLike = {
  id: string
  name?: string
  kind?: string
}

function profileSummary(profile: ProfileSummaryLike): Record<string, unknown> {
  return {
    id: profile.id,
    name: profile.name ?? profile.id,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: profile.kind ?? 'local',
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3
  }
}

function writeJson(relativePath: string, value: unknown): void {
  const absolute = join(userDataPath, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, JSON.stringify(value), 'utf-8')
}

function writeProfileData(profileId: string, value: unknown): void {
  writeJson(join('profiles', profileId, 'orca-data.json'), value)
}

function writeIndex(profiles: ProfileSummaryLike[], fileName = 'orca-profile-index.json'): void {
  writeJson(fileName, {
    schemaVersion: 1,
    activeProfileId: profiles[0]?.id ?? 'local-default',
    profiles: profiles.map(profileSummary)
  })
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'pie-migration-detect-'))
})

afterEach(() => {
  rmSync(userDataPath, { force: true, recursive: true })
})

describe('detectOrcaInstall', () => {
  it('reports none for a fresh install', () => {
    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.kind).toBe('none')
    expect(inventory.profiles).toEqual([])
    expect(inventory.indexState).toBe('absent')
  })

  it('detects a legacy single-profile install from root state', () => {
    writeJson('orca-data.json', { schemaVersion: 7, settings: {} })

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.kind).toBe('legacy-single-profile')
    expect(inventory.profiles).toHaveLength(1)
    const profile = inventory.profiles[0]
    expect(profile.profileId).toBe('local-default')
    expect(profile.schemaVersion).toBe(7)
    const dataFile = profile.files.find((file) => file.role === 'data')
    expect(dataFile?.relativePath).toBe('orca-data.json')
    expect(dataFile?.exists).toBe(true)
  })

  it('records an unversioned data file when no numeric schemaVersion exists', () => {
    writeJson('orca-data.json', { settings: {} })
    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.profiles[0].schemaVersion).toBe('unversioned')
  })

  it('detects a multi-profile install and inventories each profile', () => {
    writeIndex([{ id: 'local-default' }, { id: 'local-second' }])
    writeProfileData('local-default', { schemaVersion: 1 })

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.kind).toBe('multi-profile')
    expect(inventory.indexState).toBe('current')
    expect(inventory.profiles.map((profile) => profile.profileId)).toEqual([
      'local-default',
      'local-second'
    ])
    const second = inventory.profiles.find((profile) => profile.profileId === 'local-second')
    expect(second?.files.find((file) => file.role === 'data')?.exists).toBe(false)
  })

  it('falls back to the index backup when the current index is corrupt', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), '{ not json', 'utf-8')
    writeIndex([{ id: 'local-default' }], 'orca-profile-index.json.bak')

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.kind).toBe('multi-profile')
    expect(inventory.indexState).toBe('backup')
    expect(inventory.profiles.map((profile) => profile.profileId)).toEqual(['local-default'])
  })

  it('reports a corrupt index with no recoverable profiles', () => {
    writeFileSync(join(userDataPath, 'orca-profile-index.json'), 'not json at all', 'utf-8')

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.kind).toBe('multi-profile')
    expect(inventory.indexState).toBe('corrupt')
    expect(inventory.profiles).toEqual([])
  })

  it('drops a hostile profile id so it can never become a path segment', () => {
    writeIndex([{ id: 'local-default' }, { id: '../escape' }])

    const inventory = detectOrcaInstall(userDataPath)
    expect(inventory.profiles.map((profile) => profile.profileId)).toEqual(['local-default'])
  })
})
