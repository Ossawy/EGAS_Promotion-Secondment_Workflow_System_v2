import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { withStandaloneDatabase } from '../lib/runtime/standalone-database-lifecycle.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('standalone database command lifecycle', () => {
  it('disconnects after a successful command before resolving', async () => {
    const calls: string[] = []
    const database = {
      disconnect: vi.fn(async () => { calls.push('disconnect') })
    }

    const result = await withStandaloneDatabase(
      async () => database,
      async () => {
        calls.push('command')
        return 'complete'
      }
    )

    expect(result).toBe('complete')
    expect(calls).toEqual(['command', 'disconnect'])
    expect(database.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects when a transactional command fails and preserves failure', async () => {
    const failure = new Error('synthetic bootstrap refusal')
    const database = { disconnect: vi.fn().mockResolvedValue(undefined) }

    await expect(withStandaloneDatabase(
      async () => database,
      async () => { throw failure }
    )).rejects.toBe(failure)

    expect(database.disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('PostgreSQL least-privilege deployment script', () => {
  async function readLeastPrivilegeScript(): Promise<string> {
    return await readFile(
      path.join(projectRoot, 'db/operations/least-privilege-role.sql.example'),
      'utf8'
    )
  }

  it('covers current/future CAP objects while preserving restricted entities', async () => {
    const sql = await readLeastPrivilegeScript()

    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public')
    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cds_outbox_messages')
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public')
    expect(sql).toContain('deployment_objects_owned_by_schema_owner')
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    expect(sql).toContain('REVOKE CREATE ON DATABASE :"database_name" FROM :"runtime_role"')
    expect(sql).toContain('verified_no_temporary')
    expect(sql).toContain("NOT has_schema_privilege(:'runtime_role', 'public', 'CREATE')")
    expect(sql.indexOf('AS verified_outbox_dml')).toBeLessThan(sql.indexOf('COMMIT;'))

    for (const table of [
      'egas_AuditEvent',
      'egas_WorkflowNote',
      'egas_StageReceivedSnapshot',
      'egas_StageAction',
      'egas_WorkflowSignoff'
    ]) {
      expect(sql).toContain(table)
    }
    expect(sql).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE egas_SchemaMigration FROM :"runtime_role"'
    )
  })

  it('accepts postgres-owned CAP objects with a pg_database_owner public schema', async () => {
    const sql = await readLeastPrivilegeScript()

    // Live-compatible scenario: database/schema_owner=postgres, runtime=egas_app,
    // public owner=pg_database_owner. Object ownership must still be postgres.
    expect(sql).toMatch(
      /d\.datdba = owner_role\.oid\s+AND \(\s+public_schema\.nspowner = owner_role\.oid\s+OR public_schema\.nspowner = predefined_database_owner\.oid\s+\)/
    )
    expect(sql).toContain("predefined_database_owner.rolname = 'pg_database_owner'")
    expect(sql).toContain('deployment_object.relowner <> owner_role.oid')
  })

  it('fails closed without unsupported psql quit arguments', async () => {
    const sql = await readLeastPrivilegeScript()
    const begin = sql.indexOf('BEGIN;')
    const firstGrant = sql.indexOf('REVOKE CONNECT, CREATE, TEMPORARY')

    expect(sql).toContain('\\set ON_ERROR_STOP on')
    expect(sql).not.toMatch(/\\quit(?:\s|$)/)
    expect(sql.slice(0, begin)).toContain('SELECT 1 / 0 AS validation_failure;')
    expect(begin).toBeGreaterThan(-1)
    expect(firstGrant).toBeGreaterThan(begin)
    expect(sql).toMatch(/ROLLBACK;\r?\n  \\echo 'Grant verification failed/)
    expect(sql.indexOf('AS verified_outbox_dml')).toBeLessThan(sql.indexOf('COMMIT;'))
  })
})
