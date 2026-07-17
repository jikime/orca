import SyncDatabase from '../sqlite/sync-database'

// Packaged SQLite version guard (R5 s2). The outbox depends on Electron/Runtime shipping a
// usable built-in `node:sqlite`. If the packaged binary is missing or the SQLite build is
// too old to run our schema, the outbox must degrade safely (capture keeps producing events
// into memory) rather than crash the capture pipeline. This probe surfaces a structured
// diagnostic the caller can log — it NEVER throws.

export type SqliteGuardResult = {
  usable: boolean
  /** SQLite library version reported by the packaged binary, when it opened at all. */
  sqliteVersion: string | null
  /** Whether `PRAGMA journal_mode=WAL` was accepted on a real file (false for :memory:). */
  walSupported: boolean
  /** Present only when unusable; a short reason for the structured diagnostic (no secrets). */
  reason?: string
}

// A trivial open + schema round-trip. On a real file we also confirm WAL is accepted; an
// in-memory DB reports `memory` journal mode, which is still usable (WAL just does not apply).
export function probeSqlite(path: string | ':memory:' = ':memory:'): SqliteGuardResult {
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(path)
    // sqlite_version is a function, not a PRAGMA — query it directly.
    const versionRow = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined
    const sqliteVersion = versionRow?.v ?? ''
    db.exec('CREATE TABLE IF NOT EXISTS __outbox_probe__ (x INTEGER)')
    const mode = db.pragma('journal_mode = WAL', { simple: true })
    const walSupported = typeof mode === 'string' && mode.toLowerCase() === 'wal'
    return { usable: true, sqliteVersion, walSupported }
  } catch (error) {
    return {
      usable: false,
      sqliteVersion: null,
      walSupported: false,
      reason: error instanceof Error ? error.message : 'unknown sqlite failure'
    }
  } finally {
    db?.close()
  }
}
