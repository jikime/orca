import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

export type PostgresHarness = {
  connectionString: string
  stop: () => Promise<void>
}

/**
 * Starts an ephemeral PostgreSQL 16 for integration tests. The default user is a
 * superuser, so the migration runner can create roles and the tests can SET ROLE
 * into pie_app / pie_worker to exercise RLS under least privilege. Throws if the
 * Docker daemon is unavailable — callers skip gracefully with an explicit reason.
 */
export async function startPostgresHarness(): Promise<PostgresHarness> {
  // Integration databases are disposable; tmpfs prevents Docker's declared
  // PGDATA volume from leaking one anonymous volume per test process.
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16')
    .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=512m' })
    .start()
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop()
    }
  }
}
