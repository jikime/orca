import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './database-schema'

// Alias so consumers type against the Pie schema without importing kysely directly.
export type PieDatabase = Kysely<Database>

export type PersistenceConfig = {
  connectionString: string
  maxPoolSize?: number
}

export function createDatabasePool(config: PersistenceConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxPoolSize ?? 10
  })
}

export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

/** Liveness probe for /readyz and worker boot: a single round-trip `select 1`. */
export async function pingDatabase(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query('select 1 as ok')
  return result.rows[0]?.ok === 1
}
