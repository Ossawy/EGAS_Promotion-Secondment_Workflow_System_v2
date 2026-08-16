import { describe, expect, it, vi } from 'vitest'
import { applyMigration, executeFullPostgresScript, loadMigrations, migrateDatabase } from '../src/db/migration-runner.js'

const script = `
CREATE TABLE migration_probe (value text);
INSERT INTO migration_probe VALUES ('semicolon; in a string');
DO $migration_body$
BEGIN
  PERFORM 1;
  RAISE NOTICE 'semicolon; in PL/pgSQL';
END;
$migration_body$;
`

describe('PostgreSQL migration runner', () => {
  it('sends a complete multi-statement and dollar-quoted script as one parameterless query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    await executeFullPostgresScript({ query } as never, script)
    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith(script)
  })

  it('records a checksum only after successful SQL', async () => {
    const calls: unknown[][] = []
    const query = vi.fn(async (...args: unknown[]) => {
      calls.push(args)
      return calls.length === 1 ? { rows: [] } : { rows: [] }
    })
    await expect(applyMigration({ query } as never, {
      version: '002_probe', sha256: 'a'.repeat(64), sql: script
    })).resolves.toBe('applied')
    expect(calls.map(call => call[0])).toEqual([
      'SELECT version, sha256 FROM egas_schemamigration WHERE version=$1',
      script,
      'INSERT INTO egas_schemamigration (version,sha256,appliedat) VALUES ($1,$2,CURRENT_TIMESTAMP)'
    ])
  })

  it('does not record failed SQL and blocks checksum drift', async () => {
    const failed = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('synthetic SQL failure'))
    await expect(applyMigration({ query: failed } as never, {
      version: '002_probe', sha256: 'a'.repeat(64), sql: script
    })).rejects.toThrow('synthetic SQL failure')
    expect(failed).toHaveBeenCalledTimes(2)

    const drift = vi.fn().mockResolvedValue({ rows: [{ version: '001_postgres_integrity', sha256: 'a'.repeat(64) }] })
    await expect(applyMigration({ query: drift } as never, {
      version: '001_postgres_integrity', sha256: 'b'.repeat(64), sql: script
    })).rejects.toThrow('has changed')
    expect(drift).toHaveBeenCalledOnce()
  })

  it('preserves the legacy handwritten-schema block and rolls back', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass('egas.routing_unit')")) {
        return { rows: [{ legacy: 'egas.routing_unit', current: null }] }
      }
      return { rows: [] }
    })
    const release = vi.fn()
    const pool = { connect: vi.fn(async () => ({ query, release })) }
    await expect(migrateDatabase(pool as never)).rejects.toThrow('handwritten egas.routing_unit')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  it('loads the additive Phase 2B annual-snapshot integrity migration after immutable 001', async () => {
    const migrations = await loadMigrations()
    expect(migrations.map(migration => migration.version)).toEqual([
      '001_postgres_integrity','002_phase2b_annual_snapshot_integrity'
    ])
    expect(migrations[1]?.sql).toContain('uq_egas_activated_import_batch_per_year')
    expect(migrations[1]?.sql).toContain('trg_egas_employee_annual_snapshot_append_only')
  })
})
