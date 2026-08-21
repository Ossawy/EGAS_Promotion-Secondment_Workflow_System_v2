import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DataType, newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { testConfig } from './helpers/database.js'
import { WorkflowEngineService } from '../src/modules/workflow/workflow-engine-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import type { WorkflowRequestContext } from '../src/modules/workflow/workflow-types.js'
import { resolveResponsibleOperationalUnit } from '../src/modules/workflow/workflow-unit-resolver.js'

let pool: Pool | undefined
let engine: WorkflowEngineService

// Setup identities
let hrUnitId: string
let orgUnitId: string
let authUnitId: string
let routingUnitId: string

let hrManager: WorkflowRequestContext
let hrSubordinate: WorkflowRequestContext
let orgManager: WorkflowRequestContext
let orgSubordinate: WorkflowRequestContext
let authManager: WorkflowRequestContext
let authSubordinate: WorkflowRequestContext
let adminUser: WorkflowRequestContext
let otherUser: WorkflowRequestContext

let snapshotId: string
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

  // 1. Create Routing Unit
  routingUnitId = randomUUID()
  const otherRoutingUnitId = randomUUID()
  await pool.query(
    `INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-01', 'نيابة الشئون الإدارية', TRUE)`,
    [routingUnitId]
  )
  await pool.query(
    `INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-02', 'نيابة الشئون المالية', TRUE)`,
    [otherRoutingUnitId]
  )

  // 2. Create Operational Units
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

  // 3. Create User Accounts
  hrManager = await createOperationalAccount('hr.manager', 'مدير الموارد البشرية')
  hrSubordinate = await createOperationalAccount('hr.sub', 'موظف الموارد البشرية')
  orgManager = await createOperationalAccount('org.manager', 'مدير التنظيم')
  orgSubordinate = await createOperationalAccount('org.sub', 'موظف التنظيم')
  authManager = await createOperationalAccount('auth.manager', 'مدير النيابة المختصة')
  authSubordinate = await createOperationalAccount('auth.sub', 'موظف النيابة المختصة')
  adminUser = await createAdminAccount('admin.user', 'مدير النظام')
  otherUser = await createOperationalAccount('other.user', 'مستخدم آخر')

  // 4. Assign Memberships
  await addMembership(hrManager.userId, hrUnitId, hrManager.userId)
  await addMembership(hrSubordinate.userId, hrUnitId, hrManager.userId)
  await addMembership(orgManager.userId, orgUnitId, hrManager.userId)
  await addMembership(orgSubordinate.userId, orgUnitId, orgManager.userId)
  await addMembership(authManager.userId, authUnitId, hrManager.userId)
  await addMembership(authSubordinate.userId, authUnitId, authManager.userId)

  // 5. Assign Managers
  await assignManager(hrUnitId, hrManager.userId, hrManager.userId)
  await assignManager(orgUnitId, orgManager.userId, hrManager.userId)
  await assignManager(authUnitId, authManager.userId, hrManager.userId)

  // 6. Setup Active Annual Snapshot
  const batchId = randomUUID()
  await pool.query(
    `INSERT INTO import_batch
      (id, snapshot_year, source_filename, source_sha256, detected_headers, status, row_count, activated_at)
     VALUES ($1, 2026, 'annual_2026.xlsx', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '[]'::jsonb, 'ACTIVATED', 2, CURRENT_TIMESTAMP)`,
    [batchId]
  )

  const emp1Id = randomUUID()
  const emp2Id = randomUUID()
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000101')`, [emp1Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000102')`, [emp2Id])

  snapshotId = randomUUID()
  crossRoutingSnapshotId = randomUUID()

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000101', $4, $5::jsonb)`,
    [
      snapshotId, emp1Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000101',
        employeeName: 'أحمد سعيد',
        currentJobTitle: 'أخصائي شؤون إدارية أول',
        performanceRating: 'ممتاز',
        performanceReportYear: 2026
      })
    ]
  )

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000102', $4, $5::jsonb)`,
    [
      crossRoutingSnapshotId, emp2Id, batchId, otherRoutingUnitId,
      JSON.stringify({
        personnelNumber: '000102',
        employeeName: 'محمد كمال',
        currentJobTitle: 'أخصائي مالي',
        performanceRating: 'جيد جدا',
        performanceReportYear: 2026
      })
    ]
  )
})

afterEach(async () => {
  if (pool) {
    await pool.end()
  }
})

describe('Phase 3 Generic Workflow Engine Core Requirements', () => {
  it('1. only HR current manager can create a workflow request', async () => {
    // ORG manager cannot create
    await expect(engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, orgManager)).rejects.toMatchObject({
      code: 'HR_MANAGER_REQUIRED'
    })
    // AUTH manager cannot create
    await expect(engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, authManager)).rejects.toMatchObject({
      code: 'HR_MANAGER_REQUIRED'
    })
    // Ordinary HR subordinate cannot create
    await expect(engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrSubordinate)).rejects.toMatchObject({
      code: 'HR_MANAGER_REQUIRED'
    })

    // HR manager can create
    const created = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    expect(created.requestType).toBe('PROMOTION')
    expect(created.status).toBe('DRAFT')
    expect(created.currentStageCode).toBe('P1')
  })

  it('2. ADMIN account cannot create or execute workflow commands', async () => {
    await expect(engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, adminUser)).rejects.toMatchObject({
      code: 'OPERATIONAL_REQUIRED'
    })
  })

  it('3. request creation creates iteration 1 and initial P1/S1 stage execution', async () => {
    const promo = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    expect(promo.currentIterationNo).toBe(1)
    expect(promo.currentStageCode).toBe('P1')
    expect(promo.currentWorkState).toBe('MANAGER_INBOX')
    expect(promo.currentResponsibleUnitId).toBe(hrUnitId)

    const sec = await engine.createRequest({ requestType: 'SECONDMENT', routingUnitId }, hrManager)
    expect(sec.currentIterationNo).toBe(1)
    expect(sec.currentStageCode).toBe('S1')
    expect(sec.currentWorkState).toBe('MANAGER_INBOX')
    expect(sec.currentResponsibleUnitId).toBe(hrUnitId)
  })

  it('4 & 5. candidate data is frozen from active snapshot and cross-routing candidates are rejected', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)

    await expect(engine.addCandidate(req.id, { personnelNumber: '000102' }, hrManager)).rejects.toMatchObject({
      code: 'CANDIDATE_ROUTING_MISMATCH'
    })

    const cand = await engine.addCandidate(req.id, { personnelNumber: '000101' }, hrManager)
    expect(cand.personnelNumber).toBe('000101')
    expect(cand.employeeName).toBe('أحمد سعيد')
    expect(cand.frozenData).toMatchObject({ currentJobTitle: 'أخصائي شؤون إدارية أول' })

    await expect(engine.addCandidate(req.id, { personnelNumber: '000101' }, hrManager)).rejects.toMatchObject({
      code: 'CANDIDATE_DUPLICATE'
    })

    await engine.removeCandidate(req.id, cand.id, hrManager)
    const detail = await engine.getRequest(req.id, hrManager)
    expect(detail.candidates).toHaveLength(0)
  })

  it('6 & 7. manager can assign subordinate in same unit, but cross-unit assignment is rejected', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    await expect(engine.assignStage(stageId, { assignedToUserId: orgSubordinate.userId }, hrManager)).rejects.toMatchObject({
      code: 'UNIT_MEMBERSHIP_REQUIRED'
    })

    const assigned = await engine.assignStage(stageId, { assignedToUserId: hrSubordinate.userId }, hrManager)
    expect(assigned.workState).toBe('ASSIGNED')
    expect(assigned.activeAssigneeUserId).toBe(hrSubordinate.userId)
  })

  it('8 & 9. reassignment ends previous assignment and old assignee immediately loses submit authority', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    await engine.assignStage(stageId, { assignedToUserId: hrSubordinate.userId }, hrManager)

    const otherHrEmp = await createOperationalAccount('hr.sub2', 'موظف ثان')
    await addMembership(otherHrEmp.userId, hrUnitId, hrManager.userId)
    await engine.assignStage(stageId, { assignedToUserId: otherHrEmp.userId, reason: 'Shift change' }, hrManager)

    await expect(engine.submitToManager(stageId, hrSubordinate)).rejects.toMatchObject({
      code: 'NOT_ACTIVE_ASSIGNEE'
    })

    const submitted = await engine.submitToManager(stageId, otherHrEmp)
    expect(submitted.workState).toBe('MANAGER_REVIEW')
  })

  it('10. current assignee can submit to manager -> MANAGER_REVIEW', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    await engine.assignStage(stageId, { assignedToUserId: hrSubordinate.userId }, hrManager)
    const submitted = await engine.submitToManager(stageId, hrSubordinate)
    expect(submitted.workState).toBe('MANAGER_REVIEW')
  })

  it('11 & 12. internal correction requires MANAGER_REVIEW state, non-empty reason, and stays inside same StageExecution', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    await engine.assignStage(stageId, { assignedToUserId: hrSubordinate.userId }, hrManager)

    // Attempting internal correction while ASSIGNED -> rejected
    await expect(engine.internalCorrection(stageId, { reason: 'يرجى التعديل' }, hrManager)).rejects.toMatchObject({
      code: 'INVALID_WORK_STATE'
    })

    // Submit to manager
    await engine.submitToManager(stageId, hrSubordinate)

    // Empty reason -> rejected
    await expect(engine.internalCorrection(stageId, { reason: '   ' }, hrManager)).rejects.toMatchObject({
      code: 'REASON_REQUIRED'
    })

    // Valid internal correction -> sets CORRECTION_REQUIRED, same stage execution
    const corrected = await engine.internalCorrection(stageId, { reason: 'يرجى مراجعة البيانات' }, hrManager)
    expect(corrected.id).toBe(stageId)
    expect(corrected.workState).toBe('CORRECTION_REQUIRED')
    expect(corrected.activeAssigneeUserId).toBe(hrSubordinate.userId)
  })

  it('13, 14 & 15. return previous creates a NEW StageExecution with incremented execution_no and preserves previous executions', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    // Close initial P1 stage
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.currentExecutionId!])

    // Create completed P2 stage
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, completed_at)
       VALUES ($1, $2, 'P2', 1, $3, 'COMPLETED', 'COMPLETED', CURRENT_TIMESTAMP)`,
      [randomUUID(), iterId, orgUnitId]
    )

    // Setup single open P3 stage
    const p3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p3ExecId, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P3' WHERE id = $1`, [req.id])

    // HR manager at P3 returns to previous stage (P2 -> ORG)
    const returned = await engine.returnPreviousStage(p3ExecId, { reason: 'إعادة مراجعة المقترح التنظيمي' }, hrManager)
    expect(returned.stageCode).toBe('P2')
    expect(returned.executionNo).toBe(2)
    expect(returned.status).toBe('OPEN')
    expect(returned.workState).toBe('MANAGER_INBOX')
    expect(returned.responsibleUnitId).toBe(orgUnitId)

    // Verify P3 execution is now RETURNED and completed_at is set
    const oldP3 = await pool!.query<{ status: string, completedAt: string | null }>(
      `SELECT status, completed_at AS "completedAt" FROM stage_execution WHERE id = $1`,
      [p3ExecId]
    )
    expect(oldP3.rows[0]!.status).toBe('RETURNED')
    expect(oldP3.rows[0]!.completedAt).not.toBeNull()
  })

  it('16. P5 return previous resolves to P4O if P4O occurred in iteration, else P4', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    // Close initial P1
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.currentExecutionId!])

    // Case A: No P4O in iteration -> returns to P4
    const p5ExecIdA = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P5', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p5ExecIdA, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P5' WHERE id = $1`, [req.id])

    const retA = await engine.returnPreviousStage(p5ExecIdA, { reason: 'Return to Auth' }, hrManager)
    expect(retA.stageCode).toBe('P4')
    expect(retA.responsibleUnitId).toBe(authUnitId)

    // Case B: P4O was present -> returns to P4O
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [retA.id])
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, completed_at)
       VALUES ($1, $2, 'P4O', 1, $3, 'COMPLETED', 'COMPLETED', CURRENT_TIMESTAMP)`,
      [randomUUID(), iterId, orgUnitId]
    )
    const p5ExecIdB = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P5', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p5ExecIdB, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P5' WHERE id = $1`, [req.id])

    const retB = await engine.returnPreviousStage(p5ExecIdB, { reason: 'Return to Org P4O' }, hrManager)
    expect(retB.stageCode).toBe('P4O')
    expect(retB.responsibleUnitId).toBe(orgUnitId)
  })

  it('17 & 18. reject closes iteration, sets REJECTED_PENDING_HR_DECISION, clears current_stage_code, and only HR manager can restart/cancel', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    const rejectedReq = await engine.rejectStage(stageId, { reason: 'طلب غير مطابق' }, hrManager)
    expect(rejectedReq.status).toBe('REJECTED_PENDING_HR_DECISION')
    expect(rejectedReq.currentStageCode).toBeNull()
    expect(rejectedReq.currentExecutionId).toBeNull()

    await expect(engine.restartRequest(req.id, hrSubordinate)).rejects.toMatchObject({
      code: 'HR_MANAGER_REQUIRED'
    })
    await expect(engine.cancelRequest(req.id, hrSubordinate)).rejects.toMatchObject({
      code: 'HR_MANAGER_REQUIRED'
    })
  })

  it('19 & 20. HR manager restart creates iteration N+1, fresh P1/S1 execution, and preserves history', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    await engine.rejectStage(req.currentExecutionId!, { reason: 'سبب الرفض' }, hrManager)

    const restarted = await engine.restartRequest(req.id, hrManager)
    expect(restarted.status).toBe('DRAFT')
    expect(restarted.currentIterationNo).toBe(2)
    expect(restarted.currentStageCode).toBe('P1')
    expect(restarted.currentWorkState).toBe('MANAGER_INBOX')

    const iter1 = await pool!.query<{ status: string, rejectionReason: string }>(
      `SELECT status, rejection_reason AS "rejectionReason" FROM workflow_iteration WHERE request_id = $1 AND iteration_no = 1`,
      [req.id]
    )
    expect(iter1.rows[0]!.status).toBe('REJECTED')
    expect(iter1.rows[0]!.rejectionReason).toBe('سبب الرفض')
  })

  it('21. HR manager cancel makes request CANCELLED final', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    await engine.rejectStage(req.currentExecutionId!, { reason: 'إلغاء الطلب' }, hrManager)

    const cancelled = await engine.cancelRequest(req.id, hrManager)
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.cancelledAt).not.toBeNull()

    await expect(engine.restartRequest(req.id, hrManager)).rejects.toMatchObject({
      code: 'REQUEST_NOT_REJECTED'
    })
  })

  it('22. replaced manager immediately loses manager command authority', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const stageId = req.currentExecutionId!

    const newHrManager = await createOperationalAccount('new.hr.manager', 'مدير الموارد الجديد')
    await addMembership(newHrManager.userId, hrUnitId, hrManager.userId)

    await pool!.query(
      `UPDATE unit_manager_assignment
          SET effective_to = CURRENT_TIMESTAMP, replacement_reason = 'Transfer'
        WHERE unit_id = $1 AND effective_to IS NULL`,
      [hrUnitId]
    )
    await assignManager(hrUnitId, newHrManager.userId, hrManager.userId)

    await expect(engine.takeStage(stageId, hrManager)).rejects.toMatchObject({
      code: 'UNIT_MANAGER_REQUIRED'
    })

    const taken = await engine.takeStage(stageId, newHrManager)
    expect(taken.workState).toBe('IN_PROGRESS')
    expect(taken.activeAssigneeUserId).toBe(newHrManager.userId)
  })

  it('23 & 24. generic approve refuses signing stages and stage completion freezes immutable submission snapshot including form sections', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const p1StageId = req.currentExecutionId!

    await expect(engine.approveAndAdvance(p1StageId, hrManager)).rejects.toMatchObject({
      code: 'SIGNATURE_REQUIRED'
    })

    // Add form section
    await pool!.query(
      `INSERT INTO request_form_section (id, request_id, category, display_order, data)
       VALUES ($1, $2, 'GENERAL', 1, '{"title": "Section 1"}'::jsonb)`,
      [randomUUID(), req.id]
    )

    // Close P1 and setup open P3
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p1StageId])

    const p3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p3ExecId, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P3' WHERE id = $1`, [req.id])

    const advanced = await engine.approveAndAdvance(p3ExecId, hrManager)
    expect(advanced.stageCode).toBe('P4')
    expect(advanced.responsibleUnitId).toBe(authUnitId)

    const snapshotCheck = await pool!.query<{ payload: any, sha256: string }>(
      `SELECT payload, sha256 FROM stage_submission_snapshot WHERE stage_execution_id = $1`,
      [p3ExecId]
    )
    expect(snapshotCheck.rows).toHaveLength(1)
    expect(snapshotCheck.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshotCheck.rows[0]!.payload.formSections).toHaveLength(1)
    expect(snapshotCheck.rows[0]!.payload.formSections[0].category).toBe('GENERAL')
  })

  it('25 & 26. stale historical execution cannot execute active-stage mutation commands', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const oldP1Id = req.currentExecutionId!
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    // Advance/transition request to P3
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [oldP1Id])
    const p3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p3ExecId, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P3' WHERE id = $1`, [req.id])

    // Attempting mutations on oldP1Id must be rejected with STAGE_NOT_OPEN or STAGE_NOT_CURRENT
    await expect(engine.assignStage(oldP1Id, { assignedToUserId: hrSubordinate.userId }, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.takeStage(oldP1Id, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.submitToManager(oldP1Id, hrSubordinate)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.internalCorrection(oldP1Id, { reason: 'Test' }, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.returnPreviousStage(oldP1Id, { reason: 'Test' }, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.rejectStage(oldP1Id, { reason: 'Test' }, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
    await expect(engine.approveAndAdvance(oldP1Id, hrManager)).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
  })

  it('27. database constraints enforce one ACTIVE iteration and one OPEN execution', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    // Attempting a second active iteration fails DB constraint
    await expect(
      pool!.query(
        `INSERT INTO workflow_iteration (id, request_id, iteration_no, status, started_at)
         VALUES ($1, $2, 2, 'ACTIVE', CURRENT_TIMESTAMP)`,
        [randomUUID(), req.id]
      )
    ).rejects.toThrow()

    // Attempting a second open stage execution fails DB constraint
    await expect(
      pool!.query(
        `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
         VALUES ($1, $2, 'P2', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
        [randomUUID(), iterId, orgUnitId]
      )
    ).rejects.toThrow()
  })

  it('28. timeline contains execution, assignment, action, snapshot, and note evidence', async () => {
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const p1StageId = req.currentExecutionId!

    await engine.assignStage(p1StageId, { assignedToUserId: hrSubordinate.userId }, hrManager)
    await engine.addNote(req.id, { body: 'Timeline test note' }, hrManager)

    const timeline = await engine.getTimeline(req.id, hrManager)
    const kinds = timeline.map(e => e.kind)

    expect(kinds).toContain('REQUEST_STATUS')
    expect(kinds).toContain('ITERATION')
    expect(kinds).toContain('STAGE_EXECUTION')
    expect(kinds).toContain('WORK_ASSIGNMENT')
    expect(kinds).toContain('STAGE_ACTION')
    expect(kinds).toContain('NOTE')
  })

  it('29. resolver is fail-closed: P3->P4 advance fails if AUTH unit is deactivated', async () => {
    // Deactivate the AUTH unit so resolver cannot find it
    await pool!.query(`UPDATE operational_unit SET is_active = FALSE WHERE id = $1`, [authUnitId])

    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
    const iterId = iterResult.rows[0]!.id

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.currentExecutionId!])
    const p3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P3', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p3ExecId, iterId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P3' WHERE id = $1`, [req.id])

    // Advance to P4 must fail because AUTH unit is deactivated
    await expect(engine.approveAndAdvance(p3ExecId, hrManager)).rejects.toMatchObject({
      code: 'RESPONSIBLE_UNIT_UNRESOLVED'
    })
  })

  it('30. positive resolver resolves P2->ORG and P4->AUTH for valid routing unit', async () => {
    const org = await resolveResponsibleOperationalUnit(pool!, 'P2', routingUnitId)
    expect(org.id).toBe(orgUnitId)
    expect(org.kind).toBe('ORG')

    const auth = await resolveResponsibleOperationalUnit(pool!, 'P4', routingUnitId)
    expect(auth.id).toBe(authUnitId)
    expect(auth.kind).toBe('AUTH')
    expect(auth.routingUnitId).toBe(routingUnitId)
  })
})
