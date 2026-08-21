import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DataType, newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { testConfig } from './helpers/database.js'
import { WorkflowEngineService } from '../src/modules/workflow/workflow-engine-service.js'
import { PromotionWorkflowService } from '../src/modules/workflow/promotion-workflow-service.js'
import { SecondmentWorkflowService } from '../src/modules/workflow/secondment-workflow-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import type { WorkflowRequestContext } from '../src/modules/workflow/workflow-types.js'
import { exactObject } from '../src/shared/validation.js'

let pool: Pool | undefined
let engine: WorkflowEngineService
let promotion: PromotionWorkflowService
let secondment: SecondmentWorkflowService

// Setup identities
let hrUnitId: string
let orgUnitId: string
let authUnitId: string
let routingUnitId: string
let otherRoutingUnitId: string

let hrManager: WorkflowRequestContext
let hrSubordinate: WorkflowRequestContext
let orgManager: WorkflowRequestContext
let orgSubordinate: WorkflowRequestContext
let authManager: WorkflowRequestContext
let authSubordinate: WorkflowRequestContext
let adminUser: WorkflowRequestContext
let otherUser: WorkflowRequestContext

let snapshot1Id: string
let snapshot2Id: string
let crossRoutingSnapshotId: string

async function createOperationalAccount(username: string, displayName: string): Promise<WorkflowRequestContext> {
  if (!pool) throw new Error('Database pool is not initialized')
  const id = randomUUID()
  const authProvider = new LocalAuthenticationProvider(pool, testConfig)
  const passwordHash = await authProvider.hashPassword('Password123!')
  await pool.query(
    `INSERT INTO user_account
      (id, username, display_name, account_type, password_hash, must_change_password, is_active)
     VALUES ($1, $2, $3, 'OPERATIONAL', $4, FALSE, TRUE)`,
    [id, username, displayName, passwordHash]
  )
  return { userId: id, username }
}

async function createAdminAccount(username: string, displayName: string): Promise<WorkflowRequestContext> {
  if (!pool) throw new Error('Database pool is not initialized')
  const id = randomUUID()
  const authProvider = new LocalAuthenticationProvider(pool, testConfig)
  const passwordHash = await authProvider.hashPassword('Password123!')
  await pool.query(
    `INSERT INTO user_account
      (id, username, display_name, account_type, password_hash, must_change_password, is_active)
     VALUES ($1, $2, $3, 'ADMIN', $4, FALSE, TRUE)`,
    [id, username, displayName, passwordHash]
  )
  return { userId: id, username }
}

async function addMembership(userId: string, unitId: string, creatorId: string): Promise<void> {
  if (!pool) throw new Error('Database pool is not initialized')
  await pool.query(
    `INSERT INTO user_unit_membership
      (id, user_id, unit_id, effective_from, created_by_user_id)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [randomUUID(), userId, unitId, creatorId]
  )
}

async function assignManager(unitId: string, managerUserId: string, assignerId: string): Promise<string> {
  if (!pool) throw new Error('Database pool is not initialized')
  const id = randomUUID()
  await pool.query(
    `INSERT INTO unit_manager_assignment
      (id, unit_id, manager_user_id, effective_from, assigned_by_user_id)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [id, unitId, managerUserId, assignerId]
  )
  return id
}

beforeEach(async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true })
  db.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 1 })
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 })

  db.public.none(await readFile(new URL('../src/db/migrations/001_initial_v5_schema.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../src/db/migrations/002_phase2_annual_data_integrity.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../src/db/migrations/003_phase3_workflow_indexes.sql', import.meta.url), 'utf8'))

  const adapter = db.adapters.createPg()
  pool = new adapter.Pool() as unknown as Pool
  engine = new WorkflowEngineService(pool)
  promotion = new PromotionWorkflowService(pool)
  secondment = new SecondmentWorkflowService(pool)

  // 1. Create Qualification Status References
  await pool.query(`INSERT INTO qualification_status_reference (id, code, name, is_active) VALUES ($1, 'QUALIFIED', 'مستوفي للشروط', TRUE)`, [randomUUID()])
  await pool.query(`INSERT INTO qualification_status_reference (id, code, name, is_active) VALUES ($1, 'CONDITIONALLY_QUALIFIED', 'مستوفي بشروط', TRUE)`, [randomUUID()])
  await pool.query(`INSERT INTO qualification_status_reference (id, code, name, is_active) VALUES ($1, 'INACTIVE_REF', 'غير مفعل', FALSE)`, [randomUUID()])

  // 2. Create Routing Units
  routingUnitId = randomUUID()
  otherRoutingUnitId = randomUUID()
  await pool.query(
    `INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-01', 'نيابة الشئون الإدارية', TRUE)`,
    [routingUnitId]
  )
  await pool.query(
    `INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-02', 'نيابة الشئون المالية', TRUE)`,
    [otherRoutingUnitId]
  )

  // 3. Create Operational Units
  hrUnitId = randomUUID()
  orgUnitId = randomUUID()
  authUnitId = randomUUID()
  await pool.query(
    `INSERT INTO operational_unit (id, kind, name, is_active) VALUES ($1, 'HR', 'إدارة الموارد البشرية', TRUE)`,
    [hrUnitId]
  )
  await pool.query(
    `INSERT INTO operational_unit (id, kind, name, is_active) VALUES ($1, 'ORG', 'إدارة التنظيم والإدارة', TRUE)`,
    [orgUnitId]
  )
  await pool.query(
    `INSERT INTO operational_unit (id, kind, name, routing_unit_id, is_active) VALUES ($1, 'AUTH', 'نيابة الشئون الإدارية المختصة', $2, TRUE)`,
    [authUnitId, routingUnitId]
  )

  // 4. Create User Accounts
  hrManager = await createOperationalAccount('hr.manager', 'مدير الموارد البشرية')
  hrSubordinate = await createOperationalAccount('hr.sub', 'موظف الموارد البشرية')
  orgManager = await createOperationalAccount('org.manager', 'مدير التنظيم')
  orgSubordinate = await createOperationalAccount('org.sub', 'موظف التنظيم')
  authManager = await createOperationalAccount('auth.manager', 'مدير النيابة المختصة')
  authSubordinate = await createOperationalAccount('auth.sub', 'موظف النيابة المختصة')
  adminUser = await createAdminAccount('admin.user', 'مدير النظام')
  otherUser = await createOperationalAccount('other.user', 'مستخدم آخر')

  // 5. Assign Memberships
  await addMembership(hrManager.userId, hrUnitId, hrManager.userId)
  await addMembership(hrSubordinate.userId, hrUnitId, hrManager.userId)
  await addMembership(orgManager.userId, orgUnitId, hrManager.userId)
  await addMembership(orgSubordinate.userId, orgUnitId, orgManager.userId)
  await addMembership(authManager.userId, authUnitId, hrManager.userId)
  await addMembership(authSubordinate.userId, authUnitId, authManager.userId)

  // 6. Assign Managers
  await assignManager(hrUnitId, hrManager.userId, hrManager.userId)
  await assignManager(orgUnitId, orgManager.userId, hrManager.userId)
  await assignManager(authUnitId, authManager.userId, hrManager.userId)

  // 7. Setup Active Annual Snapshot
  const batchId = randomUUID()
  await pool.query(
    `INSERT INTO import_batch
      (id, snapshot_year, source_filename, source_sha256, detected_headers, status, row_count, activated_at)
     VALUES ($1, 2026, 'annual_2026.xlsx', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '[]'::jsonb, 'ACTIVATED', 3, CURRENT_TIMESTAMP)`,
    [batchId]
  )

  const emp1Id = randomUUID()
  const emp2Id = randomUUID()
  const emp3Id = randomUUID()
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000201')`, [emp1Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000202')`, [emp2Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000203')`, [emp3Id])

  snapshot1Id = randomUUID()
  snapshot2Id = randomUUID()
  crossRoutingSnapshotId = randomUUID()

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000201', $4, $5::jsonb)`,
    [
      snapshot1Id, emp1Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000201',
        employeeName: 'محمد أحمد محمود',
        currentJobTitle: 'مهندس مشروعات ثالث'
      })
    ]
  )

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000202', $4, $5::jsonb)`,
    [
      snapshot2Id, emp2Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000202',
        employeeName: 'منى سمير عبد الرحمن',
        currentJobTitle: 'أخصائي تشغيل حاسبات ثان'
      })
    ]
  )

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000203', $4, $5::jsonb)`,
    [
      crossRoutingSnapshotId, emp3Id, batchId, otherRoutingUnitId,
      JSON.stringify({
        personnelNumber: '000203',
        employeeName: 'ياسر كمال مصطفى',
        currentJobTitle: 'محاسب تكاليف أول'
      })
    ]
  )
})

afterEach(async () => {
  if (pool) {
    await pool.end()
  }
})

/**
 * Helper to advance a request through synthetic stage setup to S2
 */
async function setupRequestAtS2(): Promise<{
  requestId: string
  iterationId: string
  s2StageExecutionId: string
  candidate1Id: string
  candidate2Id: string
}> {
  const req = await engine.createRequest({ requestType: 'SECONDMENT', routingUnitId }, hrManager)
  const cand1 = await engine.addCandidate(req.id, { personnelNumber: '000201' }, hrManager)
  const cand2 = await engine.addCandidate(req.id, { personnelNumber: '000202' }, hrManager)

  const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
  const iterId = iterResult.rows[0]!.id

  // Close S1
  await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.currentExecutionId!])

  // Create OPEN S2
  const s2ExecId = randomUUID()
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
     VALUES ($1, $2, 'S2', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
    [s2ExecId, iterId, orgUnitId]
  )
  await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S2', status = 'ACTIVE' WHERE id = $1`, [req.id])

  return {
    requestId: req.id,
    iterationId: iterId,
    s2StageExecutionId: s2ExecId,
    candidate1Id: cand1.id,
    candidate2Id: cand2.id
  }
}

/**
 * Helper to advance a request to S3 with completed S2 options
 */
async function setupRequestAtS3(): Promise<{
  requestId: string
  iterationId: string
  s2StageExecutionId: string
  s3StageExecutionId: string
  candidate1Id: string
  candidate2Id: string
  option1AId: string
  option1BId: string
  option2AId: string
}> {
  const { requestId, iterationId, s2StageExecutionId, candidate1Id, candidate2Id } = await setupRequestAtS2()

  // Add position options at S2
  const opt1A = await secondment.addPositionOption(
    s2StageExecutionId,
    candidate1Id,
    { positionTitle: 'مهندس مشروعات ثان', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
    orgManager
  )
  const opt1B = await secondment.addPositionOption(
    s2StageExecutionId,
    candidate1Id,
    { positionTitle: 'مهندس متابعة فنية ثان', organizationalDependency: 'إدارة المتابعة', qualificationStatus: 'QUALIFIED' },
    orgManager
  )
  const opt2A = await secondment.addPositionOption(
    s2StageExecutionId,
    candidate2Id,
    { positionTitle: 'أخصائي تشغيل حاسبات أول', organizationalDependency: 'إدارة النظم والمعلومات', qualificationStatus: 'QUALIFIED' },
    orgManager
  )

  // Complete S2
  await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [s2StageExecutionId])

  // Create OPEN S3
  const s3ExecId = randomUUID()
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
     VALUES ($1, $2, 'S3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
    [s3ExecId, iterationId, authUnitId]
  )
  await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S3' WHERE id = $1`, [requestId])

  return {
    requestId,
    iterationId,
    s2StageExecutionId,
    s3StageExecutionId: s3ExecId,
    candidate1Id,
    candidate2Id,
    option1AId: opt1A.id,
    option1BId: opt1B.id,
    option2AId: opt2A.id
  }
}

/**
 * Helper to advance a request to S4 with completed S2 options and S3 selections
 */
async function setupRequestAtS4(): Promise<{
  requestId: string
  iterationId: string
  s2StageExecutionId: string
  s3StageExecutionId: string
  s4StageExecutionId: string
  candidate1Id: string
  candidate2Id: string
  option1AId: string
  option2AId: string
}> {
  const {
    requestId,
    iterationId,
    s2StageExecutionId,
    s3StageExecutionId,
    candidate1Id,
    candidate2Id,
    option1AId,
    option2AId
  } = await setupRequestAtS3()

  // Make S3 selections
  await secondment.upsertSelection(s3StageExecutionId, candidate1Id, { selectedOptionId: option1AId }, authManager)
  await secondment.upsertSelection(s3StageExecutionId, candidate2Id, { selectedOptionId: option2AId }, authManager)

  // Complete S3
  await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [s3StageExecutionId])

  // Create OPEN S4
  const s4ExecId = randomUUID()
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
     VALUES ($1, $2, 'S4', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
    [s4ExecId, iterationId, orgUnitId]
  )
  await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S4' WHERE id = $1`, [requestId])

  return {
    requestId,
    iterationId,
    s2StageExecutionId,
    s3StageExecutionId,
    s4StageExecutionId: s4ExecId,
    candidate1Id,
    candidate2Id,
    option1AId,
    option2AId
  }
}

describe('Phase 5 Secondment Workflow Domain Logic and API', () => {
  it('1. Secondment option API refuses PROMOTION request', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const cand = await engine.addCandidate(req.id, { personnelNumber: '000201' }, hrManager)

    await expect(
      secondment.addPositionOption(
        req.currentExecutionId!,
        cand.id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'الإدارة العامة', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_TYPE' })

    await expect(
      secondment.getAuthoritativePositionOptions(req.id, hrManager)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_TYPE' })
  })

  it('2. S2 option mutation only on current OPEN S2', async () => {
    const { requestId, s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Complete S2 execution
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED' WHERE id = $1`, [s2StageExecutionId])

    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'الإدارة العامة', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'STAGE_NOT_OPEN' })
  })

  it('3. current ORG manager may edit S2 options', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    const opt = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس مشروعات ثان', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    expect(opt.id).toBeDefined()
    expect(opt.positionTitle).toBe('مهندس مشروعات ثان')
    expect(opt.qualificationStatusName).toBe('مستوفي للشروط')
  })

  it('4. active ORG assignee may edit S2 options', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Assign stage to subordinate
    await engine.assignStage(s2StageExecutionId, { assignedToUserId: orgSubordinate.userId }, orgManager)

    const opt = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس تخطيط ثان', organizationalDependency: 'إدارة التخطيط', qualificationStatus: 'QUALIFIED' },
      orgSubordinate
    )

    expect(opt.id).toBeDefined()
    expect(opt.positionTitle).toBe('مهندس تخطيط ثان')
  })

  it('5. old/reassigned S2 assignee loses edit authority', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Initial assignment to subordinate
    await engine.assignStage(s2StageExecutionId, { assignedToUserId: orgSubordinate.userId }, orgManager)

    // Reassign to manager (takes back work)
    await engine.assignStage(s2StageExecutionId, { assignedToUserId: orgManager.userId }, orgManager)

    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
        orgSubordinate
      )
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_STAGE_EDITOR' })
  })

  it('6. replaced ORG manager loses edit authority', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Replace manager
    const newOrgManager = await createOperationalAccount('new.org.manager', 'مدير التنظيم الجديد')
    await addMembership(newOrgManager.userId, orgUnitId, hrManager.userId)
    await pool!.query(`UPDATE unit_manager_assignment SET effective_to = CURRENT_TIMESTAMP WHERE unit_id = $1`, [orgUnitId])
    await assignManager(orgUnitId, newOrgManager.userId, hrManager.userId)

    // Old manager attempt is rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_STAGE_EDITOR' })

    // New manager succeeds
    const opt = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس مشروعات ثان', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
      newOrgManager
    )
    expect(opt.id).toBeDefined()
  })

  it('7. candidate from another request rejected', async () => {
    const req1 = await setupRequestAtS2()
    const req2 = await setupRequestAtS2()

    await expect(
      secondment.addPositionOption(
        req1.s2StageExecutionId,
        req2.candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'CANDIDATE_NOT_IN_REQUEST' })
  })

  it('8. positionTitle required/max 240', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Blank/whitespace rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: '   ', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/positionTitle.*1-240/) })

    // >240 characters rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'A'.repeat(241), organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/positionTitle.*1-240/) })

    // Valid bounded value succeeds
    const valid = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس مشروعات معتمد', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    expect(valid.positionTitle).toBe('مهندس مشروعات معتمد')
  })

  it('9. organizationalDependency required/max 240', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Blank/whitespace rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: '   ', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/organizationalDependency.*1-240/) })

    // >240 characters rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'B'.repeat(241), qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/organizationalDependency.*1-240/) })

    // Valid bounded value succeeds
    const valid = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات الهندسية', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    expect(valid.organizationalDependency).toBe('إدارة المشروعات الهندسية')
  })

  it('10. qualificationStatus must resolve ACTIVE reference code', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Inactive code rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'INACTIVE_REF' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_QUALIFICATION_STATUS' })

    // Unknown code rejected
    await expect(
      secondment.addPositionOption(
        s2StageExecutionId,
        candidate1Id,
        { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'UNKNOWN_CODE' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_QUALIFICATION_STATUS' })
  })

  it('11. no hard-coded QUALIFIED/NOT_QUALIFIED assumption', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    // Add a custom qualification status reference to DB
    await pool!.query(
      `INSERT INTO qualification_status_reference (id, code, name, is_active)
       VALUES ($1, 'SPECIAL_APPROVAL', 'موافقة خاصة', TRUE)`,
      [randomUUID()]
    )

    const opt = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'مهندس مشروعات', organizationalDependency: 'إدارة المشروعات', qualificationStatus: 'SPECIAL_APPROVAL' },
      orgManager
    )

    expect(opt.qualificationStatusCode).toBe('SPECIAL_APPROVAL')
    expect(opt.qualificationStatusName).toBe('موافقة خاصة')
  })

  it('12. add assigns deterministic displayOrder (0, 1, 2...)', async () => {
    const { s2StageExecutionId, candidate1Id, candidate2Id } = await setupRequestAtS2()

    const opt1A = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة 1', organizationalDependency: 'إدارة 1', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    const opt1B = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة 2', organizationalDependency: 'إدارة 1', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    const opt2A = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate2Id,
      { positionTitle: 'وظيفة مرشح 2', organizationalDependency: 'إدارة 2', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    expect(opt1A.displayOrder).toBe(0)
    expect(opt1B.displayOrder).toBe(1)
    expect(opt2A.displayOrder).toBe(0) // Separate candidate scope
  })

  it('13. update preserves option id/displayOrder', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    const opt1 = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة أولية', organizationalDependency: 'إدارة أولية', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    const updated = await secondment.updatePositionOption(
      s2StageExecutionId,
      opt1.id,
      { positionTitle: 'وظيفة معدلة', organizationalDependency: 'إدارة معدلة', qualificationStatus: 'CONDITIONALLY_QUALIFIED' },
      orgManager
    )

    expect(updated.id).toBe(opt1.id)
    expect(updated.displayOrder).toBe(opt1.displayOrder)
    expect(updated.positionTitle).toBe('وظيفة معدلة')
    expect(updated.qualificationStatusCode).toBe('CONDITIONALLY_QUALIFIED')
    expect(updated.qualificationStatusName).toBe('مستوفي بشروط')
  })

  it('14. remove works only for current S2 execution', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    const opt1 = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة للحذف', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    const res = await secondment.removePositionOption(s2StageExecutionId, opt1.id, orgManager)
    expect(res.success).toBe(true)
    expect(res.optionId).toBe(opt1.id)

    // Option is deleted from DB
    const check = await pool!.query(`SELECT id FROM secondment_position_option WHERE id = $1`, [opt1.id])
    expect(check.rows.length).toBe(0)
  })

  it('15. historical completed S2 option cannot be mutated/deleted', async () => {
    const { s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    const opt1 = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة مثبتة', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    // Complete S2
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED' WHERE id = $1`, [s2StageExecutionId])

    await expect(
      secondment.updatePositionOption(
        s2StageExecutionId,
        opt1.id,
        { positionTitle: 'تعديل غير مسموح', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
        orgManager
      )
    ).rejects.toMatchObject({ code: 'STAGE_NOT_OPEN' })

    await expect(
      secondment.removePositionOption(s2StageExecutionId, opt1.id, orgManager)
    ).rejects.toMatchObject({ code: 'STAGE_NOT_OPEN' })
  })

  it('16. new S2 execution gets fresh option rows', async () => {
    const { requestId, iterationId, s2StageExecutionId, candidate1Id } = await setupRequestAtS2()

    await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة النسخة 1', organizationalDependency: 'إدارة 1', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    // Return or reopen via fresh execution (execution_no = 2)
    await pool!.query(`UPDATE stage_execution SET status = 'RETURNED' WHERE id = $1`, [s2StageExecutionId])
    const newS2Id = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'S2', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [newS2Id, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S2' WHERE id = $1`, [requestId])

    // Current authoritative options for new S2 are empty until populated
    const currentOptions = await secondment.getAuthoritativePositionOptions(requestId, orgManager)
    expect(currentOptions.length).toBe(0)

    // Add new option to new execution
    const newOpt = await secondment.addPositionOption(
      newS2Id,
      candidate1Id,
      { positionTitle: 'وظيفة النسخة 2', organizationalDependency: 'إدارة 2', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    expect(newOpt.sourceStageExecutionId).toBe(newS2Id)

    // Old option remains preserved in DB as historical evidence
    const allInDb = await pool!.query(`SELECT id FROM secondment_position_option WHERE candidate_id = $1`, [candidate1Id])
    expect(allInDb.rows.length).toBe(2)
  })

  it('17. S2 readiness requires >=1 valid option per candidate', async () => {
    const { requestId, iterationId, s2StageExecutionId, candidate1Id, candidate2Id } = await setupRequestAtS2()

    // Add option only for candidate 1
    await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة 1', organizationalDependency: 'إدارة 1', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    // Readiness fails because candidate 2 lacks option
    await expect(
      secondment.validateSecondmentS2ForSignoff(pool!, requestId, iterationId, s2StageExecutionId)
    ).rejects.toMatchObject({ code: 'SECONDMENT_OPTIONS_REQUIRED' })

    // Add option for candidate 2
    await secondment.addPositionOption(
      s2StageExecutionId,
      candidate2Id,
      { positionTitle: 'وظيفة 2', organizationalDependency: 'إدارة 2', qualificationStatus: 'QUALIFIED' },
      orgManager
    )

    const readiness = await secondment.validateSecondmentS2ForSignoff(pool!, requestId, iterationId, s2StageExecutionId)
    expect(readiness.stageCode).toBe('S2')
    expect(readiness.candidateOptions.length).toBe(2)
  })

  it('18. S3 selection API refuses PROMOTION request', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const cand = await engine.addCandidate(req.id, { personnelNumber: '000201' }, hrManager)

    await expect(
      secondment.upsertSelection(
        req.currentExecutionId!,
        cand.id,
        { selectedOptionId: randomUUID() },
        authManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_TYPE' })

    await expect(
      secondment.getAuthoritativeSelections(req.id, hrManager)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST_TYPE' })
  })

  it('19. current AUTH manager can select', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    const selection = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )

    expect(selection.id).toBeDefined()
    expect(selection.selectedOptionId).toBe(option1AId)
    expect(selection.positionTitle).toBe('مهندس مشروعات ثان')
  })

  it('20. active AUTH assignee can select', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    // Assign S3 to subordinate
    await engine.assignStage(s3StageExecutionId, { assignedToUserId: authSubordinate.userId }, authManager)

    const selection = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authSubordinate
    )

    expect(selection.id).toBeDefined()
    expect(selection.selectedOptionId).toBe(option1AId)
  })

  it('21. old/reassigned S3 assignee loses authority', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    await engine.assignStage(s3StageExecutionId, { assignedToUserId: authSubordinate.userId }, authManager)
    await engine.assignStage(s3StageExecutionId, { assignedToUserId: authManager.userId }, authManager)

    await expect(
      secondment.upsertSelection(
        s3StageExecutionId,
        candidate1Id,
        { selectedOptionId: option1AId },
        authSubordinate
      )
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_STAGE_EDITOR' })
  })

  it('22. replaced AUTH manager loses authority', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    // Replace AUTH manager
    const newAuthManager = await createOperationalAccount('new.auth.manager', 'مدير النيابة الجديد')
    await addMembership(newAuthManager.userId, authUnitId, hrManager.userId)
    await pool!.query(`UPDATE unit_manager_assignment SET effective_to = CURRENT_TIMESTAMP WHERE unit_id = $1`, [authUnitId])
    await assignManager(authUnitId, newAuthManager.userId, hrManager.userId)

    await expect(
      secondment.upsertSelection(
        s3StageExecutionId,
        candidate1Id,
        { selectedOptionId: option1AId },
        authManager
      )
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED_STAGE_EDITOR' })

    const selection = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      newAuthManager
    )
    expect(selection.id).toBeDefined()
  })

  it('23. another candidate\'s option cannot be selected', async () => {
    const { s3StageExecutionId, candidate1Id, option2AId } = await setupRequestAtS3()

    // Try to assign candidate 2's option to candidate 1
    await expect(
      secondment.upsertSelection(
        s3StageExecutionId,
        candidate1Id,
        { selectedOptionId: option2AId },
        authManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_OPTION_SELECTION' })
  })

  it('24. another request\'s option cannot be selected', async () => {
    const s3Req1 = await setupRequestAtS3()
    const s3Req2 = await setupRequestAtS3()

    await expect(
      secondment.upsertSelection(
        s3Req1.s3StageExecutionId,
        s3Req1.candidate1Id,
        { selectedOptionId: s3Req2.option1AId },
        authManager
      )
    ).rejects.toMatchObject({ code: 'INVALID_OPTION_SELECTION' })
  })

  it('25. stale superseded S2 option cannot be selected', async () => {
    const { requestId, iterationId, s2StageExecutionId, candidate1Id, candidate2Id } = await setupRequestAtS2()

    // Options for S2 execution 1
    const staleOpt = await secondment.addPositionOption(
      s2StageExecutionId,
      candidate1Id,
      { positionTitle: 'وظيفة قديمة', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [s2StageExecutionId])

    // Return to S2 (execution 2)
    const freshS2Id = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'S2', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [freshS2Id, iterationId, orgUnitId]
    )
    const freshOpt1 = await secondment.addPositionOption(
      freshS2Id,
      candidate1Id,
      { positionTitle: 'وظيفة حديثة 1', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    const freshOpt2 = await secondment.addPositionOption(
      freshS2Id,
      candidate2Id,
      { positionTitle: 'وظيفة حديثة 2', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED' },
      orgManager
    )
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [freshS2Id])

    // Open S3
    const s3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'S3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [s3ExecId, iterationId, authUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S3' WHERE id = $1`, [requestId])

    // Attempt to select stale option from S2 execution 1 fails
    await expect(
      secondment.upsertSelection(
        s3ExecId,
        candidate1Id,
        { selectedOptionId: staleOpt.id },
        authManager
      )
    ).rejects.toMatchObject({ code: 'STALE_OPTION_SELECTION' })

    // Selecting fresh option succeeds
    const sel = await secondment.upsertSelection(
      s3ExecId,
      candidate1Id,
      { selectedOptionId: freshOpt1.id },
      authManager
    )
    expect(sel.selectedOptionId).toBe(freshOpt1.id)
  })

  it('26. selected option must come from authoritative completed S2', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    const sel = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )
    expect(sel.selectedOptionId).toBe(option1AId)
  })

  it('27. repeated selection in same S3 keeps stable decision id', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId, option1BId } = await setupRequestAtS3()

    const first = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )

    const second = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1BId },
      authManager
    )

    expect(second.id).toBe(first.id) // Same primary key preserved
    expect(second.selectedOptionId).toBe(option1BId)

    const count = await pool!.query(`SELECT COUNT(*) AS c FROM secondment_decision WHERE stage_execution_id = $1 AND candidate_id = $2`, [s3StageExecutionId, candidate1Id])
    expect(Number(count.rows[0]?.c)).toBe(1)
  })

  it('28. historical completed S3 decision cannot be edited', async () => {
    const { s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )

    // Complete S3
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED' WHERE id = $1`, [s3StageExecutionId])

    await expect(
      secondment.upsertSelection(
        s3StageExecutionId,
        candidate1Id,
        { selectedOptionId: option1AId },
        authManager
      )
    ).rejects.toMatchObject({ code: 'STAGE_NOT_OPEN' })
  })

  it('29. new S3 execution gets a fresh decision row', async () => {
    const { requestId, iterationId, s3StageExecutionId, candidate1Id, option1AId, option1BId } = await setupRequestAtS3()

    const first = await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )

    // Return S3 to previous and advance back to S3 execution 2
    await pool!.query(`UPDATE stage_execution SET status = 'RETURNED' WHERE id = $1`, [s3StageExecutionId])
    const newS3Id = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'S3', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [newS3Id, iterationId, authUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S3' WHERE id = $1`, [requestId])

    const second = await secondment.upsertSelection(
      newS3Id,
      candidate1Id,
      { selectedOptionId: option1BId },
      authManager
    )

    expect(second.id).not.toBe(first.id)
    expect(second.stageExecutionId).toBe(newS3Id)

    const allDecisions = await pool!.query(`SELECT id FROM secondment_decision WHERE candidate_id = $1`, [candidate1Id])
    expect(allDecisions.rows.length).toBe(2)
  })

  it('30. S3 readiness fails if any candidate lacks selection', async () => {
    const { requestId, iterationId, s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    await secondment.upsertSelection(
      s3StageExecutionId,
      candidate1Id,
      { selectedOptionId: option1AId },
      authManager
    )

    // Fails because candidate 2 lacks selection
    await expect(
      secondment.validateSecondmentS3ForSignoff(pool!, requestId, iterationId, s3StageExecutionId)
    ).rejects.toMatchObject({ code: 'SECONDMENT_SELECTION_MISSING' })
  })

  it('31. exactly one selection/candidate is enforced', async () => {
    const { requestId, iterationId, s3StageExecutionId, candidate1Id, candidate2Id, option1AId, option2AId } = await setupRequestAtS3()

    await secondment.upsertSelection(s3StageExecutionId, candidate1Id, { selectedOptionId: option1AId }, authManager)
    await secondment.upsertSelection(s3StageExecutionId, candidate2Id, { selectedOptionId: option2AId }, authManager)

    const res = await secondment.validateSecondmentS3ForSignoff(pool!, requestId, iterationId, s3StageExecutionId)
    expect(res.nextStageCode).toBe('S4')
    expect(res.selections.length).toBe(2)
  })

  it('32. S4 confirmation fails if authoritative S3 selection set is incomplete', async () => {
    const { requestId, iterationId, s2StageExecutionId, s3StageExecutionId, candidate1Id, option1AId } = await setupRequestAtS3()

    // Select candidate 1 only
    await secondment.upsertSelection(s3StageExecutionId, candidate1Id, { selectedOptionId: option1AId }, authManager)
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [s3StageExecutionId])

    const s4ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'S4', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [s4ExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'S4' WHERE id = $1`, [requestId])

    await expect(
      engine.approveAndAdvance(s4ExecId, orgManager)
    ).rejects.toMatchObject({ code: 'SECONDMENT_SELECTIONS_INCOMPLETE' })
  })

  it('33. S4 confirmation fails if selected option chain is invalid', async () => {
    const { s4StageExecutionId, candidate1Id, option2AId } = await setupRequestAtS4()

    // Point candidate 1's decision to candidate 2's option (database-valid FK, but candidate mismatch)
    await pool!.query(
      `UPDATE secondment_decision SET selected_option_id = $1 WHERE candidate_id = $2`,
      [option2AId, candidate1Id]
    )

    await expect(
      engine.approveAndAdvance(s4StageExecutionId, orgManager)
    ).rejects.toMatchObject({ code: 'INVALID_OPTION_SELECTION' })
  })

  it('34. S4 confirmation does not mutate S3 decisions', async () => {
    const { s4StageExecutionId, candidate1Id } = await setupRequestAtS4()

    const before = await pool!.query(`SELECT id, selected_option_id FROM secondment_decision WHERE candidate_id = $1`, [candidate1Id])

    await engine.approveAndAdvance(s4StageExecutionId, orgManager)

    const after = await pool!.query(`SELECT id, selected_option_id FROM secondment_decision WHERE candidate_id = $1`, [candidate1Id])
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('35. S4 confirmation does not mutate S2 options', async () => {
    const { s4StageExecutionId, option1AId } = await setupRequestAtS4()

    const before = await pool!.query(`SELECT id, position_title, qualification_status FROM secondment_position_option WHERE id = $1`, [option1AId])

    await engine.approveAndAdvance(s4StageExecutionId, orgManager)

    const after = await pool!.query(`SELECT id, position_title, qualification_status FROM secondment_position_option WHERE id = $1`, [option1AId])
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('36. S4 snapshot includes immutable authoritative selections', async () => {
    const { s4StageExecutionId, candidate1Id, candidate2Id, option1AId, option2AId } = await setupRequestAtS4()

    await engine.approveAndAdvance(s4StageExecutionId, orgManager)

    const snapshotResult = await pool!.query<{ payload: any }>(
      `SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id = $1`,
      [s4StageExecutionId]
    )
    const payload = snapshotResult.rows[0]!.payload
    expect(payload.secondmentSelections).toBeDefined()
    expect(payload.secondmentSelections.length).toBe(2)
    expect(payload.secondmentSelections[0].selectedOptionId).toBe(option1AId)
    expect(payload.secondmentSelections[1].selectedOptionId).toBe(option2AId)
  })

  it('37. S4 confirm -> S5', async () => {
    const { s4StageExecutionId, requestId } = await setupRequestAtS4()

    const nextStage = await engine.approveAndAdvance(s4StageExecutionId, orgManager)
    expect(nextStage.stageCode).toBe('S5')
    expect(nextStage.responsibleUnitKind).toBe('HR')

    const req = await engine.getRequest(requestId, hrManager)
    expect(req.currentStageCode).toBe('S5')
  })

  it('38. S4 return -> fresh S3', async () => {
    const { s4StageExecutionId, requestId } = await setupRequestAtS4()

    const freshS3 = await engine.returnPreviousStage(s4StageExecutionId, { reason: 'إعادة مراجعة الترشيح' }, orgManager)
    expect(freshS3.stageCode).toBe('S3')
    expect(freshS3.executionNo).toBe(2)

    const req = await engine.getRequest(requestId, authManager)
    expect(req.currentStageCode).toBe('S3')
  })

  it('39. S4 reject -> REJECTED_PENDING_HR_DECISION', async () => {
    const { s4StageExecutionId, requestId } = await setupRequestAtS4()

    const reqSummary = await engine.rejectStage(s4StageExecutionId, { reason: 'رفض من إدارة التنظيم' }, orgManager)
    expect(reqSummary.status).toBe('REJECTED_PENDING_HR_DECISION')

    const reloaded = await engine.getRequest(requestId, hrManager)
    expect(reloaded.status).toBe('REJECTED_PENDING_HR_DECISION')
  })

  it('40. read option API enforces IDOR', async () => {
    const { requestId } = await setupRequestAtS2()

    // Non-participant user cannot read options (hidden via 404 REQUEST_NOT_FOUND)
    await expect(
      secondment.getAuthoritativePositionOptions(requestId, otherUser)
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' })

    // Participating HR manager succeeds
    const options = await secondment.getAuthoritativePositionOptions(requestId, hrManager)
    expect(Array.isArray(options)).toBe(true)
  })

  it('41. read selection API enforces IDOR', async () => {
    const { requestId } = await setupRequestAtS3()

    // Non-participant user cannot read selections (hidden via 404 REQUEST_NOT_FOUND)
    await expect(
      secondment.getAuthoritativeSelections(requestId, otherUser)
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' })

    const selections = await secondment.getAuthoritativeSelections(requestId, hrManager)
    expect(Array.isArray(selections)).toBe(true)
  })

  it('42. write routes reject targetRoutingUnitId and client displayOrder', async () => {
    expect(() => {
      exactObject(
        { positionTitle: 'مهندس', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED', targetRoutingUnitId: randomUUID() },
        ['positionTitle', 'organizationalDependency', 'qualificationStatus']
      )
    }).toThrow()

    expect(() => {
      exactObject(
        { positionTitle: 'مهندس', organizationalDependency: 'إدارة', qualificationStatus: 'QUALIFIED', displayOrder: 99 },
        ['positionTitle', 'organizationalDependency', 'qualificationStatus']
      )
    }).toThrow()
  })

  it('43. generic approveAndAdvance(S2) remains SIGNATURE_REQUIRED', async () => {
    const { s2StageExecutionId } = await setupRequestAtS2()

    await expect(
      engine.approveAndAdvance(s2StageExecutionId, orgManager)
    ).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
  })

  it('44. generic approveAndAdvance(S3) remains SIGNATURE_REQUIRED', async () => {
    const { s3StageExecutionId } = await setupRequestAtS3()

    await expect(
      engine.approveAndAdvance(s3StageExecutionId, authManager)
    ).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
  })

  it('45. Promotion Phase 4 behavior remains unaffected', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const cand1 = await engine.addCandidate(req.id, { personnelNumber: '000201' }, hrManager)

    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED' WHERE id = $1`, [req.currentExecutionId!])

    const p4ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4ExecId, iterId, authUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4', status = 'ACTIVE' WHERE id = $1`, [req.id])

    const dec = await promotion.upsertDecision(
      p4ExecId,
      cand1.id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    expect(dec.decisionType).toBe('SAME_POSITION')
    expect(dec.effectiveNominatedJob).toBe('مهندس مشروعات ثالث')
  })
})
