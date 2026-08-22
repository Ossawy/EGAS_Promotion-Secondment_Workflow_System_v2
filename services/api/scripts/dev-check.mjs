import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import {
  LOCAL_DATABASE,
  LOCAL_OWNER,
  LOCAL_RUNTIME,
  accountsFile,
  assertDependenciesInstalled,
  assertSupportedNode,
  checkPort,
  exists,
  loadLocalState,
  pdfDirectory,
  signatureDirectory,
  verifyPostgres,
  verifyWritableDirectory
} from './local-dev-lib.mjs'

function result(name, ok, detail, action = null) { return { name, ok, detail, action } }

export async function runDevChecks({ ports = true } = {}) {
  const checks = []
  try {
    const major = assertSupportedNode()
    checks.push(result('Node version supported', true, `Node ${process.versions.node} (major ${major})`))
  } catch (error) { checks.push(result('Node version supported', false, error.message, 'Install Node.js 22 LTS or newer.')) }
  try {
    await assertDependenciesInstalled()
    checks.push(result('Repository dependencies installed', true, 'required workspace packages found'))
  } catch (error) { checks.push(result('Repository dependencies installed', false, error.message, 'Run npm ci.')) }

  let state
  try {
    state = await loadLocalState()
    if (!state) throw new Error('services/api/.env and .egas-local setup files are required')
    checks.push(result('Local configuration present', true, 'existing files will be reused'))
    checks.push(result('Owner/runtime separation', state.ownerConnection.user === LOCAL_OWNER && state.runtimeConnection.user === LOCAL_RUNTIME && state.ownerConnection.user !== state.runtimeConnection.user,
      `${state.ownerConnection.user} migrations; ${state.runtimeConnection.user} application runtime`))
  } catch (error) {
    checks.push(result('Local configuration present', false, error.message, 'Run npm run dev:setup.'))
    return checks
  }

  const runtimePool = new Pool(state.runtimeConnection)
  const ownerPool = new Pool(state.ownerConnection)
  try {
    try {
      const ownerServer = await verifyPostgres(ownerPool)
      checks.push(result('Migration-owner connection works', ownerServer.username === LOCAL_OWNER && ownerServer.database === LOCAL_DATABASE, `${ownerServer.username} on ${ownerServer.database}`))
    } catch (error) {
      checks.push(result('Migration-owner connection works', false, error.message, 'Verify .egas-local/migration.env; do not substitute runtime or superuser credentials.'))
    }
    try {
      const server = await verifyPostgres(runtimePool)
      checks.push(result('PostgreSQL reachable', true, `PostgreSQL ${Math.floor(server.version / 10000)} at ${state.runtimeConnection.host}:${state.runtimeConnection.port}`))
      checks.push(result('Runtime role works', server.username === LOCAL_RUNTIME && server.database === LOCAL_DATABASE, `${server.username} on ${server.database}`))
      const owner = await runtimePool.query(`SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()`)
      checks.push(result('Migration owner owns database', owner.rows[0]?.owner === LOCAL_OWNER, owner.rows[0]?.owner ?? 'owner unavailable'))
    } catch (error) {
      checks.push(result('PostgreSQL reachable', false, error.message, 'Start PostgreSQL and verify services/api/.env.'))
      return checks
    }

    try {
      const { runPilotChecks } = await import('../dist/scripts/pilot-check.js')
      const pilot = await runPilotChecks()
      const labels = new Map([
        ['current v5 migrations', 'Current migrations'],
        ['active Admin', 'Active Admin exists'],
        ['operational hierarchy', 'HR/ORG/AUTH hierarchy ready'],
        ['active annual snapshot', 'Active annual snapshot exists'],
        ['active routing units', 'Routing units ready']
      ])
      for (const item of pilot.filter(item => labels.has(item.check))) {
        checks.push(result(labels.get(item.check), item.ok, item.detail, item.ok ? null : 'Run npm run dev:setup to repair missing local seed/migrations.'))
      }
    } catch (error) {
      checks.push(result('Domain readiness', false, error.message, 'Run npm run dev:setup.'))
    }
  } finally {
    await Promise.all([runtimePool.end(), ownerPool.end()])
    const { closePool } = await import('../dist/db/pool.js')
    await closePool()
  }

  checks.push(result('Synthetic credentials present', await exists(accountsFile), accountsFile, 'Run npm run dev:seed.'))
  for (const [name, directory] of [['Signature storage writable', signatureDirectory], ['PDF storage writable', pdfDirectory]]) {
    try { await verifyWritableDirectory(directory); checks.push(result(name, true, directory)) }
    catch (error) { checks.push(result(name, false, error.message, `Grant write access to ${directory}.`)) }
  }
  if (ports) {
    for (const port of [4004, 5173]) {
      const probe = await checkPort(port)
      checks.push(result(`Port ${port} available`, probe.available, probe.available ? 'available' : 'already in use', probe.available ? null : `Stop the process using port ${port} before starting EGAS.`))
    }
  }
  return checks
}

export function printDevChecks(checks) {
  for (const check of checks) {
    console.info(`${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
    if (!check.ok && check.action) console.info(`  ${check.action}`)
  }
}

async function main() {
  const checks = await runDevChecks()
  printDevChecks(checks)
  if (checks.some(check => !check.ok)) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(`Local check failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
}
