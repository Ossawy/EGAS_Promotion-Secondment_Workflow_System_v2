import { loadConfig } from '../config/env.js'
import { closePool, getPool } from '../db/pool.js'
import { findActivePrivilegedAdminAccounts } from '../db/repositories/pilot-repository.js'
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
  const routingUnits = await pool.query<{ id: string }>(
    'SELECT id FROM egas_routingunit WHERE isactive = TRUE'
  )
  results.push({
    check: 'active routing units',
    ok: routingUnits.rows.length === 22,
    detail: `${routingUnits.rows.length}/22 active`
  })
  const admins = await findActivePrivilegedAdminAccounts(pool)
  results.push({
    check: 'privileged Admin',
    ok: admins.length >= 1,
    detail: `${admins.length} active Manage-Admins account(s)`
  })
  const assignments = await pool.query<{ routingunit_id: string }>(
    `SELECT routingunit_id
       FROM egas_approvingauthorityassignment
      WHERE isprimary = TRUE AND isactive = TRUE`
  )
  const covered = new Set(assignments.rows.map(row => row.routingunit_id))
  results.push({
    check: 'authority coverage',
    ok: routingUnits.rows.every(unit => covered.has(unit.id)),
    detail: `${covered.size}/${routingUnits.rows.length} active routing units covered`
  })
  const batches = await pool.query<{ snapshotyear: number }>(
    "SELECT snapshotyear FROM egas_importbatch WHERE status = 'ACTIVATED'"
  )
  const expectedYear = Number(process.env.EGAS_ACTIVE_SNAPSHOT_YEAR)
  const snapshotOk = Number.isInteger(expectedYear)
    ? batches.rows.some(batch => batch.snapshotyear === expectedYear)
    : batches.rows.length >= 1
  results.push({
    check: 'active annual snapshot',
    ok: snapshotOk,
    detail: batches.rows.length
      ? `active year(s): ${batches.rows.map(batch => batch.snapshotyear).join(', ')}`
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
