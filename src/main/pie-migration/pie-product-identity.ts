import { join } from 'node:path'

/**
 * Central identity contract for the Orca to Pie naming migration. Filesystem
 * paths, CLI names, protocol schemes and env prefixes derive from these STABLE
 * ids, never from the display names, so a display-name change cannot silently
 * rename user data (Pie naming-migration 코드 구조 원칙). This is the single
 * place migration code reads product identity from.
 */
export const LEGACY_PRODUCT_ID = 'orca'
export const PIE_PRODUCT_ID = 'pie'
export const LEGACY_PRODUCT_DISPLAY_NAME = 'Orca'
export const PIE_PRODUCT_DISPLAY_NAME = 'Pie'

// Root of Pie-owned state inside userData. A stable id, not derived from the
// display name; the existing orca-* data directory naming is left untouched.
export const PIE_STATE_DIR = PIE_PRODUCT_ID

export const PIE_MIGRATION_BACKUPS_DIR = join(PIE_STATE_DIR, 'migration-backups')
export const PIE_MIGRATION_REPORTS_DIR = join(PIE_STATE_DIR, 'migration-reports')

/**
 * Provisional projected target for the future profile path move. R1 is dry-run
 * only and writes NOTHING here; the concrete final data path is a pending N4
 * decision. The projection exists solely so the dry-run can classify each item
 * as create/merge/conflict against a stable target without moving any data.
 */
export const PIE_MIGRATION_TARGET_DIR = join(PIE_STATE_DIR, 'migration-target')

export function pieMigrationTargetRelativePath(sourceRelativePath: string): string {
  return join(PIE_MIGRATION_TARGET_DIR, sourceRelativePath)
}

// Encrypted credential stores that must never be copied into a snapshot: a
// restored backup must not reactivate revoked tokens (threat model P1 Backup).
// The snapshot records these as excluded-secret instead of copying their bytes.
const EXCLUDED_SECRET_PREFIXES = [
  join(PIE_STATE_DIR, 'session-secrets'),
  'claude-runtime-auth',
  'claude-accounts',
  'codex-accounts'
]

// SQLite state whose WAL-consistent snapshot is out of scope for R1; recorded as
// excluded-database rather than copied at a possibly torn point.
const EXCLUDED_DATABASE_FILES = ['orchestration.db']

// Classes that stay on the device and are never uploaded to the server by
// default (lifecycle step 4): SSH keys, Git credentials, local env, terminal
// history, plus the encrypted account stores. The dry-run plan marks each
// present class sensitive-device-only; it never reads their contents.
const DEVICE_ONLY_SENSITIVE_PREFIXES = [
  'terminal-history',
  join(PIE_STATE_DIR, 'session-secrets'),
  'claude-runtime-auth',
  'claude-accounts',
  'codex-accounts',
  'codex-runtime-home'
]

function hasPathPrefix(relativePath: string, prefix: string): boolean {
  // Why: compare on path segments so "claude-accounts" does not match a sibling
  // like "claude-accounts-archive"; separator is normalized for the guard only.
  const normalized = relativePath.split('\\').join('/')
  const normalizedPrefix = prefix.split('\\').join('/')
  return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`)
}

export function isExcludedSecretRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/')
  if (normalized.endsWith('.enc')) {
    return true
  }
  return EXCLUDED_SECRET_PREFIXES.some((prefix) => hasPathPrefix(relativePath, prefix))
}

export function isExcludedDatabaseRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/')
  return EXCLUDED_DATABASE_FILES.includes(normalized)
}

export function isDeviceOnlySensitiveRelativePath(relativePath: string): boolean {
  return DEVICE_ONLY_SENSITIVE_PREFIXES.some((prefix) => hasPathPrefix(relativePath, prefix))
}

export function listExcludedSecretPrefixes(): readonly string[] {
  return EXCLUDED_SECRET_PREFIXES
}

export function listExcludedDatabaseFiles(): readonly string[] {
  return EXCLUDED_DATABASE_FILES
}

export function listDeviceOnlySensitivePrefixes(): readonly string[] {
  return DEVICE_ONLY_SENSITIVE_PREFIXES
}
