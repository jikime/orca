import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import {
  isExcludedDatabaseRelativePath,
  isExcludedSecretRelativePath,
  listExcludedDatabaseFiles,
  listExcludedSecretPrefixes,
  PIE_MIGRATION_BACKUPS_DIR
} from './pie-product-identity'
import {
  PIE_MIGRATION_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  ProfileSnapshotManifestSchema,
  type ProfileSnapshotManifest,
  type SnapshotManifestEntry
} from './pie-migration-report'
import type { OrcaInstallInventory } from './orca-install-detection'

const SNAPSHOT_MANIFEST_FILE = 'snapshot-manifest.json'
const SNAPSHOT_SOURCE_DIR = 'source'

export type SnapshotClock = {
  now: () => number
  runId: string
}

export type ProfileSnapshotResult = {
  runId: string
  snapshotDir: string
  manifestPath: string
  manifestRelativePath: string
  manifest: ProfileSnapshotManifest
}

function snapshotDirFor(userDataPath: string, runId: string): string {
  return join(userDataPath, PIE_MIGRATION_BACKUPS_DIR, runId)
}

function manifestPathFor(userDataPath: string, runId: string): string {
  return join(snapshotDirFor(userDataPath, runId), SNAPSHOT_MANIFEST_FILE)
}

/** A snapshot dir is complete only once its manifest exists; the manifest is
 *  written last, so a crash mid-snapshot leaves a dir that reads as incomplete. */
export function isSnapshotComplete(snapshotDir: string): boolean {
  return existsSync(join(snapshotDir, SNAPSHOT_MANIFEST_FILE))
}

function copyIntoSnapshot(
  sourceAbsolute: string,
  sourceRootDir: string,
  relativePath: string
): void {
  const target = join(sourceRootDir, relativePath)
  // Why: defend the backup dir even though ids are pre-validated — a target that
  // resolves outside the snapshot source root must never be written.
  const resolvedRoot = resolve(sourceRootDir)
  if (!resolve(target).startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error('snapshot_path_escape')
  }
  mkdirSync(dirname(target), { recursive: true })
  // Why: tmp+rename per file so a crash mid-copy cannot leave a truncated file
  // that later looks complete (house pattern from copyLegacyStateToProfile).
  const tmpTarget = `${target}.tmp`
  copyFileSync(sourceAbsolute, tmpTarget)
  renameSync(tmpTarget, target)
}

function collectExcludedEntries(userDataPath: string): SnapshotManifestEntry[] {
  const entries: SnapshotManifestEntry[] = []
  for (const prefix of listExcludedSecretPrefixes()) {
    if (existsSync(join(userDataPath, prefix))) {
      // Why: never walk or size secret stores; record the exclusion by path only
      // so a restored backup cannot reactivate revoked tokens (threat model P1).
      entries.push({ relativePath: prefix, action: 'excluded-secret', bytes: 0 })
    }
  }
  for (const dbFile of listExcludedDatabaseFiles()) {
    const absolute = join(userDataPath, dbFile)
    if (existsSync(absolute)) {
      entries.push({
        relativePath: dbFile,
        action: 'excluded-database',
        bytes: statSync(absolute).size
      })
    }
  }
  return entries
}

/**
 * Read-only backup of the detected profile data into
 * userData/pie/migration-backups/{runId}. Copies the index and per-profile data
 * files, records secret stores and the orchestration DB as excluded (never
 * copied), and writes the manifest LAST so an interrupted snapshot is
 * discardable. The clock/runId are injected for deterministic tests.
 */
export function createProfileSnapshot(options: {
  userDataPath: string
  inventory: OrcaInstallInventory
  clock: SnapshotClock
}): ProfileSnapshotResult {
  const { userDataPath, inventory, clock } = options
  const runId = clock.runId
  const snapshotDir = snapshotDirFor(userDataPath, runId)
  const sourceRootDir = join(snapshotDir, SNAPSHOT_SOURCE_DIR)
  mkdirSync(sourceRootDir, { recursive: true })

  const entries: SnapshotManifestEntry[] = []

  const copyRelative = (relativePath: string, bytes: number): void => {
    copyIntoSnapshot(join(userDataPath, relativePath), sourceRootDir, relativePath)
    entries.push({ relativePath, action: 'copied', bytes })
  }

  if (inventory.indexRelativePath && existsSync(join(userDataPath, inventory.indexRelativePath))) {
    copyRelative(
      inventory.indexRelativePath,
      statSync(join(userDataPath, inventory.indexRelativePath)).size
    )
  }

  for (const profile of inventory.profiles) {
    for (const file of profile.files) {
      // Why: an excluded-secret path could in principle appear in the profile set
      // (e.g. a stray *.enc); route it to exclusion rather than copying bytes.
      if (
        isExcludedSecretRelativePath(file.relativePath) ||
        isExcludedDatabaseRelativePath(file.relativePath)
      ) {
        entries.push({
          relativePath: file.relativePath,
          action: isExcludedSecretRelativePath(file.relativePath)
            ? 'excluded-secret'
            : 'excluded-database',
          bytes: 0
        })
        continue
      }
      if (file.exists) {
        copyRelative(file.relativePath, file.bytes)
      } else {
        entries.push({ relativePath: file.relativePath, action: 'missing', bytes: 0 })
      }
    }
  }

  entries.push(...collectExcludedEntries(userDataPath))

  const manifest: ProfileSnapshotManifest = ProfileSnapshotManifestSchema.parse({
    schemaVersion: PIE_MIGRATION_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    runId,
    createdAt: clock.now(),
    sourceInstall: inventory.kind,
    entries
  })

  const manifestPath = manifestPathFor(userDataPath, runId)
  // Written last: presence of the manifest is what marks the snapshot complete.
  writeSecureJsonFile(manifestPath, manifest)

  return {
    runId,
    snapshotDir,
    manifestPath,
    manifestRelativePath: relative(userDataPath, manifestPath),
    manifest
  }
}
