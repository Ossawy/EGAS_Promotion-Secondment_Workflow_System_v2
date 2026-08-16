import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('least-privilege deployment SQL', () => {
  it('is fail-closed, owner-scoped, and supports pg_database_owner', async () => {
    const sql = await readFile(new URL('../db/operations/least-privilege-role.sql.example', import.meta.url), 'utf8')
    expect(sql).toContain('\\set ON_ERROR_STOP on')
    expect(sql).not.toMatch(/\\quit(?:\s|$)/)
    expect(sql).toContain("predefined_database_owner.rolname = 'pg_database_owner'")
    expect(sql).toContain('deployment_object.relowner <> owner_role.oid')
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE :"schema_owner" IN SCHEMA public')
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    expect(sql).toContain('REVOKE CREATE ON DATABASE :"database_name" FROM :"runtime_role"')
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'))
  })

  it('preserves append-only restrictions and denies the historical outbox', async () => {
    const sql = await readFile(new URL('../db/operations/least-privilege-role.sql.example', import.meta.url), 'utf8')
    for (const table of ['egas_AuditEvent','egas_WorkflowNote','egas_StageReceivedSnapshot','egas_EmployeeAnnualSnapshot','egas_StageAction','egas_WorkflowSignoff']) {
      expect(sql).toContain(table)
    }
    expect(sql).toContain('REVOKE DELETE ON TABLE egas_FrozenPdfDocument')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE egas_SchemaMigration')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE cds_outbox_messages FROM :"runtime_role"')
    expect(sql).toContain('AS verified_no_historical_outbox_access')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE cds_model FROM :"runtime_role"')
    expect(sql).toContain('AS verified_no_historical_cap_model_access')
    expect(sql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cds_outbox_messages')
  })
})
