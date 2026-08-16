import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { isolatedPool, assertTestDatabaseIsIsolated, testConfig } from './helpers/database.js'
import { cleanupSyntheticWorkbooks, syntheticRow, syntheticWorkbook } from './helpers/workbook.js'
import { ImportService } from '../src/modules/import/import-service.js'
import { RoutingAliasService } from '../src/modules/import/routing-alias-service.js'
import { EmployeeDataService } from '../src/modules/employee/employee-data-service.js'

const evidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'phase2b-service-test' }
let pool: Pool
let imports: ImportService
let operator: { userId: string, username: string }
let unit: { id: string, nameAr: string }

async function stage(rows = [syntheticRow()], year = 2026) {
  const adjusted = rows.map(row => {
    const sourceRouting = row['النيابة /المساعد']
    return { ...row, 'النيابة /المساعد': sourceRouting === undefined || sourceRouting === 'UNIT_NAME' ? unit.nameAr : sourceRouting }
  })
  const file = await syntheticWorkbook({ rows: adjusted })
  return await imports.stageWorkbook(file, year, operator.username, evidence)
}

beforeEach(async () => {
  process.env.EGAS_IMPORT_PERFORMANCE_HEADER = 'تقرير كفاية 2026'
  pool = await isolatedPool()
  imports = new ImportService(pool)
  operator = { userId: randomUUID(), username: 'phase2b-admin' }
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,'Phase 2B Admin','synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [operator.userId, operator.username]
  )
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,'ADMIN',FALSE,TRUE,CURRENT_TIMESTAMP)`, [randomUUID(), operator.userId]
  )
  const result = await pool.query<{ id: string, nameAr: string }>(
    `SELECT id,namear AS "nameAr" FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 1`
  )
  unit = result.rows[0]!
})

afterEach(async () => {
  delete process.env.EGAS_IMPORT_PERFORMANCE_HEADER
  await cleanupSyntheticWorkbooks()
  await pool.end()
})

describe('Phase 2B staging, revalidation, activation, and lookup', () => {
  it('31. records raw staging, approved header metadata, checksum, and exact batch counts', async () => {
    const result = await stage([
      syntheticRow(),
      syntheticRow({ 'رقم الموظف': '000124', 'اسم الموظف': 'موظف ثان', 'تقرير كفاية 2026': 'جيد' })
    ])
    expect(result).toMatchObject({ totalRows: 2, validRows: 1, warningRows: 1, blockedRows: 0, status: 'VALIDATED' })
    expect(result.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.detectedHeaders).toContain('رقم الموظف')
    const raw = await pool.query(`SELECT rawjson FROM egas_employeeimportstagingrow WHERE importbatch_id=$1 ORDER BY sourcerownumber`, [result.id])
    expect(raw.rows[0].rawjson['رقم الموظف']).toBe('000123')
  })

  it('32. revalidation resolves a formerly blocked label only after an explicit active alias', async () => {
    const result = await stage([syntheticRow({ 'النيابة /المساعد': 'مصدر اختباري غير مطابق' })])
    expect(result.blockedRows).toBe(1)
    const aliases = new RoutingAliasService(pool)
    await aliases.create(operator, { sourceLabel: 'مصدر اختباري غير مطابق', routingUnitId: unit.id }, evidence)
    const revalidated = await imports.revalidate(result.id, operator, evidence)
    expect(revalidated).toMatchObject({ validRows: 1, blockedRows: 0, status: 'VALIDATED' })
    expect((await pool.query(`SELECT rawjson FROM egas_employeeimportstagingrow WHERE importbatch_id=$1`, [result.id])).rows[0].rawjson['النيابة /المساعد']).toBe('مصدر اختباري غير مطابق')
  })

  it('33. staging and validation never activate or materialize employee snapshots implicitly', async () => {
    const result = await stage()
    expect(result.status).toBe('VALIDATED')
    expect((await pool.query('SELECT id FROM egas_employeeannualsnapshot')).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM egas_employee')).rows).toHaveLength(0)
  })

  it('34. serializes same-batch concurrent activation so exactly one attempt succeeds', async () => {
    const result = await stage()
    const outcomes = await Promise.allSettled([
      imports.activate(result.id, operator, evidence), imports.activate(result.id, operator, evidence)
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect((await pool.query('SELECT id FROM egas_employeeannualsnapshot')).rows).toHaveLength(1)
  })

  it('35. rejects inconsistent staging before writes and leaves no partial Employee or snapshot data', async () => {
    const result = await stage([
      syntheticRow(),
      syntheticRow({ 'رقم الموظف': '000124', 'اسم الموظف': 'FAIL' })
    ])
    await pool.query(
      `UPDATE egas_employeeimportstagingrow SET mappedroutingunit_id=NULL
        WHERE importbatch_id=$1 AND personnelnumber='000124'`, [result.id]
    )
    await expect(imports.activate(result.id, operator, evidence)).rejects.toMatchObject({ code: 'IMPORT_STAGING_INCONSISTENT' })
    expect((await pool.query('SELECT id FROM egas_employeeannualsnapshot')).rows).toHaveLength(0)
    expect((await pool.query('SELECT id FROM egas_employee')).rows).toHaveLength(0)
    expect((await pool.query('SELECT status FROM egas_importbatch WHERE id=$1', [result.id])).rows[0].status).toBe('VALIDATED')
  })

  it('36. reuses stable Employee identity across different annual snapshot years', async () => {
    const first = await stage([syntheticRow()], 2025)
    await imports.activate(first.id, operator, evidence)
    const second = await stage([syntheticRow({ 'اسم الموظف': 'اسم سنة لاحقة' })], 2026)
    await imports.activate(second.id, operator, evidence)
    expect((await pool.query('SELECT id FROM egas_employee')).rows).toHaveLength(1)
    expect((await pool.query('SELECT id FROM egas_employeeannualsnapshot ORDER BY snapshotyear')).rows).toHaveLength(2)
  })

  it('37. preserves prior-year snapshot values unchanged after a later annual activation', async () => {
    const first = await stage([syntheticRow({ 'اسم الموظف': 'اسم السنة الأولى' })], 2025)
    await imports.activate(first.id, operator, evidence)
    const before = await pool.query(`SELECT employeename FROM egas_employeeannualsnapshot WHERE snapshotyear=2025`)
    const second = await stage([syntheticRow({ 'اسم الموظف': 'اسم السنة الثانية' })], 2026)
    await imports.activate(second.id, operator, evidence)
    const after = await pool.query(`SELECT employeename FROM egas_employeeannualsnapshot WHERE snapshotyear=2025`)
    expect(after.rows).toEqual(before.rows)
  })

  it('38. employee lookup uses only the latest active annual snapshot and never falls back', async () => {
    const first = await stage([syntheticRow({ 'اسم الموظف': 'اسم قديم' })], 2025)
    await imports.activate(first.id, operator, evidence)
    const second = await stage([syntheticRow({ 'رقم الموظف': '000999', 'اسم الموظف': 'اسم حالي' })], 2026)
    await imports.activate(second.id, operator, evidence)
    const employees = new EmployeeDataService(pool)
    await expect(employees.employee('000123')).rejects.toMatchObject({ status: 404 })
    await expect(employees.employee('000999')).resolves.toMatchObject({ snapshotYear: 2026, employeeName: 'اسم حالي' })
  })

  it('39. returns explicit errors for no active snapshot and an unknown active-year Personnel Number', async () => {
    const employees = new EmployeeDataService(pool)
    await expect(employees.activeSnapshot()).rejects.toMatchObject({ code: 'ACTIVE_SNAPSHOT_UNAVAILABLE' })
    const result = await stage()
    await imports.activate(result.id, operator, evidence)
    await expect(employees.employee('not-present')).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT' })
  })

  it('40. exposes جيد and missing-performance warnings in a safe allow-listed DTO', async () => {
    const result = await stage([
      syntheticRow({ 'تقرير كفاية 2026': 'جيد' }),
      syntheticRow({ 'رقم الموظف': '000124', 'اسم الموظف': 'موظف ثان', 'تقرير كفاية 2026': '' })
    ])
    await imports.activate(result.id, operator, evidence)
    const employees = new EmployeeDataService(pool)
    const good = await employees.employee('000123')
    const missing = await employees.employee('000124')
    expect(good.warnings).toMatchObject({ performanceRequiresAttention: true, performanceMissing: false })
    expect(missing.warnings).toMatchObject({ performanceRequiresAttention: false, performanceMissing: true })
    expect(JSON.stringify([good, missing])).not.toMatch(/rawJson|password|session|sourceSha256|importBatch/)
  })

  it('41. records aggregate import evidence without employee row values', async () => {
    const result = await stage()
    await imports.activate(result.id, operator, evidence)
    const events = await pool.query(`SELECT eventtype,detailsjson FROM egas_securityevent WHERE correlationid=$1`, [evidence.correlationId])
    expect(events.rows.map(row => row.eventtype)).toEqual(expect.arrayContaining([
      'IMPORT_BATCH_STAGED','IMPORT_BATCH_VALIDATION_COMPLETED','IMPORT_BATCH_ACTIVATED'
    ]))
    expect(JSON.stringify(events.rows)).not.toContain('موظف اختباري')
    expect(JSON.stringify(events.rows)).not.toContain('000123')
  })

  it('42. refuses any automated test configuration aimed at egas_workflow_dev', () => {
    expect(() => assertTestDatabaseIsIsolated({
      ...testConfig, database: { ...testConfig.database, database: 'egas_workflow_dev' }
    })).toThrow(/refuse/)
  })
})
