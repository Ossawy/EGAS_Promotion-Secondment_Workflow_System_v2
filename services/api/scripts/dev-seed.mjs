import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hash } from 'argon2'
import { Pool } from 'pg'
import {
  accountsFile,
  ensureLocalDirectories,
  exists,
  loadLocalState,
  randomSecret,
  workbookDirectory,
  writeExclusive
} from './local-dev-lib.mjs'
import { generateDevWorkbook } from './generate-dev-workbook.mjs'

const routingDefinitions = [
  { key: 'cairo', code: 'DEV-CAIRO', nameAr: 'نيابة القاهرة', nameEn: 'Cairo Synthetic Authority' },
  { key: 'alex', code: 'DEV-ALEX', nameAr: 'نيابة الإسكندرية', nameEn: 'Alexandria Synthetic Authority' },
  { key: 'suez', code: 'DEV-SUEZ', nameAr: 'نيابة السويس', nameEn: 'Suez Synthetic Authority' }
]

const accountDefinitions = [
  { username: 'dev.admin', name: 'مدير النظام التجريبي', title: 'مدير نظام', type: 'ADMIN', unit: null, staff: 'DEV-ADMIN' },
  { username: 'dev.hr.manager', name: 'مدير الموارد البشرية التجريبي', title: 'مدير الموارد البشرية', type: 'OPERATIONAL', unit: 'hr', staff: 'DEV-HR-001', manager: true },
  { username: 'dev.hr.employee1', name: 'أخصائي موارد بشرية تجريبي', title: 'أخصائي موارد بشرية', type: 'OPERATIONAL', unit: 'hr', staff: 'DEV-HR-002' },
  { username: 'dev.hr.employee2', name: 'باحث موارد بشرية تجريبي', title: 'باحث موارد بشرية', type: 'OPERATIONAL', unit: 'hr', staff: 'DEV-HR-003', forceChange: true },
  { username: 'dev.org.manager', name: 'مدير التنظيم التجريبي', title: 'مدير التنظيم', type: 'OPERATIONAL', unit: 'org', staff: 'DEV-ORG-001', manager: true },
  { username: 'dev.org.employee1', name: 'أخصائي تنظيم تجريبي', title: 'أخصائي تنظيم', type: 'OPERATIONAL', unit: 'org', staff: 'DEV-ORG-002' },
  { username: 'dev.org.employee2', name: 'باحث تنظيم تجريبي', title: 'باحث تنظيم', type: 'OPERATIONAL', unit: 'org', staff: 'DEV-ORG-003' },
  ...routingDefinitions.flatMap((routing, index) => [
    { username: `dev.auth.${routing.key}.manager`, name: `مدير ${routing.nameAr} التجريبي`, title: 'مدير سلطة اعتماد', type: 'OPERATIONAL', unit: `auth:${routing.key}`, staff: `DEV-AUTH-${index + 1}01`, manager: true },
    { username: `dev.auth.${routing.key}.employee`, name: `موظف ${routing.nameAr} التجريبي`, title: 'أخصائي سلطة اعتماد', type: 'OPERATIONAL', unit: `auth:${routing.key}`, staff: `DEV-AUTH-${index + 1}02` }
  ])
]

function parseAccounts(text) {
  const credentials = new Map()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error('DEV_ACCOUNTS.txt contains an invalid line')
    credentials.set(line.slice(0, separator), line.slice(separator + 1))
  }
  for (const definition of accountDefinitions) {
    const password = credentials.get(definition.username)
    if (!password || password.length < 16) throw new Error(`Missing local password for ${definition.username}`)
  }
  return credentials
}

async function resolveCredentials(pool) {
  if (await exists(accountsFile)) return parseAccounts(await readFile(accountsFile, 'utf8'))
  const existing = await pool.query(`SELECT username FROM user_account WHERE username = ANY($1::text[])`, [accountDefinitions.map(item => item.username)])
  if (existing.rowCount) {
    throw new Error(`Synthetic accounts already exist but ${accountsFile} is missing. Refusing to rotate their passwords.`)
  }
  const credentials = new Map(accountDefinitions.map(definition => [definition.username, randomSecret(24)]))
  const lines = [
    '# Synthetic EGAS local-development accounts only.',
    '# Keep this file private. dev.hr.employee2 must change its password on first login.',
    ...accountDefinitions.map(definition => `${definition.username}=${credentials.get(definition.username)}`)
  ]
  await writeExclusive(accountsFile, `${lines.join('\n')}\n`)
  return credentials
}

async function seedHierarchy(pool, credentials) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('egas.local-dev.seed'))")

    for (const routing of routingDefinitions) {
      await client.query(
        `INSERT INTO routing_unit (id,code,name_ar,name_en,is_active,created_at,updated_at)
         VALUES ($1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT (code) DO NOTHING`,
        [randomUUID(), routing.code, routing.nameAr, routing.nameEn]
      )
    }
    const routingRows = await client.query(`SELECT id,code,name_ar AS "nameAr" FROM routing_unit WHERE code = ANY($1::text[])`, [routingDefinitions.map(item => item.code)])
    const routingByKey = new Map()
    for (const definition of routingDefinitions) {
      const row = routingRows.rows.find(item => item.code === definition.code)
      if (!row || row.nameAr !== definition.nameAr) throw new Error(`Routing unit ${definition.code} conflicts with local seed data`)
      routingByKey.set(definition.key, row)
    }

    const usersByName = new Map()
    for (const definition of accountDefinitions) {
      const existing = await client.query(`SELECT id,account_type AS "accountType",is_active AS "isActive" FROM user_account WHERE username=$1`, [definition.username])
      if (!existing.rows[0]) {
        const passwordHash = await hash(credentials.get(definition.username), { type: 2 })
        const id = randomUUID()
        await client.query(
          `INSERT INTO user_account
            (id,username,staff_identifier,display_name,job_title,account_type,password_hash,must_change_password,is_active,failed_login_count,created_at,updated_at,version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
          [id, definition.username, definition.staff, definition.name, definition.title, definition.type, passwordHash, Boolean(definition.forceChange)]
        )
        usersByName.set(definition.username, { id, accountType: definition.type, isActive: true })
      } else {
        if (existing.rows[0].accountType !== definition.type || !existing.rows[0].isActive) {
          throw new Error(`Existing account ${definition.username} conflicts with local seed data`)
        }
        usersByName.set(definition.username, existing.rows[0])
      }
    }
    const adminId = usersByName.get('dev.admin').id

    const unitByKey = new Map()
    for (const definition of [
      { key: 'hr', kind: 'HR', name: 'إدارة الموارد البشرية التجريبية', routingId: null },
      { key: 'org', kind: 'ORG', name: 'إدارة التنظيم التجريبية', routingId: null },
      ...routingDefinitions.map(routing => ({ key: `auth:${routing.key}`, kind: 'AUTH', name: `سلطة اعتماد ${routing.nameAr}`, routingId: routingByKey.get(routing.key).id }))
    ]) {
      const existing = await client.query(
        `SELECT id,name FROM operational_unit WHERE kind=$1 AND (($2::uuid IS NULL AND routing_unit_id IS NULL) OR routing_unit_id=$2) AND is_active=TRUE`,
        [definition.kind, definition.routingId]
      )
      if (existing.rows.length > 1) throw new Error(`Multiple active ${definition.key} units exist`)
      if (!existing.rows[0]) {
        const id = randomUUID()
        await client.query(
          `INSERT INTO operational_unit (id,kind,name,routing_unit_id,is_active,created_at,updated_at)
           VALUES ($1,$2,$3,$4,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [id, definition.kind, definition.name, definition.routingId]
        )
        unitByKey.set(definition.key, { id, name: definition.name })
      } else {
        if (existing.rows[0].name !== definition.name) throw new Error(`Existing ${definition.key} unit conflicts with local seed data`)
        unitByKey.set(definition.key, existing.rows[0])
      }
    }

    for (const definition of accountDefinitions.filter(item => item.unit)) {
      const userId = usersByName.get(definition.username).id
      const unitId = unitByKey.get(definition.unit).id
      const membership = await client.query(`SELECT unit_id AS "unitId" FROM user_unit_membership WHERE user_id=$1 AND effective_to IS NULL`, [userId])
      if (!membership.rows[0]) {
        await client.query(
          `INSERT INTO user_unit_membership (id,user_id,unit_id,effective_from,created_by_user_id,created_at)
           VALUES ($1,$2,$3,CURRENT_TIMESTAMP,$4,CURRENT_TIMESTAMP)`,
          [randomUUID(), userId, unitId, adminId]
        )
      } else if (membership.rows[0].unitId !== unitId) {
        throw new Error(`Existing membership for ${definition.username} points to another unit`)
      }
    }

    for (const definition of accountDefinitions.filter(item => item.manager)) {
      const userId = usersByName.get(definition.username).id
      const unitId = unitByKey.get(definition.unit).id
      const assignment = await client.query(`SELECT manager_user_id AS "managerUserId" FROM unit_manager_assignment WHERE unit_id=$1 AND effective_to IS NULL`, [unitId])
      if (!assignment.rows[0]) {
        await client.query(
          `INSERT INTO unit_manager_assignment (id,unit_id,manager_user_id,effective_from,assigned_by_user_id,created_at)
           VALUES ($1,$2,$3,CURRENT_TIMESTAMP,$4,CURRENT_TIMESTAMP)`,
          [randomUUID(), unitId, userId, adminId]
        )
      } else if (assignment.rows[0].managerUserId !== userId) {
        throw new Error(`Existing manager for ${definition.unit} conflicts with local seed data`)
      }
    }

    for (const [code, name] of [['DEV-TECH', 'تخصصي تجريبي'], ['DEV-LEAD', 'قيادي تجريبي']]) {
      await client.query(`INSERT INTO job_category_reference (id,code,name,is_active) VALUES ($1,$2,$3,TRUE) ON CONFLICT (code) DO NOTHING`, [randomUUID(), code, name])
    }
    for (const [code, name] of [['DEV-MATCH', 'مستوفٍ تجريبياً'], ['DEV-REVIEW', 'يتطلب مراجعة تجريبية']]) {
      await client.query(`INSERT INTO qualification_status_reference (id,code,name,is_active) VALUES ($1,$2,$3,TRUE) ON CONFLICT (code) DO NOTHING`, [randomUUID(), code, name])
    }

    await client.query('COMMIT')
    return { routingByKey, usersByName }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally { client.release() }
}

function workbookEmployees() {
  return routingDefinitions.flatMap((routing, routingIndex) => [0, 1, 2].map((offset) => ({
    personnelNumber: `DEV${routingIndex + 1}${String(offset + 1).padStart(3, '0')}`,
    name: `مرشح ${routing.nameAr} التجريبي ${offset + 1}`,
    routingName: routing.nameAr,
    jobTitle: offset === 0 ? 'مهندس تجريبي' : offset === 1 ? 'أخصائي تجريبي' : 'باحث تجريبي',
    subgroup: offset === 0 ? 'هندسي' : 'تخصصي'
  })))
}

async function ensureAnnualSnapshot(pool, year) {
  const active = await pool.query(`SELECT id,row_count AS "rowCount" FROM import_batch WHERE snapshot_year=$1 AND status='ACTIVATED'`, [year])
  if (active.rows.length > 1) throw new Error(`More than one active annual snapshot exists for ${year}`)
  if (active.rows[0]) return { reused: true, batchId: active.rows[0].id, rowCount: Number(active.rows[0].rowCount) }

  const snapshots = await pool.query(`SELECT COUNT(*)::integer AS count FROM employee_annual_snapshot WHERE snapshot_year=$1`, [year])
  if (Number(snapshots.rows[0]?.count ?? 0) > 0) throw new Error(`Immutable annual rows exist for ${year} without an active batch`)

  const { ImportService } = await import('../dist/modules/import/import-service.js')
  const service = new ImportService(pool)
  const actor = await service.operator('dev.admin')
  const validated = await pool.query(`SELECT id FROM import_batch WHERE snapshot_year=$1 AND status='VALIDATED' ORDER BY created_at DESC LIMIT 1`, [year])
  let batchId = validated.rows[0]?.id
  if (!batchId) {
    const workbook = path.join(workbookDirectory, `egas-synthetic-${year}.xlsx`)
    await generateDevWorkbook(workbook, year, routingDefinitions.map(item => ({ nameAr: item.nameAr })), workbookEmployees())
    const staged = await service.stageWorkbook(workbook, year, 'dev.admin', {
      ipAddress: null, userAgent: 'egas-local-dev-seed', correlationId: randomUUID()
    })
    if (staged.blockedRows > 0 || staged.warningRows > 0) {
      throw new Error(`Synthetic workbook must be warning-free (${staged.warningRows} warning, ${staged.blockedRows} blocked)`)
    }
    batchId = staged.id
  }
  const activated = await service.activate(batchId, actor, {
    ipAddress: null, userAgent: 'egas-local-dev-seed', correlationId: randomUUID()
  })
  return { reused: false, batchId: activated.id, rowCount: activated.rowCount }
}

export async function runLocalSeed() {
  await ensureLocalDirectories()
  const state = await loadLocalState()
  if (!state) throw new Error('Local setup is missing. Run npm run dev:setup first.')
  const year = Number(state.runtime.EGAS_ACTIVE_SNAPSHOT_YEAR)
  if (!Number.isInteger(year)) throw new Error('EGAS_ACTIVE_SNAPSHOT_YEAR is missing from services/api/.env')
  const pool = new Pool(state.runtimeConnection)
  try {
    const credentials = await resolveCredentials(pool)
    await seedHierarchy(pool, credentials)
    const snapshot = await ensureAnnualSnapshot(pool, year)
    const counts = await pool.query(`SELECT
      (SELECT COUNT(*)::integer FROM user_account WHERE username LIKE 'dev.%') AS users,
      (SELECT COUNT(*)::integer FROM operational_unit WHERE is_active=TRUE) AS units,
      (SELECT COUNT(*)::integer FROM unit_manager_assignment WHERE effective_to IS NULL) AS managers,
      (SELECT COUNT(*)::integer FROM routing_unit WHERE code LIKE 'DEV-%') AS routing_units,
      (SELECT COUNT(*)::integer FROM employee_annual_snapshot WHERE snapshot_year=$1) AS snapshots`, [year])
    return { ...counts.rows[0], snapshot }
  } finally { await pool.end() }
}

async function main() {
  const result = await runLocalSeed()
  console.info(`Synthetic data ready: ${result.users} users, ${result.units} units, ${result.managers} managers, ${result.routing_units} routing units, ${result.snapshots} annual employees.`)
  console.info(result.snapshot.reused ? `Active annual snapshot reused (${result.snapshot.batchId}).` : `Active annual snapshot created (${result.snapshot.batchId}).`)
  console.info(`Development credentials: ${accountsFile}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(`Local seed failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
}

