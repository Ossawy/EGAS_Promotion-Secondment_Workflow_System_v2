export type AppliedMigration = {
  version: string
  sha256: string
}

export type PendingMigration = AppliedMigration & {
  sql: string
}

export type PostgresSimpleQueryExecutor = {
  exec: (sql: string) => Promise<unknown>
}

type TrackedMigrationOperations = {
  executor: PostgresSimpleQueryExecutor
  migration: PendingMigration
  readApplied: () => Promise<AppliedMigration | undefined>
  recordApplied: () => Promise<unknown>
}

export type MigrationApplyResult = 'applied' | 'already-applied'

/**
 * Execute a repository-owned PostgreSQL script without parsing or splitting it.
 *
 * @cap-js/postgres implements exec(sql) as pg Client.query(sql). With a bare SQL
 * string and no parameters/name, pg selects PostgreSQL's simple-query protocol,
 * which accepts a complete multi-statement script including dollar-quoted bodies.
 * The caller must provide an already-started managed CAP transaction.
 */
export async function executePostgresScript(
  executor: PostgresSimpleQueryExecutor,
  sql: string
): Promise<void> {
  if (typeof executor.exec !== 'function') {
    throw new Error('The active CAP database adapter does not expose PostgreSQL simple-query execution')
  }

  if (sql.trim().length === 0) return
  await executor.exec(sql)
}

/**
 * Apply one migration and write its checksum only after the complete script
 * succeeds. All supplied operations must use the same managed transaction.
 */
export async function applyTrackedPostgresMigration({
  executor,
  migration,
  readApplied,
  recordApplied
}: TrackedMigrationOperations): Promise<MigrationApplyResult> {
  const applied = await readApplied()
  if (applied) {
    if (applied.sha256 !== migration.sha256) {
      throw new Error(`Applied migration ${migration.version} has changed; create a new migration instead`)
    }
    return 'already-applied'
  }

  await executePostgresScript(executor, migration.sql)
  await recordApplied()
  return 'applied'
}
