import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import { readProfileIndexFile } from '../orca-profiles/profile-index-store'
import {
  getOrcaProfileBrowserSessionMetaFile,
  getOrcaProfileDataFile,
  getOrcaProfileIndexPath,
  isValidOrcaProfileId,
  LEGACY_BACKUP_COUNT,
  legacyBackupPath,
  legacyBrowserSessionMetaPath,
  legacyDataFilePath,
  profileBackupPath
} from '../orca-profiles/profile-storage-paths'
import type { OrcaInstallKind } from './pie-migration-report'

export type OrcaInstallFileRole = 'data' | 'browser-session-meta' | 'data-backup'

export type OrcaInstallFileEntry = {
  role: OrcaInstallFileRole
  relativePath: string
  exists: boolean
  bytes: number
}

export type OrcaInstallProfileInventory = {
  profileId: string
  files: OrcaInstallFileEntry[]
  // Top-level orca-data.json schemaVersion, or 'unversioned' when the file has
  // no numeric version field (or is absent/unparseable).
  schemaVersion: number | 'unversioned'
}

export type OrcaInstallIndexState = 'absent' | 'current' | 'backup' | 'corrupt'

export type OrcaInstallInventory = {
  kind: OrcaInstallKind
  indexRelativePath: string | null
  indexState: OrcaInstallIndexState
  profiles: OrcaInstallProfileInventory[]
}

function toRelative(userDataPath: string, absolutePath: string): string {
  return relative(userDataPath, absolutePath)
}

function fileEntry(
  userDataPath: string,
  role: OrcaInstallFileRole,
  absolutePath: string
): OrcaInstallFileEntry {
  const relativePath = toRelative(userDataPath, absolutePath)
  if (!existsSync(absolutePath)) {
    return { role, relativePath, exists: false, bytes: 0 }
  }
  try {
    return { role, relativePath, exists: true, bytes: statSync(absolutePath).size }
  } catch {
    return { role, relativePath, exists: false, bytes: 0 }
  }
}

// Why: reads only the top-level schemaVersion integer for diagnostics; the rest
// of the file (which may hold user data) is never surfaced.
function readDataFileSchemaVersion(absoluteDataFile: string): number | 'unversioned' {
  if (!existsSync(absoluteDataFile)) {
    return 'unversioned'
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(absoluteDataFile, 'utf-8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { schemaVersion?: unknown }).schemaVersion === 'number'
    ) {
      return (parsed as { schemaVersion: number }).schemaVersion
    }
  } catch {
    // Fall through: a torn/corrupt data file is reported as unversioned.
  }
  return 'unversioned'
}

function inventoryProfileFiles(
  userDataPath: string,
  dataFile: string,
  browserSessionMeta: string,
  backupPathFor: (index: number) => string
): OrcaInstallFileEntry[] {
  const entries: OrcaInstallFileEntry[] = [
    fileEntry(userDataPath, 'data', dataFile),
    fileEntry(userDataPath, 'browser-session-meta', browserSessionMeta)
  ]
  for (let index = 0; index < LEGACY_BACKUP_COUNT; index++) {
    entries.push(fileEntry(userDataPath, 'data-backup', backupPathFor(index)))
  }
  return entries
}

function detectLegacySingleProfile(userDataPath: string): OrcaInstallProfileInventory {
  const dataFile = legacyDataFilePath(userDataPath)
  return {
    // Why: legacy root state migrates into the default profile, mirroring
    // copyLegacyStateToProfile; the id anchors that target mapping.
    profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
    files: inventoryProfileFiles(
      userDataPath,
      dataFile,
      legacyBrowserSessionMetaPath(userDataPath),
      (index) => legacyBackupPath(userDataPath, index)
    ),
    schemaVersion: readDataFileSchemaVersion(dataFile)
  }
}

function detectMultiProfile(
  userDataPath: string,
  profileIds: string[]
): OrcaInstallProfileInventory[] {
  return profileIds.map((profileId) => {
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    return {
      profileId,
      files: inventoryProfileFiles(
        userDataPath,
        dataFile,
        getOrcaProfileBrowserSessionMetaFile(profileId, userDataPath),
        (index) => profileBackupPath(dataFile, index)
      ),
      schemaVersion: readDataFileSchemaVersion(dataFile)
    }
  })
}

// Why: reads the current index then the .bak fallback (the store's recovery
// order) and reports which one satisfied it, so a healthy index is told apart
// from one recovered off backup or a fully corrupt pair.
function readIndexWithState(indexPath: string): {
  index: ReturnType<typeof readProfileIndexFile>
  state: OrcaInstallIndexState
} {
  const current = readProfileIndexFile(indexPath)
  if (current) {
    return { index: current, state: 'current' }
  }
  const backup = readProfileIndexFile(`${indexPath}.bak`)
  if (backup) {
    return { index: backup, state: 'backup' }
  }
  return { index: null, state: 'corrupt' }
}

/**
 * Read-only detection of an existing Orca install under `userDataPath`. Injected
 * path keeps this testable and SSH/remote-safe. Returns 'none' for a fresh
 * install, 'legacy-single-profile' for pre-multi-profile root state, or
 * 'multi-profile' when a profile index is present.
 */
export function detectOrcaInstall(userDataPath: string): OrcaInstallInventory {
  const indexPath = getOrcaProfileIndexPath(userDataPath)
  if (existsSync(indexPath)) {
    const { index, state } = readIndexWithState(indexPath)
    // Why: only ids the store already validated become path segments; a tampered
    // id is dropped by normalization, so it can never reach a filesystem join.
    const profileIds = (index?.profiles ?? [])
      .map((profile) => profile.id)
      .filter((id) => isValidOrcaProfileId(id))
    return {
      kind: 'multi-profile',
      indexRelativePath: toRelative(userDataPath, indexPath),
      indexState: state,
      profiles: detectMultiProfile(userDataPath, profileIds)
    }
  }

  if (existsSync(legacyDataFilePath(userDataPath))) {
    return {
      kind: 'legacy-single-profile',
      indexRelativePath: null,
      indexState: 'absent',
      profiles: [detectLegacySingleProfile(userDataPath)]
    }
  }

  return {
    kind: 'none',
    indexRelativePath: null,
    indexState: 'absent',
    profiles: []
  }
}
