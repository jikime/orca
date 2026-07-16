// Logical backup/restore driver. The pg tools run INSIDE the postgres container
// (injected exec), so pg_dump matches server 16 exactly — a host pg_dump of a
// different major (the host here is psql 17.x) is a silent-corruption hazard and
// is deliberately avoided. This is a logical dump (schema + data + roles +
// policies); production ops uses custom-format + pg_restore + WAL/PITR for
// point-in-time recovery, which is deferred to ops docs.

export type PgExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type PgExec = (command: string[]) => Promise<PgExecResult>
export type PgCopyIn = (content: string, targetPath: string) => Promise<void>

export type LogicalBackup = {
  globals: string
  database: string
}

export type BackupOptions = {
  user: string
  database: string
}

async function runOrThrow(exec: PgExec, command: string[]): Promise<string> {
  const result = await exec(command)
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${command.join(' ')}\n${result.stderr}`)
  }
  return result.stdout
}

/**
 * Captures cluster roles (no passwords) and a plain-SQL dump of one database.
 * `--no-role-passwords` keeps any role secret out of the dump entirely.
 */
export async function captureLogicalBackup(
  exec: PgExec,
  options: BackupOptions
): Promise<LogicalBackup> {
  const globals = await runOrThrow(exec, [
    'pg_dumpall',
    '-U',
    options.user,
    '--roles-only',
    '--no-role-passwords'
  ])
  const database = await runOrThrow(exec, ['pg_dump', '-U', options.user, '-d', options.database])
  return { globals, database }
}

/**
 * Restores into a FRESH cluster: roles first (tolerating the bootstrap superuser
 * that already exists), then the database (which must apply cleanly, including
 * schemas, data, grants, and RLS policies).
 */
export async function restoreLogicalBackup(
  exec: PgExec,
  copyIn: PgCopyIn,
  backup: LogicalBackup,
  options: BackupOptions
): Promise<void> {
  await copyIn(backup.globals, '/tmp/pie-globals.sql')
  await copyIn(backup.database, '/tmp/pie-database.sql')
  await exec([
    'psql',
    '-U',
    options.user,
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=0',
    '-f',
    '/tmp/pie-globals.sql'
  ])
  await runOrThrow(exec, [
    'psql',
    '-U',
    options.user,
    '-d',
    options.database,
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '/tmp/pie-database.sql'
  ])
}
