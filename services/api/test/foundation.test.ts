import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { isolatedPool } from './helpers/database.js'
import { normalizeNullableSentinel, validateHeaders } from '../src/modules/import/header-validation.js'
import { findActivePrivilegedAdminAccounts } from '../src/db/repositories/pilot-repository.js'

describe('plain Node foundation', () => {
  it('materializes the preserved physical schema and fixed reference data in isolation', async () => {
    const pool = await isolatedPool()
    try {
      const tables = await pool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'egas_%'"
      )
      expect(tables.rows).toHaveLength(31)
      expect((await pool.query('SELECT id FROM egas_routingunit WHERE isactive=TRUE')).rows).toHaveLength(22)
      expect((await pool.query('SELECT code FROM egas_jobcategoryreference ORDER BY displayorder')).rows.map(row => row.code)).toEqual([
        'MANAGER_DEPARTMENT','SECTION_HEAD','STANDARD_FIRST','STANDARD_EXCELLENT','STANDARD_SKILLED'
      ])
    } finally { await pool.end() }
  })

  it('has no CAP dependencies or CAP runtime commands in the new package', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const serialized = JSON.stringify(pkg)
    expect(serialized).not.toMatch(/@sap\/cds|@cap-js|\bcds (?:serve|watch|deploy|build)/)
    expect(serialized).toContain('express')
    expect(serialized).toContain('pg')
  })

  it('routes the root command contract only to the plain API workspace', async () => {
    const root = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>
    }
    const lock = await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8')
    for (const command of ['build','test','typecheck','security:check','db:migrate','admin:bootstrap','pilot:check','dev','start']) {
      expect(root.scripts[command]).toContain('@egas/api')
      expect(root.scripts[command]).not.toContain('cap-api')
    }
    expect(lock).not.toMatch(/node_modules\/(?:@sap\/cds|@cap-js\/)/)
  })

  it('keeps annual workbook normalization exact and validation-only', () => {
    expect(validateHeaders([' رقم الموظف ', 'اسم الموظف'], ['رقم الموظف', 'اسم الموظف'])).toMatchObject({ valid: true, missing: [], duplicates: [] })
    expect(validateHeaders(['رقم الموظف', 'رقم الموظف'], ['رقم الموظف', 'اسم الموظف'])).toMatchObject({ valid: false, missing: ['اسم الموظف'], duplicates: ['رقم الموظف'] })
    expect(normalizeNullableSentinel(' 10 ')).toBeNull()
    expect(normalizeNullableSentinel('جيد')).toBe('جيد')
  })

  it('counts only active accounts with an active ADMIN Manage-Admins role', async () => {
    const pool = await isolatedPool()
    try {
      const variants = [
        ['privileged', true, true, 'ADMIN', true],
        ['disabled-account', false, true, 'ADMIN', true],
        ['inactive-role', true, false, 'ADMIN', true],
        ['non-admin', true, true, 'ORGANIZATION', true],
        ['cannot-manage', true, true, 'ADMIN', false]
      ] as const
      for (const [name, accountActive, roleActive, role, canManage] of variants) {
        const id = `10000000-0000-4000-8000-${String(variants.findIndex(row => row[0] === name) + 1).padStart(12, '0')}`
        await pool.query(
          `INSERT INTO egas_useraccount (id,username,displayname,passwordhash,isactive,createdat,updatedat)
           VALUES ($1,$2,$2,'synthetic',$3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [id, name, accountActive]
        )
        await pool.query(
          `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
           VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,
          [`20000000-0000-4000-8000-${String(variants.findIndex(row => row[0] === name) + 1).padStart(12, '0')}`, id, role, canManage, roleActive]
        )
      }
      expect(await findActivePrivilegedAdminAccounts(pool)).toEqual([{ id: '10000000-0000-4000-8000-000000000001' }])
    } finally { await pool.end() }
  })
})
