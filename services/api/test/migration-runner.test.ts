import { describe, expect, it, vi } from 'vitest'
import {
  applyMigration, executeFullPostgresScript, isMigrationFilename, loadMigrations, migrateDatabase
} from '../src/db/migration-runner.js'

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
  it('recognizes migration filenames with linear parsing, including adversarial near-matches', () => {
    expect(['001.sql', '002_phase2.sql', '9-A.SQL'].map(isMigrationFilename)).toEqual([true, true, true])
    expect(['migration.sql', '.sql', '001.sql.bak', '001', '001 probe.sql', '001..sql'].map(isMigrationFilename))
      .toEqual([false, false, false, false, false, false])
    expect(isMigrationFilename(`1${'a'.repeat(1_000_000)}.txt`)).toBe(false)
    expect(isMigrationFilename(`1${'a'.repeat(1_000_000)}.sql`)).toBe(true)
  })

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

  it('loads additive implementation migrations after immutable 001', async () => {
    const migrations = await loadMigrations()
    expect(migrations.map(migration => migration.version)).toEqual([
      '001_postgres_integrity','002_phase2b_annual_snapshot_integrity','003_phase3a_workflow_draft_foundation',
      '004_secondment_workflow_integrity','005_promotion_workflow_integrity','006_pdf_evidence_freeze',
      '007_promotion_cross_department_review'
    ])
    expect(migrations[1]?.sql).toContain('uq_egas_activated_import_batch_per_year')
    expect(migrations[1]?.sql).toContain('trg_egas_employee_annual_snapshot_append_only')
    expect(migrations[2]?.sql).toContain('uq_egas_active_candidate_request_snapshot')
    expect(migrations[2]?.sql).toContain('removedBy_ID')
    expect(migrations[2]?.sql).toContain('ck_egas_request_current_stage')
    expect(migrations[3]?.sql).toContain('uq_egas_secondment_selected_candidate_iteration')
    expect(migrations[3]?.sql).toContain('ck_egas_secondment_position_selection')
    expect(migrations[4]?.sql).toContain('c__egas_promotiondecision_candidate')
    expect(migrations[5]?.sql).toContain('trg_egas_frozen_pdf_document_protect')
    expect(migrations[6]?.sql).toContain('targetroutingunit_id')
    expect(migrations.map(migration => migration.sha256)).toEqual([
      '760a0c27322cd44f18bd57854fedccad334aabfe985052e70f853cbb5a2aae6f',
      '0d423387e20104188d9755209eabd58f354cff41a30ca7a32ff8350fd1d66b40',
      '01e9e6c34657a0a6f15ce8cbbfc322c5dccc97b2a47ec177d1ea3b03662e7ec0',
      'bdbdf8846f44ab3474105a46bd2fcd9d0027d6008c4c9062c9a6fa8358e934f7',
      '5fa7f568dc8200e51d8d58c72648d5aaf99d352432dec04db2157d199ad276db',
      '8edff26bad677d75ba24bd88e2ff9824c61117c89782f32c8b92e787c1c60bf6',
      '8825f9149e41189598fc866bd9ea222432ee061500a0b7308d38cc995a8f2d58'
    ])
  })
})
