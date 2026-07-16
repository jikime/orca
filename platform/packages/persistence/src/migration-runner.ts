import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url))

// Single well-known advisory lock so only one deployment applies migrations at a
// time (doc 30 :444). Any stable bigint works; this spells a Pie-specific value.
const MIGRATION_ADVISORY_LOCK_KEY = 726_549_001

export const SCHEMA_MIGRATIONS_TABLE = 'public.pie_schema_migrations'

export type MigrationFile = {
  name: string
  sql: string
  checksum: string
}

export type MigrationResult = {
  applied: string[]
  skipped: string[]
}

function checksumOf(contents: string): string {
  // Why: normalize line endings before hashing so the frozen checksum is stable
  // whether the file was checked out with LF or CRLF (cross-platform).
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n'), 'utf-8').digest('hex')
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf-8')
      return { name, sql, checksum: checksumOf(sql) }
    })
}

/**
 * Applies SQL migrations in filename order under an advisory lock. Each file is
 * a plain SQL DDL script (the authority for physical schema). Applied files are
 * recorded with a checksum; a changed checksum of an already-applied migration is
 * a hard error — migrations are frozen once merged.
 */
export async function runMigrations(
  pool: Pool,
  options: { dir?: string } = {}
): Promise<MigrationResult> {
  const files = listMigrationFiles(options.dir)
  const client = await pool.connect()
  try {
    await client.query(
      `create table if not exists ${SCHEMA_MIGRATIONS_TABLE} (
         filename text primary key,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`
    )
    await client.query('select pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
    try {
      const { rows } = await client.query<{ filename: string; checksum: string }>(
        `select filename, checksum from ${SCHEMA_MIGRATIONS_TABLE}`
      )
      const alreadyApplied = new Map(rows.map((row) => [row.filename, row.checksum]))
      const applied: string[] = []
      const skipped: string[] = []

      for (const file of files) {
        const priorChecksum = alreadyApplied.get(file.name)
        if (priorChecksum !== undefined) {
          if (priorChecksum !== file.checksum) {
            throw new Error(
              `Migration ${file.name} changed after being applied (frozen migration violation)`
            )
          }
          skipped.push(file.name)
          continue
        }
        await client.query('begin')
        try {
          await client.query(file.sql)
          await client.query(
            `insert into ${SCHEMA_MIGRATIONS_TABLE} (filename, checksum) values ($1, $2)`,
            [file.name, file.checksum]
          )
          await client.query('commit')
        } catch (error) {
          await client.query('rollback')
          throw error
        }
        applied.push(file.name)
      }
      return { applied, skipped }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
