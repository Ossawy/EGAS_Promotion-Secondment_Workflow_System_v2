import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import {
  LOCAL_OWNER,
  LOCAL_RUNTIME,
  loadLocalState,
  quoteFixedIdentifier,
  verifyPostgres
} from './local-dev-lib.mjs'

export async function grantRuntimePrivileges(pool) {
  const runtime = quoteFixedIdentifier(LOCAL_RUNTIME)
  await pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
  await pool.query(`REVOKE CREATE ON SCHEMA public FROM ${runtime}`)
  await pool.query(`GRANT CONNECT ON DATABASE ${quoteFixedIdentifier('egas_workflow_dev')} TO ${runtime}`)
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${runtime}`)
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`)
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`)
  await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${runtime}`)
  await pool.query(`REVOKE INSERT, UPDATE, DELETE ON schema_migration FROM ${runtime}`)
  await pool.query(`REVOKE UPDATE, DELETE ON audit_event, security_event, auth_login_attempt, stage_action, workflow_note, stage_submission_snapshot, workflow_signoff, final_form_snapshot, frozen_pdf_document, employee_annual_snapshot, pdf_generation_log FROM ${runtime}`)
  await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteFixedIdentifier(LOCAL_OWNER)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`)
  await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteFixedIdentifier(LOCAL_OWNER)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`)
  await pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteFixedIdentifier(LOCAL_OWNER)} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${runtime}`)
}

export async function runLocalMigrations() {
  const state = await loadLocalState()
  if (!state) throw new Error('Local setup is missing. Run npm run dev:setup first.')
  const pool = new Pool(state.ownerConnection)
  try {
    const server = await verifyPostgres(pool)
    if (server.username !== LOCAL_OWNER) throw new Error(`Local migrations require ${LOCAL_OWNER}, not ${server.username}`)
    const { migrateDatabase } = await import('../dist/db/migration-runner.js')
    const results = await migrateDatabase(pool)
    await grantRuntimePrivileges(pool)
    return results
  } finally { await pool.end() }
}

async function main() {
  const results = await runLocalMigrations()
  for (const migration of results) console.info(`Migration ${migration.version}: ${migration.result}`)
  console.info(`Runtime grants verified for ${LOCAL_RUNTIME}; the API remains non-owner.`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(`Local migration failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
