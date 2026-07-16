import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'
import { detectOrcaInstall, type OrcaInstallInventory } from './orca-install-detection'
import {
  createProfileSnapshot,
  type ProfileSnapshotResult,
  type SnapshotClock
} from './profile-snapshot'
import {
  isDeviceOnlySensitiveRelativePath,
  listDeviceOnlySensitivePrefixes,
  PIE_MIGRATION_REPORTS_DIR,
  pieMigrationTargetRelativePath
} from './pie-product-identity'
import {
  PIE_MIGRATION_DRY_RUN_REPORT_SCHEMA_VERSION,
  PieMigrationDryRunReportSchema,
  type PieMigrationDryRunCounts,
  type PieMigrationDryRunReport,
  type PieMigrationPlanItem
} from './pie-migration-report'

const PLAN_REASONS = {
  create: 'target absent; migration would create this item in the Pie layout',
  merge: 'target present and identical; re-tag in place with no divergence',
  conflict: 'target present with diverging content; manual reconciliation required',
  missing: 'expected source file absent',
  'sensitive-device-only': 'device-only; never uploaded to the server by default'
} as const

// Compares source bytes against the projected target without retaining either;
// only the resulting action label leaves this function.
function classifyPresentSource(
  userDataPath: string,
  relativePath: string
): 'create' | 'merge' | 'conflict' {
  const targetAbsolute = join(userDataPath, pieMigrationTargetRelativePath(relativePath))
  if (!existsSync(targetAbsolute)) {
    return 'create'
  }
  try {
    const source = readFileSync(join(userDataPath, relativePath))
    const target = readFileSync(targetAbsolute)
    return source.equals(target) ? 'merge' : 'conflict'
  } catch {
    // Why: an unreadable projected target is treated as a divergence rather than
    // a silent merge, so it surfaces for reconciliation.
    return 'conflict'
  }
}

function planItem(
  plannedAction: PieMigrationPlanItem['plannedAction'],
  relativePath: string
): PieMigrationPlanItem {
  return { relativePath, plannedAction, reason: PLAN_REASONS[plannedAction] }
}

function buildPlanItems(
  userDataPath: string,
  inventory: OrcaInstallInventory
): PieMigrationPlanItem[] {
  const items: PieMigrationPlanItem[] = []

  if (inventory.indexRelativePath) {
    items.push(
      planItem(
        classifyPresentSource(userDataPath, inventory.indexRelativePath),
        inventory.indexRelativePath
      )
    )
  }

  for (const profile of inventory.profiles) {
    for (const file of profile.files) {
      if (file.role === 'data-backup') {
        // Backups travel with the snapshot; they are not separately migrated.
        continue
      }
      if (!file.exists) {
        // Only the required data file counts as a missing source; an absent
        // browser-session-meta is normal for a fresh profile and is skipped.
        if (file.role === 'data') {
          items.push(planItem('missing', file.relativePath))
        }
        continue
      }
      items.push(
        planItem(classifyPresentSource(userDataPath, file.relativePath), file.relativePath)
      )
    }
  }

  for (const prefix of listDeviceOnlySensitivePrefixes()) {
    if (existsSync(join(userDataPath, prefix)) && isDeviceOnlySensitiveRelativePath(prefix)) {
      items.push(planItem('sensitive-device-only', prefix))
    }
  }

  return items
}

function countActions(items: PieMigrationPlanItem[]): PieMigrationDryRunCounts {
  const counts: PieMigrationDryRunCounts = {
    create: 0,
    merge: 0,
    conflict: 0,
    missing: 0,
    sensitive: 0
  }
  for (const item of items) {
    if (item.plannedAction === 'sensitive-device-only') {
      counts.sensitive += 1
    } else {
      counts[item.plannedAction] += 1
    }
  }
  return counts
}

function reportPathFor(userDataPath: string, runId: string): string {
  return join(userDataPath, PIE_MIGRATION_REPORTS_DIR, `${runId}.json`)
}

export type PieMigrationDryRunResult = {
  report: PieMigrationDryRunReport
  reportPath: string
  snapshot: ProfileSnapshotResult | null
}

/**
 * Runs the Orca to Pie migration dry-run: read-only detection, an optional
 * read-only snapshot, and a per-item plan that moves NO data. The report counts
 * create/merge/conflict/missing/sensitive items and carries only relative paths
 * — never file contents or token values. Running twice on an unchanged tree
 * yields the same report apart from runId/timestamp. Persists the report under
 * userData/pie/migration-reports and returns it.
 */
export function runPieMigrationDryRun(options: {
  userDataPath: string
  clock: SnapshotClock
  createSnapshot?: boolean
}): PieMigrationDryRunResult {
  const { userDataPath, clock } = options
  const inventory = detectOrcaInstall(userDataPath)

  const snapshot =
    options.createSnapshot && inventory.kind !== 'none'
      ? createProfileSnapshot({ userDataPath, inventory, clock })
      : null

  const items = buildPlanItems(userDataPath, inventory)

  const report: PieMigrationDryRunReport = PieMigrationDryRunReportSchema.parse({
    schemaVersion: PIE_MIGRATION_DRY_RUN_REPORT_SCHEMA_VERSION,
    runId: clock.runId,
    createdAt: clock.now(),
    sourceInstall: inventory.kind,
    snapshot: snapshot
      ? { runId: snapshot.runId, manifestRelativePath: snapshot.manifestRelativePath }
      : null,
    counts: countActions(items),
    items
  })

  const reportPath = reportPathFor(userDataPath, clock.runId)
  mkdirSync(join(userDataPath, PIE_MIGRATION_REPORTS_DIR), { recursive: true })
  // Why: the report describes the user's filesystem; keep it permission-restricted.
  writeSecureJsonFile(reportPath, report)

  return { report, reportPath, snapshot }
}
