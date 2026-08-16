import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Pool, PoolClient } from 'pg'

export type Migration = { version: string, sha256: string, sql: string }
export type AppliedMigration = { version: string, sha256: string }

export function isMigrationFilename(file: string): boolean {
  if (!file.toLowerCase().endsWith('.sql')) return false
  const versionLength = file.length - '.sql'.length
  if (versionLength === 0) return false
  let leadingDigits = 0
  for (let index = 0; index < versionLength; index += 1) {
    const code = file.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    if (index === leadingDigits && digit) {
      leadingDigits += 1
      continue
    }
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    if (leadingDigits === 0 || (!digit && !letter && code !== 45 && code !== 95)) return false
  }
  return leadingDigits > 0
}

export async function loadMigrations(directory = new URL('./migrations/', import.meta.url)): Promise<Migration[]> {
  const files = (await readdir(directory))
    .filter(isMigrationFilename)
    .sort((left, right) => left.localeCompare(right))
  return await Promise.all(files.map(async file => {
    const sql = await readFile(new URL(file, directory), 'utf8')
    return {
      version: path.basename(file, '.sql'),
      sha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
      sql
    }
  }))
}

export async function executeFullPostgresScript(client: Pick<PoolClient, 'query'>, sql: string): Promise<void> {
  if (sql.trim()) await client.query(sql)
}

export async function applyMigration(
  client: Pick<PoolClient, 'query'>,
  migration: Migration
): Promise<'applied' | 'already-applied'> {
  const result = await client.query<AppliedMigration>(
    'SELECT version, sha256 FROM egas_schemamigration WHERE version=$1', [migration.version]
  )
  const applied = result.rows[0]
  if (applied) {
    if (applied.sha256 !== migration.sha256) {
      throw new Error(`Applied migration ${migration.version} has changed; create a new migration instead`)
    }
    return 'already-applied'
  }
  await executeFullPostgresScript(client, migration.sql)
  await client.query(
    'INSERT INTO egas_schemamigration (version,sha256,appliedat) VALUES ($1,$2,CURRENT_TIMESTAMP)',
    [migration.version, migration.sha256]
  )
  return 'applied'
}

const REQUIRED_TABLES = [
  'egas_schemamigration','egas_routingunit','egas_jobcategoryreference',
  'egas_qualificationstatusreference','egas_useraccount','egas_useraccountrole',
  'egas_authsession','egas_authloginattempt','egas_importbatch','egas_employeeimportstagingrow',
  'egas_employee','egas_employeeannualsnapshot','egas_routingunitsourcealias',
  'egas_approvingauthorityassignment','egas_authoritydelegation','egas_usersignatureasset',
  'egas_workflowrequest','egas_requestformsection','egas_requestcandidate',
  'egas_secondmentpositionoption','egas_workflowiteration','egas_stagetask',
  'egas_stagereceivedsnapshot','egas_promotiondecision','egas_stageaction',
  'egas_workflownote','egas_workflowsignoff','egas_securityevent','egas_notification',
  'egas_auditevent','egas_pdfgenerationlog'
]

export async function migrateDatabase(pool: Pool): Promise<Array<{ version: string, result: string }>> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('egas_schema_migrations'))")
    const legacy = await client.query<{ legacy: string | null, current: string | null }>(
      `SELECT to_regclass('egas.routing_unit')::text AS legacy,
              to_regclass('public.egas_routingunit')::text AS current`
    )
    const state = legacy.rows[0]
    if (state?.legacy && !state.current) {
      throw new Error('The frozen handwritten egas.routing_unit schema exists without the application schema; migration is blocked')
    }
    if (state?.legacy && state.current) {
      throw new Error('Both handwritten egas.* and application egas_* schemas exist; migration is blocked')
    }
    if (!state?.current) {
      const baseline = await readFile(new URL('./baseline/000_existing_cap_schema.sql', import.meta.url), 'utf8')
      await executeFullPostgresScript(client, baseline)
    } else {
      const tables = await client.query<{ name: string, present: string | null }>(
        `SELECT name, to_regclass('public.' || name)::text AS present FROM unnest($1::text[]) AS name`,
        [REQUIRED_TABLES]
      )
      const missing = tables.rows.filter(row => !row.present).map(row => row.name)
      if (missing.length) throw new Error(`Existing EGAS schema is incomplete; missing: ${missing.join(', ')}`)
    }
    const results = []
    for (const migration of await loadMigrations()) {
      results.push({ version: migration.version, result: await applyMigration(client, migration) })
    }
    await client.query('COMMIT')
    return results
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally {
    client.release()
  }
}
