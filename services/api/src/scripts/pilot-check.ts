import { loadConfig } from '../config/env.js'
import { closePool, getPool } from '../db/pool.js'
import { loadMigrations } from '../db/migration-runner.js'
import { findActiveAdminAccounts } from '../db/repositories/pilot-repository.js'
import { runCli } from '../shared/run-cli.js'

type CheckResult = { check: string; ok: boolean; detail: string }

export async function runPilotChecks(): Promise<CheckResult[]> {
  const config = loadConfig()
  const pool = getPool(config)
  const results: CheckResult[] = [{
    check: 'database runtime role',
    ok: config.database.user.toLowerCase() !== 'postgres',
    detail: `configured as ${config.database.user}`
  }]
  const expectedMigrations = await loadMigrations()
  const appliedMigrations = await pool.query<{ version:string,sha256:string }>(
    'SELECT version,sha256 FROM schema_migration'
  )
  const appliedByVersion = new Map(appliedMigrations.rows.map(row => [row.version, row.sha256.trim()]))
  const missingOrChanged = expectedMigrations.filter(migration => appliedByVersion.get(migration.version) !== migration.sha256)
  results.push({
    check: 'current v5 migrations',
    ok: missingOrChanged.length === 0,
    detail: missingOrChanged.length
      ? `missing/changed: ${missingOrChanged.map(migration => migration.version).join(', ')}`
      : `${expectedMigrations.length}/${expectedMigrations.length} applied with matching checksums`
  })
  const routingUnits = await pool.query<{ id: string }>(
    'SELECT id FROM routing_unit WHERE is_active=TRUE'
  )
  results.push({
    check: 'active routing units',
    ok: routingUnits.rows.length >= 1,
    detail: `${routingUnits.rows.length} active`
  })
  const admins = await findActiveAdminAccounts(pool)
  results.push({
    check: 'active Admin',
    ok: admins.length >= 1,
    detail: `${admins.length} active ADMIN account(s)`
  })
  const units = await pool.query<{ id:string,kind:'HR'|'ORG'|'AUTH',routingUnitId:string|null,managerId:string|null }>(
    `SELECT ou.id,ou.kind,ou.routing_unit_id AS "routingUnitId",uma.id AS "managerId"
       FROM operational_unit ou
       LEFT JOIN unit_manager_assignment uma ON uma.unit_id=ou.id AND uma.effective_to IS NULL
      WHERE ou.is_active=TRUE`
  )
  const hr=units.rows.filter(unit=>unit.kind==='HR')
  const org=units.rows.filter(unit=>unit.kind==='ORG')
  const authByRouting=new Map(units.rows.filter(unit=>unit.kind==='AUTH'&&unit.routingUnitId).map(unit=>[unit.routingUnitId!,unit]))
  results.push({
    check: 'operational hierarchy',
    ok: hr.length===1&&org.length===1&&routingUnits.rows.every(unit=>authByRouting.has(unit.id))&&units.rows.every(unit=>Boolean(unit.managerId)),
    detail: `HR ${hr.length}/1, ORG ${org.length}/1, AUTH ${authByRouting.size}/${routingUnits.rows.length}, managers ${units.rows.filter(unit=>unit.managerId).length}/${units.rows.length}`
  })
  const batches = await pool.query<{ snapshotYear: number }>(
    "SELECT snapshot_year AS \"snapshotYear\" FROM import_batch WHERE status='ACTIVATED'"
  )
  const expectedYear = Number(process.env.EGAS_ACTIVE_SNAPSHOT_YEAR)
  const snapshotOk = Number.isInteger(expectedYear)
    ? batches.rows.some(batch => batch.snapshotYear === expectedYear)
    : batches.rows.length >= 1
  results.push({
    check: 'active annual snapshot',
    ok: snapshotOk,
    detail: batches.rows.length
      ? `active year(s): ${batches.rows.map(batch => batch.snapshotYear).join(', ')}`
      : 'none activated'
  })
  return results
}

async function main(): Promise<void> {
  const results = await runPilotChecks()
  console.table(results)
  if (results.some(result => !result.ok)) process.exitCode = 1
}

await runCli(main, closePool, 'Pilot preflight failed')
