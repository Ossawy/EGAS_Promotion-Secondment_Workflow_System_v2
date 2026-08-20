import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const migration = new URL('../src/db/migrations/001_initial_v5_schema.sql', import.meta.url)

describe('Phase 1 v5 schema contract', () => {
  it('uses the clean lowercase v5 physical baseline', async () => {
    const sql = await readFile(migration, 'utf8')
    for (const table of ['user_account','auth_session','routing_unit','operational_unit','user_unit_membership','unit_manager_assignment','audit_event','security_event']) expect(sql).toContain(`CREATE TABLE ${table}`)
    expect(sql).toContain("account_type IN ('ADMIN','OPERATIONAL')")
    expect(sql).toContain('user_unit_membership_one_active_per_user')
    expect(sql).toContain('unit_manager_assignment_one_active_per_unit')
    expect(sql).toContain("kind='HR'")
    expect(sql).toContain("kind='ORG'")
    expect(sql).toContain("kind='AUTH'")
    expect(sql).not.toContain('egas_useraccount')
  })

  it('does not retain the historical active migration chain', async () => {
    const files = await (await import('node:fs/promises')).readdir(new URL('../src/db/migrations/', import.meta.url))
    expect(files).toEqual(['001_initial_v5_schema.sql'])
  })
})
