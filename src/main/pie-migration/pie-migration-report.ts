import { z } from 'zod'

export const PIE_MIGRATION_SNAPSHOT_MANIFEST_SCHEMA_VERSION = 1
export const PIE_MIGRATION_DRY_RUN_REPORT_SCHEMA_VERSION = 1

// Why: the manifest and report describe the user's filesystem only. Entries
// carry relative paths and byte counts — never file contents, tokens, or any
// value read from inside a file (lifecycle: no raw secrets in report output).

export const SnapshotEntryActionSchema = z.enum([
  'copied',
  'excluded-secret',
  'excluded-database',
  'missing'
])
export type SnapshotEntryAction = z.infer<typeof SnapshotEntryActionSchema>

export const SnapshotManifestEntrySchema = z
  .object({
    relativePath: z.string().min(1),
    action: SnapshotEntryActionSchema,
    bytes: z.number().int().nonnegative()
  })
  .strict()
export type SnapshotManifestEntry = z.infer<typeof SnapshotManifestEntrySchema>

export const OrcaInstallKindSchema = z.enum(['none', 'legacy-single-profile', 'multi-profile'])
export type OrcaInstallKind = z.infer<typeof OrcaInstallKindSchema>

export const ProfileSnapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(PIE_MIGRATION_SNAPSHOT_MANIFEST_SCHEMA_VERSION),
    runId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    sourceInstall: OrcaInstallKindSchema,
    entries: z.array(SnapshotManifestEntrySchema)
  })
  .strict()
export type ProfileSnapshotManifest = z.infer<typeof ProfileSnapshotManifestSchema>

export const PlannedMigrationActionSchema = z.enum([
  'create',
  'merge',
  'conflict',
  'missing',
  'sensitive-device-only'
])
export type PlannedMigrationAction = z.infer<typeof PlannedMigrationActionSchema>

export const PieMigrationPlanItemSchema = z
  .object({
    relativePath: z.string().min(1),
    plannedAction: PlannedMigrationActionSchema,
    reason: z.string().min(1)
  })
  .strict()
export type PieMigrationPlanItem = z.infer<typeof PieMigrationPlanItemSchema>

export const PieMigrationDryRunCountsSchema = z
  .object({
    create: z.number().int().nonnegative(),
    merge: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    sensitive: z.number().int().nonnegative()
  })
  .strict()
export type PieMigrationDryRunCounts = z.infer<typeof PieMigrationDryRunCountsSchema>

export const PieMigrationSnapshotReferenceSchema = z
  .object({
    runId: z.string().min(1),
    manifestRelativePath: z.string().min(1)
  })
  .strict()
export type PieMigrationSnapshotReference = z.infer<typeof PieMigrationSnapshotReferenceSchema>

export const PieMigrationDryRunReportSchema = z
  .object({
    schemaVersion: z.literal(PIE_MIGRATION_DRY_RUN_REPORT_SCHEMA_VERSION),
    runId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    sourceInstall: OrcaInstallKindSchema,
    snapshot: PieMigrationSnapshotReferenceSchema.nullable(),
    counts: PieMigrationDryRunCountsSchema,
    items: z.array(PieMigrationPlanItemSchema)
  })
  .strict()
export type PieMigrationDryRunReport = z.infer<typeof PieMigrationDryRunReportSchema>
