import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { DataType, newDb } from 'pg-mem'
import type { Pool } from 'pg'
import type { AppConfig } from '../../src/config/env.ts'
import { LocalAuthenticationProvider } from '../../src/modules/auth/local-authentication-provider.ts'
import { SignatureService as AssetService } from '../../src/modules/signatures/signature-service.ts'
import { PromotionWorkflowService } from '../../src/modules/workflow/promotion-workflow-service.ts'
import { SecondmentWorkflowService } from '../../src/modules/workflow/secondment-workflow-service.ts'
import { WorkflowEngineService } from '../../src/modules/workflow/workflow-engine-service.ts'
import type { WorkflowRequestContext } from '../../src/modules/workflow/workflow-types.ts'

export const phase6Password = 'Password123!'

export type Phase6User = WorkflowRequestContext & { jobTitle: string | null }

export type Phase6Fixture = {
  pool: Pool
  config: AppConfig
  engine: WorkflowEngineService
  assets: AssetService
  promotion: PromotionWorkflowService
  secondment: SecondmentWorkflowService
  routingUnitId: string
  units: { hr: string, org: string, auth: string, otherAuth: string }
  users: {
    hrManager: Phase6User
    hrSubordinate: Phase6User
    orgManager: Phase6User
    orgSubordinate: Phase6User
    authManager: Phase6User
    authSubordinate: Phase6User
    otherAuthManager: Phase6User
    admin: Phase6User
    outsider: Phase6User
  }
  createUser: (username: string, accountType?: 'OPERATIONAL' | 'ADMIN', jobTitle?: string | null) => Promise<Phase6User>
  addMembership: (userId: string, unitId: string) => Promise<void>
  replaceManager: (unitId: string, userId: string) => Promise<string>
  image: (format?: 'png' | 'jpeg', width?: number, height?: number) => Promise<Buffer>
  upload: (user: Phase6User, format?: 'png' | 'jpeg') => Promise<Record<string, unknown>>
  prepareSecondment: (stageExecutionId: string, candidateId: string, user?: Phase6User) => Promise<unknown>
  createRequest: (requestType: 'PROMOTION' | 'SECONDMENT') => Promise<{ requestId: string, stageExecutionId: string, candidateId: string }>
  sign: (stageExecutionId: string, user: Phase6User, assetId: string, password?: string, jobTitleOverride?: string | null) => Promise<unknown>
  currentExecution: (requestId: string) => Promise<{ id: string, stageCode: string }>
  cleanup: () => Promise<void>
}

export async function createPhase6Fixture(): Promise<Phase6Fixture> {
  const db = newDb({ autoCreateForeignKeyIndices: true })
  db.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 1 })
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 })
  const initialSchema = await readFile(new URL('../../src/db/migrations/001_initial_v5_schema.sql', import.meta.url), 'utf8')
  const productionFrozenPdfTable = 'CREATE TABLE frozen_pdf_document (id uuid PRIMARY KEY, final_form_snapshot_id uuid NOT NULL REFERENCES final_form_snapshot(id), storage_key text NOT NULL UNIQUE, sha256 char(64) NOT NULL, byte_size integer NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);'
  const pgMemFrozenPdfTable = 'CREATE TABLE frozen_pdf_document (id uuid PRIMARY KEY, final_form_snapshot_id uuid NOT NULL UNIQUE REFERENCES final_form_snapshot(id), storage_key text NOT NULL UNIQUE, sha256 char(64) NOT NULL, byte_size integer NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);'
  const fixtureSchema = initialSchema.replace(productionFrozenPdfTable, pgMemFrozenPdfTable)
  if (fixtureSchema === initialSchema || !fixtureSchema.includes('final_form_snapshot_id uuid NOT NULL UNIQUE REFERENCES final_form_snapshot(id)')) {
    throw new Error('Phase 6 fixture could not install the frozen PDF uniqueness constraint')
  }
  db.public.none(fixtureSchema)
  db.public.none(await readFile(new URL('../../src/db/migrations/002_phase2_annual_data_integrity.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../../src/db/migrations/003_phase3_workflow_indexes.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../../src/db/migrations/004_phase6_frozen_pdf_uniqueness.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../../src/db/migrations/005_audit_identity_snapshots.sql', import.meta.url), 'utf8'))
  const pool = new (db.adapters.createPg().Pool)() as unknown as Pool
  const probeRequestId = randomUUID()
  const probeIterationId = randomUUID()
  const probeSnapshotId = randomUUID()
  const probeDocumentId = randomUUID()
  const probeContenderId = randomUUID()
  try {
    await pool.query(
      `INSERT INTO workflow_request (id, request_number, request_type, status)
       VALUES ($1, $2, 'PROMOTION', 'COMPLETED')`,
      [probeRequestId, `PGMEM-PROBE-${probeRequestId}`]
    )
    await pool.query(
      `INSERT INTO workflow_iteration (id, request_id, iteration_no, status)
       VALUES ($1, $2, 1, 'COMPLETED')`,
      [probeIterationId, probeRequestId]
    )
    await pool.query(
      `INSERT INTO final_form_snapshot (id, request_id, iteration_id, template_version, payload, sha256)
       VALUES ($1, $2, $3, 'PGMEM-PROBE', $4::jsonb, $5)`,
      [probeSnapshotId, probeRequestId, probeIterationId, JSON.stringify({ probe: true }), '0'.repeat(64)]
    )
    const first = await pool.query(
      `INSERT INTO frozen_pdf_document (id, final_form_snapshot_id, storage_key, sha256, byte_size, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (final_form_snapshot_id) DO NOTHING`,
      [probeDocumentId, probeSnapshotId, `${probeDocumentId}.pdf`, '1'.repeat(64), 1]
    )
    await pool.query(
      `INSERT INTO frozen_pdf_document (id, final_form_snapshot_id, storage_key, sha256, byte_size, created_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (final_form_snapshot_id) DO NOTHING`,
      [probeContenderId, probeSnapshotId, `${probeContenderId}.pdf`, '2'.repeat(64), 1]
    )
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS "count" FROM frozen_pdf_document WHERE final_form_snapshot_id=$1',
      [probeSnapshotId]
    )
    const retained = await pool.query<{ id: string, storageKey: string }>(
      'SELECT id, storage_key AS "storageKey" FROM frozen_pdf_document WHERE final_form_snapshot_id=$1',
      [probeSnapshotId]
    )
    if (
      first.rowCount !== 1 ||
      Number(count.rows[0]?.count) !== 1 ||
      retained.rows.length !== 1 ||
      retained.rows[0]?.id !== probeDocumentId ||
      retained.rows[0]?.storageKey !== `${probeDocumentId}.pdf`
    ) {
      throw new Error('Phase 6 fixture frozen PDF ON CONFLICT invariant is not enforced')
    }
  } finally {
    await pool.query('DELETE FROM frozen_pdf_document WHERE final_form_snapshot_id=$1', [probeSnapshotId])
    await pool.query('DELETE FROM final_form_snapshot WHERE id=$1', [probeSnapshotId])
    await pool.query('DELETE FROM workflow_iteration WHERE id=$1', [probeIterationId])
    await pool.query('DELETE FROM workflow_request WHERE id=$1', [probeRequestId])
  }
  const root = await mkdtemp(join(tmpdir(), 'egas-phase6-'))
  const config: AppConfig = {
    nodeEnv: 'test', port: 4004,
    database: { host: 'isolated', port: 5432, database: 'isolated', user: 'isolated', password: 'isolated', ssl: false },
    auth: { fingerprintSecret: 'synthetic-test-fingerprint-secret-32', sessionCookieName: 'EGAS_SESSION', csrfCookieName: 'EGAS_CSRF', idleMinutes: 30, absoluteHours: 8, loginWindowMinutes: 10, loginFailureLimit: 3, lockoutMinutes: 15, requireSecureCookie: false, allowedOrigins: new Set() },
    signatures: { storageDirectory: join(root, 'signatures'), maxUploadBytes: 100_000, maxWidthPixels: 100, maxHeightPixels: 100, maxPixels: 10_000 },
    pdf: { storageDirectory: join(root, 'pdf'), maxConcurrentRenders: 2, maxQueuedRenders: 2, renderTimeoutMs: 50, maxOutputBytes: 1_000_000 }
  }
  const auth = new LocalAuthenticationProvider(pool, config)
  const createUser = async (username: string, accountType: 'OPERATIONAL' | 'ADMIN' = 'OPERATIONAL', jobTitle: string | null = 'مدير') => {
    const user: Phase6User = { userId: randomUUID(), username, jobTitle }
    await pool.query(`INSERT INTO user_account (id,username,display_name,job_title,account_type,password_hash,must_change_password,is_active)
      VALUES ($1,$2,$3,$4,$5,$6,FALSE,TRUE)`, [user.userId, username, username, jobTitle, accountType, await auth.hashPassword(phase6Password)])
    return user
  }
  const addMembership = async (userId: string, unitId: string) => {
    await pool.query(`INSERT INTO user_unit_membership (id,user_id,unit_id,effective_from,created_by_user_id)
      VALUES ($1,$2,$3,CURRENT_TIMESTAMP,$2)`, [randomUUID(), userId, unitId])
  }
  const replaceManager = async (unitId: string, userId: string) => {
    await pool.query(`UPDATE unit_manager_assignment SET effective_to=CURRENT_TIMESTAMP WHERE unit_id=$1 AND effective_to IS NULL`, [unitId])
    const id = randomUUID()
    await pool.query(`INSERT INTO unit_manager_assignment (id,unit_id,manager_user_id,effective_from,assigned_by_user_id)
      VALUES ($1,$2,$3,CURRENT_TIMESTAMP,$3)`, [id, unitId, userId])
    return id
  }
  const routingUnitId = randomUUID()
  const otherRoutingUnitId = randomUUID()
  const units = { hr: randomUUID(), org: randomUUID(), auth: randomUUID(), otherAuth: randomUUID() }
  await pool.query(`INSERT INTO routing_unit (id,code,name_ar,is_active) VALUES ($1,'RU-1','نيابة الاختبار',TRUE),($2,'RU-2','نيابة أخرى',TRUE)`, [routingUnitId, otherRoutingUnitId])
  await pool.query(`INSERT INTO operational_unit (id,kind,name,is_active) VALUES ($1,'HR','الموارد البشرية',TRUE),($2,'ORG','التنظيم',TRUE)`, [units.hr, units.org])
  await pool.query(`INSERT INTO operational_unit (id,kind,name,routing_unit_id,is_active) VALUES ($1,'AUTH','النيابة المختصة',$2,TRUE),($3,'AUTH','نيابة أخرى',$4,TRUE)`, [units.auth, routingUnitId, units.otherAuth, otherRoutingUnitId])
  const users = {
    hrManager: await createUser('hr.manager', 'OPERATIONAL', 'مدير الموارد البشرية'),
    hrSubordinate: await createUser('hr.subordinate', 'OPERATIONAL', 'باحث موارد بشرية'),
    orgManager: await createUser('org.manager', 'OPERATIONAL', 'مدير التنظيم'),
    orgSubordinate: await createUser('org.subordinate', 'OPERATIONAL', 'باحث تنظيم'),
    authManager: await createUser('auth.manager', 'OPERATIONAL', 'مدير النيابة'),
    authSubordinate: await createUser('auth.subordinate', 'OPERATIONAL', 'باحث نيابة'),
    otherAuthManager: await createUser('other.auth.manager', 'OPERATIONAL', 'مدير نيابة أخرى'),
    admin: await createUser('admin', 'ADMIN', 'مدير النظام'),
    outsider: await createUser('outsider', 'OPERATIONAL', 'مستخدم خارجي')
  }
  for (const [user, unit] of [[users.hrManager, units.hr], [users.hrSubordinate, units.hr], [users.orgManager, units.org], [users.orgSubordinate, units.org], [users.authManager, units.auth], [users.authSubordinate, units.auth], [users.otherAuthManager, units.otherAuth]] as const) await addMembership(user.userId, unit)
  for (const [unit, user] of [[units.hr, users.hrManager], [units.org, users.orgManager], [units.auth, users.authManager], [units.otherAuth, users.otherAuthManager]] as const) await replaceManager(unit, user.userId)
  const batchId = randomUUID(); const employeeId = randomUUID(); const snapshotId = randomUUID()
  await pool.query(`INSERT INTO import_batch (id,snapshot_year,source_filename,source_sha256,detected_headers,status,row_count,activated_at)
    VALUES ($1,2026,'synthetic.xlsx',$2,'[]'::jsonb,'ACTIVATED',1,CURRENT_TIMESTAMP)`, [batchId, '0'.repeat(64)])
  await pool.query(`INSERT INTO employee (id,personnel_number) VALUES ($1,'10001')`, [employeeId])
  await pool.query(`INSERT INTO employee_annual_snapshot (id,employee_id,import_batch_id,snapshot_year,personnel_number,routing_unit_id,employee_data)
    VALUES ($1,$2,$3,2026,'10001',$4,$5::jsonb)`, [snapshotId, employeeId, batchId, routingUnitId, JSON.stringify({
      employeeName: 'مرشح تجريبي', currentJobTitle: 'أخصائي أول', sourceRoutingLabel: 'نيابة الاختبار', subgroup: 'إدارية',
      originalQualificationCertificate: 'بكالوريوس تجارة', originalQualificationSource: 'جامعة القاهرة', originalQualificationDate: '2010-06-01',
      currentJobStartDate: '2020-01-01', experienceYears: 12, experienceMonths: 3, experienceDays: 4, experienceReferenceDate: '2026-01-01', performanceRating: 'ممتاز', lastPromotionReport: 'ممتاز'
    })])
  await pool.query(`INSERT INTO qualification_status_reference (id,code,name,is_active) VALUES ($1,'QUALIFIED','مستوفٍ',TRUE)`, [randomUUID()])
  await pool.query(`INSERT INTO job_category_reference (id,code,name,is_active) VALUES ($1,'MANAGER','وظيفة مدير إدارة :-',TRUE)`, [randomUUID()])
  const engine = new WorkflowEngineService(pool, config)
  const assets = new AssetService(pool, config)
  const promotion = new PromotionWorkflowService(pool)
  const secondment = new SecondmentWorkflowService(pool)
  const image = async (format: 'png' | 'jpeg' = 'png', width = 20, height = 20) => {
    const source = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 80, b: 40, alpha: 1 } } })
    return format === 'png' ? await source.png().toBuffer() : await source.jpeg().toBuffer()
  }
  const upload = async (user: Phase6User, format: 'png' | 'jpeg' = 'png') => await assets.uploadSignature(user.userId, await image(format), `image/${format}`)
  const prepareSecondment = async (stageExecutionId: string, candidateId: string, user: Phase6User = users.orgManager) => await secondment.upsertS2CandidatePreparation(
    stageExecutionId,
    candidateId,
    { lastPromotionReport: 'تقرير آخر ترقية مجمد', jobCategoryCode: 'MANAGER' },
    user
  )
  const createRequest = async (requestType: 'PROMOTION' | 'SECONDMENT') => {
    const request = await engine.createRequest({ requestType, routingUnitId }, users.hrManager)
    const candidate = await engine.addCandidate(request.id, { personnelNumber: '10001' }, users.hrManager)
    return { requestId: request.id, stageExecutionId: request.currentExecutionId!, candidateId: candidate.id }
  }
  const sign = async (stageExecutionId: string, user: Phase6User, assetId: string, password = phase6Password, jobTitleOverride?: string | null) => await engine.signAndAdvance(stageExecutionId, {
    password,
    signatureAssetId: assetId,
    ...(jobTitleOverride !== undefined ? { jobTitleOverride } : {})
  }, user)
  const currentExecution = async (requestId: string) => {
    const result = await pool.query<{ id: string, stageCode: string }>(`SELECT se.id,se.stage_code AS "stageCode" FROM stage_execution se JOIN workflow_request r ON r.current_iteration_id=se.iteration_id AND r.current_stage_code=se.stage_code WHERE r.id=$1 AND se.status='OPEN' ORDER BY se.execution_no DESC LIMIT 1`, [requestId])
    return result.rows[0]!
  }
  return { pool, config, engine, assets, promotion, secondment, routingUnitId, units, users, createUser, addMembership, replaceManager, image, upload, prepareSecondment, createRequest, sign, currentExecution, cleanup: async () => {
    await pool.end()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } }
}

export function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
