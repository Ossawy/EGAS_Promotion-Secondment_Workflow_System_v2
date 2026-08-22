import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DataType, newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { testConfig } from './helpers/database.js'
import { WorkflowEngineService } from '../src/modules/workflow/workflow-engine-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { V5AdminService } from '../src/modules/admin/v5-admin-service.js'
import { requireAdmin } from '../src/middleware/authorize.js'
import { recordAuditEvent } from '../src/modules/audit/security-events.js'
import type { WorkflowRequestContext } from '../src/modules/workflow/workflow-types.js'

let pool: Pool | undefined
let engine: WorkflowEngineService

let routingUnitId: string
let otherRoutingUnitId: string
let hrUnitId: string
let orgUnitId: string

let hrManager: WorkflowRequestContext
let hrSubordinate: WorkflowRequestContext
let hrSubordinate2: WorkflowRequestContext
let orgManager: WorkflowRequestContext
let orgSubordinate: WorkflowRequestContext
let adminUser: WorkflowRequestContext

async function createOperationalAccount(username: string, displayName: string, isActive = true): Promise<WorkflowRequestContext> {
  if (!pool) throw new Error('Database pool is not initialized')
  const id = randomUUID()
  const authProvider = new LocalAuthenticationProvider(pool, testConfig)
  const passwordHash = await authProvider.hashPassword('Password123!')
  await pool.query(
    `INSERT INTO user_account
      (id, username, display_name, account_type, password_hash, must_change_password, is_active)
     VALUES ($1, $2, $3, 'OPERATIONAL', $4, FALSE, $5)`,
    [id, username, displayName, passwordHash, isActive]
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

async function addMembership(userId: string, unitId: string): Promise<void> {
  if (!pool) throw new Error('Database pool is not initialized')
  await pool.query(
    `INSERT INTO user_unit_membership
      (id, user_id, unit_id, effective_from, created_by_user_id)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [randomUUID(), userId, unitId, userId]
  )
}

async function assignManager(unitId: string, managerUserId: string): Promise<void> {
  if (!pool) throw new Error('Database pool is not initialized')
  await pool.query(
    `INSERT INTO unit_manager_assignment
      (id, unit_id, manager_user_id, effective_from, assigned_by_user_id)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
    [randomUUID(), unitId, managerUserId, managerUserId]
  )
}

async function insertStageExecution(options: {
  iterationId: string
  stageCode: string
  executionNo: number
  responsibleUnitId: string
  status?: string
  workState?: string
  previousExecutionId?: string | null
}): Promise<string> {
  if (!pool) throw new Error('Database pool is not initialized')
  const id = randomUUID()
  await pool.query(
    `INSERT INTO stage_execution
      (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at, completed_at, previous_execution_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP,
             CASE WHEN $6 = 'OPEN' THEN NULL ELSE CURRENT_TIMESTAMP END, $8)`,
    [
      id,
      options.iterationId,
      options.stageCode,
      options.executionNo,
      options.responsibleUnitId,
      options.status ?? 'OPEN',
      options.workState ?? 'MANAGER_INBOX',
      options.previousExecutionId ?? null
    ]
  )
  return id
}

async function insertWorkAssignment(stageExecutionId: string, assignedToUserId: string, endedAtIsNull: boolean): Promise<void> {
  if (!pool) throw new Error('Database pool is not initialized')
  await pool.query(
    `INSERT INTO work_assignment
      (id, stage_execution_id, assigned_by_user_id, assigned_to_user_id, assigned_at, ended_at, end_reason)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
    [
      randomUUID(),
      stageExecutionId,
      hrManager.userId,
      assignedToUserId,
      endedAtIsNull ? null : CURRENT_TIMESTAMP_EXPR(),
      endedAtIsNull ? null : 'STAGE_COMPLETED'
    ]
  )
}

function CURRENT_TIMESTAMP_EXPR(): unknown {
  return new Date()
}

/** Creates a minimal ACTIVE promotion request whose current stage is an OPEN P1 execution. */
async function seedReturnedP1Iteration(): Promise<{ requestId: string, iterationId: string, openExecutionId: string }> {
  if (!pool) throw new Error('Database pool is not initialized')
  const requestId = randomUUID()
  await pool.query(
    `INSERT INTO workflow_request
      (id, request_number, request_type, routing_unit_id, status, version, created_by_user_id)
     VALUES ($1, $2, 'PROMOTION', $3, 'ACTIVE', 1, $4)`,
    [requestId, `REQ-${requestId.slice(0, 8)}`, routingUnitId, hrManager.userId]
  )
  const iterationId = randomUUID()
  await pool.query(
    `INSERT INTO workflow_iteration (id, request_id, iteration_no, status, started_at)
     VALUES ($1, $2, 1, 'ACTIVE', CURRENT_TIMESTAMP)`,
    [iterationId, requestId]
  )
  await pool.query(`UPDATE workflow_request SET current_iteration_id = $2, current_stage_code = 'P1' WHERE id = $1`, [requestId, iterationId])

  // Closed prior execution of P1 worked by the given subordinate happens in individual tests.
  const openExecutionId = await insertStageExecution({
    iterationId,
    stageCode: 'P1',
    executionNo: 2,
    responsibleUnitId: hrUnitId,
    status: 'OPEN',
    workState: 'MANAGER_INBOX'
  })
  return { requestId, iterationId, openExecutionId }
}

beforeEach(async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true })
  db.public.registerFunction({ name: 'hashtext', args: [DataType.text], returns: DataType.integer, implementation: () => 1 })
  db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 })

  db.public.none(await readFile(new URL('../src/db/migrations/001_initial_v5_schema.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../src/db/migrations/002_phase2_annual_data_integrity.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../src/db/migrations/003_phase3_workflow_indexes.sql', import.meta.url), 'utf8'))
  db.public.none(await readFile(new URL('../src/db/migrations/005_audit_identity_snapshots.sql', import.meta.url), 'utf8'))

  const adapter = db.adapters.createPg()
  pool = new adapter.Pool() as unknown as Pool
  engine = new WorkflowEngineService(pool)

  routingUnitId = randomUUID()
  otherRoutingUnitId = randomUUID()
  await pool.query(`INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-01', 'نیابة تجريبية أولى', TRUE)`, [routingUnitId])
  await pool.query(`INSERT INTO routing_unit (id, code, name_ar, is_active) VALUES ($1, 'RU-02', 'نیابة تجريبية ثانية', TRUE)`, [otherRoutingUnitId])

  hrUnitId = randomUUID()
  orgUnitId = randomUUID()
  await pool.query(`INSERT INTO operational_unit (id, kind, name, is_active) VALUES ($1, 'HR', 'الوحدة البشرية التجريبية', TRUE)`, [hrUnitId])
  await pool.query(`INSERT INTO operational_unit (id, kind, name, is_active) VALUES ($1, 'ORG', 'الوحدة التنظيمية التجريبية', TRUE)`, [orgUnitId])

  hrManager = await createOperationalAccount('hr.manager', 'مدير الموارد البشرية')
  hrSubordinate = await createOperationalAccount('hr.sub.one', 'موظف أول بالبشرية')
  hrSubordinate2 = await createOperationalAccount('hr.sub.two', 'موظف ثان بالبشرية')
  orgManager = await createOperationalAccount('org.manager', 'مدير الشؤون التنظيمية')
  orgSubordinate = await createOperationalAccount('org.sub', 'موظف بالشؤون التنظيمية')
  adminUser = await createAdminAccount('admin.user', 'مدير النظام')

  await addMembership(hrManager.userId, hrUnitId)
  await addMembership(hrSubordinate.userId, hrUnitId)
  await addMembership(hrSubordinate2.userId, hrUnitId)
  await addMembership(orgManager.userId, orgUnitId)
  await addMembership(orgSubordinate.userId, orgUnitId)

  await assignManager(hrUnitId, hrManager.userId)
  await assignManager(orgUnitId, orgManager.userId)

  // Activated annual snapshot population (synthetic data only)
  const batchId = randomUUID()
  await pool.query(
    `INSERT INTO import_batch
      (id, snapshot_year, source_filename, source_sha256, detected_headers, status, row_count, activated_at)
     VALUES ($1, 2026, 'synthetic_annual_2026.xlsx', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '[]'::jsonb, 'ACTIVATED', 2, CURRENT_TIMESTAMP)`,
    [batchId]
  )
  const emp1Id = randomUUID()
  const emp2Id = randomUUID()
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000101')`, [emp1Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000102')`, [emp2Id])

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000101', $4, $5::jsonb)`,
    [
      randomUUID(), emp1Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000101',
        employeeName: 'أحمد تجريبي',
        currentJobTitle: 'أخصائي أول تجريبي',
        performanceRating: 'جيد جدا',
        performanceReportYear: 2026
      })
    ]
  )
  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000102', $4, $5::jsonb)`,
    [
      randomUUID(), emp2Id, batchId, otherRoutingUnitId,
      JSON.stringify({
        personnelNumber: '000102',
        employeeName: 'سمير تجريبي',
        currentJobTitle: 'فني تجريبي',
        performanceRating: 'ممتاز',
        performanceReportYear: 2026
      })
    ]
  )
})

afterEach(async () => {
  if (pool) {
    await pool.end()
    pool = undefined
  }
})

describe('Phase 7 bridge: GET /api/workflow/manager/subordinates semantics', () => {
  it('returns only active subordinate OPERATIONAL members of the caller managed unit, excluding managers', async () => {
    const result = await engine.getManagerSubordinates(hrManager)
    const ids = result.map(r => r.userId)
    expect(ids).toContain(hrSubordinate.userId)
    expect(ids).toContain(hrSubordinate2.userId)
    expect(ids).not.toContain(hrManager.userId)
    expect(ids).not.toContain(orgSubordinate.userId)
    expect(result[0]).toHaveProperty('displayName')
  })

  it('rejects operational non-managers and ADMIN accounts', async () => {
    await expect(engine.getManagerSubordinates(hrSubordinate)).rejects.toMatchObject({ code: 'UNIT_MANAGER_REQUIRED' })
    await expect(engine.getManagerSubordinates(adminUser)).rejects.toMatchObject({ code: 'OPERATIONAL_REQUIRED' })
  })

  it('excludes disabled subordinates immediately', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    await pool.query(`UPDATE user_account SET is_active = FALSE WHERE id = $1`, [hrSubordinate2.userId])
    const result = await engine.getManagerSubordinates(hrManager)
    expect(result.map(r => r.userId)).not.toContain(hrSubordinate2.userId)
  })

  it('denies a replaced manager immediately', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    await pool.query(
      `UPDATE unit_manager_assignment SET effective_to = CURRENT_TIMESTAMP WHERE unit_id = $1 AND effective_to IS NULL`,
      [hrUnitId]
    )
    await pool.query(
      `INSERT INTO unit_manager_assignment (id, unit_id, manager_user_id, effective_from, assigned_by_user_id, replacement_reason)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, 'synthetic-replacement')`,
      [randomUUID(), hrUnitId, hrSubordinate.userId, hrManager.userId]
    )
    await expect(engine.getManagerSubordinates(hrManager)).rejects.toMatchObject({ code: 'UNIT_MANAGER_REQUIRED' })
    const newList = await engine.getManagerSubordinates(hrSubordinate)
    expect(newList.map(r => r.userId)).toContain(hrSubordinate2.userId)
  })
})

describe('Phase 7 bridge: Manager Inbox previous-worker suggestion', () => {
  async function seedClosedPriorExecution(iterationId: string, workerUserId: string, disableWorker = false): Promise<string> {
    if (!pool) throw new Error('Database pool is not initialized')
    if (disableWorker && !workerUserId.includes('-')) throw new Error('unexpected')
    const priorExecutionId = await insertStageExecution({
      iterationId,
      stageCode: 'P1',
      executionNo: 1,
      responsibleUnitId: hrUnitId,
      status: 'COMPLETED',
      workState: 'COMPLETED'
    })
    await insertWorkAssignment(priorExecutionId, workerUserId, false)
    return priorExecutionId
  }

  it('suggests the prior worker while they remain an eligible member of the responsible unit', async () => {
    const { openExecutionId } = await seedReturnedP1Iteration()
    await seedClosedPriorExecution((await pool!.query(`SELECT iteration_id FROM stage_execution WHERE id = $1`, [openExecutionId])).rows[0]!.iteration_id, hrSubordinate.userId)

    const inbox = await engine.getManagerInbox(hrManager)
    const stage = inbox.stages.find(s => s.id === openExecutionId)
    expect(stage).toBeDefined()
    expect(stage!.suggestedAssigneeUserId).toBe(hrSubordinate.userId)
    expect(stage!.suggestedAssigneeDisplayName).toBe('موظف أول بالبشرية')

    const assignments = await pool!.query(`SELECT COUNT(*)::int AS count FROM work_assignment WHERE stage_execution_id = $1`, [openExecutionId])
    expect(Number(assignments.rows[0]!.count)).toBe(0)
  })

  it('returns null when the prior worker belongs to another unit', async () => {
    const { iterationId, openExecutionId } = await seedReturnedP1Iteration()
    await seedClosedPriorExecution(iterationId, orgSubordinate.userId)

    const inbox = await engine.getManagerInbox(hrManager)
    const stage = inbox.stages.find(s => s.id === openExecutionId)
    expect(stage!.suggestedAssigneeUserId).toBeNull()
  })

  it('returns null when the prior worker account is disabled', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    const { iterationId, openExecutionId } = await seedReturnedP1Iteration()
    const disabledWorker = await createOperationalAccount('hr.disabled.worker', 'موظف موقوف', false)
    await addMembership(disabledWorker.userId, hrUnitId)
    await seedClosedPriorExecution(iterationId, disabledWorker.userId)

    const inbox = await engine.getManagerInbox(hrManager)
    const stage = inbox.stages.find(s => s.id === openExecutionId)
    expect(stage!.suggestedAssigneeUserId).toBeNull()
  })

  it('remains only a suggestion: assigning another valid subordinate still works', async () => {
    const { iterationId, openExecutionId } = await seedReturnedP1Iteration()
    await seedClosedPriorExecution(iterationId, hrSubordinate.userId)

    const assigned = await engine.assignStage(openExecutionId, { assignedToUserId: hrSubordinate2.userId }, hrManager)
    expect(assigned.activeAssigneeUserId).toBe(hrSubordinate2.userId)
    expect(assigned.workState).toBe('ASSIGNED')

    const myWork = await engine.getMyWork(hrSubordinate2)
    expect(myWork.map(s => s.id)).toContain(openExecutionId)
  })
})

describe('Phase 7 bridge: request-scoped candidate lookup preview', () => {
  it('applies request history search/type/status filters inside the authorized server query', async () => {
    const promotion=await engine.createRequest({requestType:'PROMOTION',routingUnitId},hrManager)
    await engine.createRequest({requestType:'SECONDMENT',routingUnitId},hrManager)
    const byType=await engine.listRequests(hrManager,0,50,{requestType:'PROMOTION'})
    expect(byType.map(request=>request.requestType)).toEqual(['PROMOTION'])
    const byStatus=await engine.listRequests(hrManager,0,50,{status:'DRAFT'})
    expect(byStatus).toHaveLength(2)
    const byNumber=await engine.listRequests(hrManager,0,50,{query:promotion.requestNumber})
    expect(byNumber.map(request=>request.id)).toEqual([promotion.id])
  })

  it('previews the frozen snapshot without mutating the request', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const preview = await engine.lookupCandidatePreview(request.id, '000101', hrManager)

    expect(preview.personnelNumber).toBe('000101')
    expect(preview.employeeName).toBe('أحمد تجريبي')
    expect(preview.snapshotYear).toBe(2026)
    expect(preview.routingUnitMatchesRequest).toBe(true)
    expect(preview.alreadyAddedToRequest).toBe(false)
    expect(preview.frozenData).toMatchObject({ currentJobTitle: 'أخصائي أول تجريبي' })

    const detail = await engine.getRequest(request.id, hrManager)
    expect(detail.candidates).toHaveLength(0)
  })

  it('addCandidate revalidates independently after a successful preview', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    await engine.lookupCandidatePreview(request.id, '000101', hrManager)

    const added = await engine.addCandidate(request.id, { personnelNumber: '000101' }, hrManager)
    expect(added.personnelNumber).toBe('000101')

    const previewAfterAdd = await engine.lookupCandidatePreview(request.id, '000101', hrManager)
    expect(previewAfterAdd.alreadyAddedToRequest).toBe(true)
  })

  it('rejects cross-routing employees with CANDIDATE_ROUTING_MISMATCH', async () => {
    const request = await engine.createRequest({ requestType: 'SECONDMENT', routingUnitId }, hrManager)
    await expect(engine.lookupCandidatePreview(request.id, '000102', hrManager))
      .rejects.toMatchObject({ code: 'CANDIDATE_ROUTING_MISMATCH' })
  })

  it('mirrors addCandidate authorization and state gates', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)

    await expect(engine.lookupCandidatePreview(request.id, '000101', orgManager))
      .rejects.toMatchObject({ code: 'NOT_ACTIVE_ASSIGNEE' })
    await expect(engine.lookupCandidatePreview(request.id, '000101', adminUser))
      .rejects.toMatchObject({ code: 'OPERATIONAL_REQUIRED' })
    await expect(engine.lookupCandidatePreview(request.id, '999999', hrManager))
      .rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND' })

    if (!pool) throw new Error('Database pool is not initialized')
    await pool.query(`UPDATE workflow_request SET status = 'ACTIVE' WHERE id = $1`, [request.id])
    await expect(engine.lookupCandidatePreview(request.id, '000101', hrManager))
      .rejects.toMatchObject({ code: 'REQUEST_NOT_DRAFT' })
  })
})

describe('clarified initial HR lifecycle and internal correction ownership', () => {
  it('assigns initial P1/S1 to an HR employee, then submits to HR manager review', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrSubordinate)
    expect(request.currentWorkState).toBe('IN_PROGRESS')
    expect((await engine.getMyWork(hrSubordinate)).map(stage => stage.id)).toContain(request.currentExecutionId)
    await engine.addCandidate(request.id, { personnelNumber: '000101' }, hrSubordinate)

    const submitted = await engine.submitToManager(request.currentExecutionId!, hrSubordinate)
    expect(submitted.workState).toBe('MANAGER_REVIEW')
    expect((await engine.getManagerInbox(hrManager)).stages.find(stage => stage.id === submitted.id)?.workState).toBe('MANAGER_REVIEW')
  })

  it('persists correction evidence and supports previous employee, another employee, and manager self-work', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrSubordinate)
    const stageId = request.currentExecutionId!
    await engine.submitToManager(stageId, hrSubordinate)

    const same = await engine.internalCorrection(stageId, { reason: 'استكمال البيان الناقص', assignedToUserId: hrSubordinate.userId }, hrManager)
    expect(same.workState).toBe('CORRECTION_REQUIRED')
    expect(same.activeAssigneeUserId).toBe(hrSubordinate.userId)
    expect(same.correctionReason).toBe('استكمال البيان الناقص')
    expect(same.correctionPreviousAssigneeUserId).toBe(hrSubordinate.userId)

    await engine.submitToManager(stageId, hrSubordinate)
    const other = await engine.internalCorrection(stageId, { reason: 'مراجعة ثانية', assignedToUserId: hrSubordinate2.userId }, hrManager)
    expect(other.activeAssigneeUserId).toBe(hrSubordinate2.userId)
    expect((await engine.getMyWork(hrSubordinate2))[0]?.correctionReason).toBe('مراجعة ثانية')

    await engine.submitToManager(stageId, hrSubordinate2)
    const self = await engine.internalCorrection(stageId, { reason: 'تعديل مباشر', managerHandlesPersonally: true }, hrManager)
    expect(self.activeAssigneeUserId).toBe(hrManager.userId)
    expect(self.workState).toBe('IN_PROGRESS')
    expect(self.managerHandledCorrectionPersonally).toBe(true)
  })

  it('rejects cross-unit correction assignment without changing the active assignment', async () => {
    const request = await engine.createRequest({ requestType: 'SECONDMENT', routingUnitId }, hrSubordinate)
    const stageId = request.currentExecutionId!
    await engine.submitToManager(stageId, hrSubordinate)
    await expect(engine.internalCorrection(stageId, { reason: 'غير مسموح', assignedToUserId: orgSubordinate.userId }, hrManager))
      .rejects.toMatchObject({ code: 'UNIT_MEMBERSHIP_REQUIRED' })
    expect((await engine.getManagerInbox(hrManager)).stages.find(stage => stage.id === stageId)?.activeAssigneeUserId).toBe(hrSubordinate.userId)
  })
})

describe('admin account profile editing and historical evidence', () => {
  it('denies OPERATIONAL accounts at the Admin router authorization boundary', () => {
    const next = vi.fn()
    requireAdmin({} as any, { locals: { auth: { userId: hrSubordinate.userId, accountType: 'OPERATIONAL', mustChangePassword: false } } } as any, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'ADMIN_REQUIRED' }))
  })

  it('builds admin dashboard metrics from current v5 tables', async () => {
    const summary = await new V5AdminService(pool!, testConfig).dashboard({ userId: adminUser.userId }) as any
    expect(summary.accounts).toMatchObject({ total: 6, active: 6, inactive: 0, locked: 0 })
    expect(summary.operationalUnits).toMatchObject({ HR: 1, ORG: 1, AUTH: 0, total: 2 })
    expect(summary.activeSnapshot).toMatchObject({ snapshotYear: 2026, employeeCount: 2 })
    expect(summary.notifications).toMatchObject({ unread: 0, recent: [] })
  })

  it('paginates and filters the immutable admin audit log', async () => {
    const admin = new V5AdminService(pool!, testConfig)
    const page = await admin.auditLog({ skip: 0, top: 5, eventType: 'LOGIN_SUCCEEDED', actor: null, from: null, to: null })
    expect(page.top).toBe(5)
    expect(page.skip).toBe(0)
    expect(page.items.length).toBeLessThanOrEqual(5)
    expect(page.items.every((item: any) => item.eventType === 'LOGIN_SUCCEEDED')).toBe(true)
    expect(page.total).toBeGreaterThanOrEqual(page.items.length)
  })

  it('filters audit events by actor and date without leaking technical lookup work to the client', async () => {
    const admin = new V5AdminService(pool!, testConfig)
    await pool!.query(`INSERT INTO audit_event(id,actor_user_id,event_type,subject_type,subject_id,details) VALUES($1,$2,'ACCOUNT_UPDATED','user_account',$3,'{}')`, [randomUUID(), adminUser.userId, hrManager.userId])
    const page = await admin.auditLog({ skip: 0, top: 25, eventType: null, actor: adminUser.username, from: '2020-01-01', to: '2030-12-31' })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.every((item: any) => item.actorDisplayName || item.actorUsername)).toBe(true)
    expect(page.items[0]).toHaveProperty('subjectLabel')
    expect(page.items[0]).toHaveProperty('requestNumber')
  })

  it('keeps frozen attribution after profile changes and strips sensitive audit metadata from the Admin API', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    const before = (await pool.query(`SELECT display_name AS "displayName" FROM user_account WHERE id=$1`, [adminUser.userId])).rows[0]
    const subjectBefore = (await pool.query(`SELECT display_name AS "displayName" FROM user_account WHERE id=$1`, [hrManager.userId])).rows[0]
    await pool.query(`UPDATE user_account SET job_title='المسمى التاريخي' WHERE id=$1`, [adminUser.userId])
    await recordAuditEvent(pool, {
      actorUserId: adminUser.userId,
      eventType: 'ACCOUNT_UPDATED',
      subjectType: 'user_account',
      subjectId: hrManager.userId,
      details: {
        reason: 'مراجعة إدارية',
        password: 'must-never-leave-the-server',
        passwordHash: 'hash-must-never-leave-the-server',
        sessionToken: 'token-must-never-leave-the-server',
        csrfSecret: 'csrf-must-never-leave-the-server',
        authenticationFingerprint: 'fingerprint-must-never-leave-the-server',
        signatureBinary: 'binary-must-never-leave-the-server'
      }
    })
    await pool.query(`UPDATE user_account SET display_name='اسم إداري حالي',job_title='مسمى حالي',is_active=FALSE WHERE id=$1`, [adminUser.userId])
    await pool.query(`UPDATE user_account SET display_name='اسم موضوع حالي' WHERE id=$1`, [hrManager.userId])

    const page = await new V5AdminService(pool, testConfig).auditLog({ skip: 0, top: 25, eventType: 'ACCOUNT_UPDATED', actor: adminUser.username, from: null, to: null })
    const item = page.items.find((candidate: any) => candidate.details.reason === 'مراجعة إدارية') as any
    expect(item).toMatchObject({
      actorDisplayName: before.displayName,
      actorJobTitle: 'المسمى التاريخي',
      subjectLabel: subjectBefore.displayName,
      details: { reason: 'مراجعة إدارية' }
    })
    const serialized = JSON.stringify(item)
    for (const forbidden of ['must-never', 'passwordHash', 'sessionToken', 'csrfSecret', 'authenticationFingerprint', 'signatureBinary']) {
      expect(serialized).not.toContain(forbidden)
    }
    const stored = (await pool.query(`SELECT actor_snapshot,subject_snapshot FROM audit_event WHERE id=$1`, [item.id])).rows[0]
    expect(stored.actor_snapshot).toMatchObject({ displayName: before.displayName, jobTitle: 'المسمى التاريخي' })
    expect(stored.subject_snapshot).toMatchObject({ displayName: subjectBefore.displayName })
  })

  it('returns immutable identifiers for unresolved subjects so the UI can show a safe abbreviated fallback', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    const subjectId = randomUUID()
    await pool.query(`INSERT INTO audit_event(id,event_type,subject_type,subject_id,details) VALUES($1,'UNRESOLVED_REFERENCE','removed_entity',$2,'{}')`, [randomUUID(), subjectId])
    const page = await new V5AdminService(pool, testConfig).auditLog({ skip: 0, top: 25, eventType: 'UNRESOLVED_REFERENCE', actor: null, from: null, to: null })
    expect(page.items[0]).toMatchObject({ subjectId, subjectLabel: null, actorUserId: null })
  })

  it('updates current name/title, audits changed fields, and leaves membership/manager/signoff snapshots unchanged', async () => {
    if (!pool) throw new Error('Database pool is not initialized')
    const admin = new V5AdminService(pool, testConfig)
    const membershipBefore = (await pool.query(`SELECT id,unit_id FROM user_unit_membership WHERE user_id=$1 AND effective_to IS NULL`, [hrManager.userId])).rows[0]
    const managerBefore = (await pool.query(`SELECT id FROM unit_manager_assignment WHERE manager_user_id=$1 AND effective_to IS NULL`, [hrManager.userId])).rows[0]
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const assetId = randomUUID()
    await pool.query(`INSERT INTO user_signature_asset(id,user_id,storage_key,mime_type,byte_size,sha256,is_active) VALUES($1,$2,$3,'image/png',10,$4,TRUE)`, [assetId, hrManager.userId, `${randomUUID()}.png`, 'b'.repeat(64)])
    await pool.query(`INSERT INTO workflow_signoff(id,stage_execution_id,signer_user_id,manager_assignment_id,signer_snapshot,signature_asset_id,signature_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [randomUUID(), request.currentExecutionId, hrManager.userId, managerBefore.id, JSON.stringify({ signerName: 'مدير الموارد البشرية', signerJobTitle: 'المسمى التاريخي' }), assetId, 'b'.repeat(64)])

    const updated = await admin.updateAccount({ userId: adminUser.userId }, hrManager.userId, { staffIdentifier: null, displayName: 'الاسم الحالي المعدل', jobTitle: 'المسمى الحالي المعدل' }, { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: randomUUID() })
    expect(updated).toMatchObject({ displayName: 'الاسم الحالي المعدل', jobTitle: 'المسمى الحالي المعدل' })
    expect((await pool.query(`SELECT id,unit_id FROM user_unit_membership WHERE user_id=$1 AND effective_to IS NULL`, [hrManager.userId])).rows[0]).toEqual(membershipBefore)
    expect((await pool.query(`SELECT id FROM unit_manager_assignment WHERE manager_user_id=$1 AND effective_to IS NULL`, [hrManager.userId])).rows[0]).toEqual(managerBefore)
    expect((await pool.query(`SELECT signer_snapshot FROM workflow_signoff WHERE stage_execution_id=$1`, [request.currentExecutionId])).rows[0].signer_snapshot).toMatchObject({ signerName: 'مدير الموارد البشرية', signerJobTitle: 'المسمى التاريخي' })
    expect((await pool.query(`SELECT details FROM audit_event WHERE event_type='ACCOUNT_UPDATED' ORDER BY created_at DESC LIMIT 1`)).rows[0].details.changedFields).toEqual(expect.arrayContaining(['displayName', 'jobTitle']))
  })

  it('rejects an empty display name', async () => {
    const admin = new V5AdminService(pool!, testConfig)
    await expect(admin.updateAccount({ userId: adminUser.userId }, hrManager.userId, { displayName: ' ', jobTitle: 'x' }, { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: randomUUID() })).rejects.toMatchObject({ status: 400 })
  })
})

describe('Phase 7 bridge: request signoffs read surface', () => {
  it('returns frozen signer snapshots across iterations without sensitive material', async () => {
    if (!pool) throw new Error('Database pool is not initialized')

    const assetId = randomUUID()
    await pool.query(
      `INSERT INTO user_signature_asset (id, user_id, storage_key, mime_type, byte_size, sha256, is_active)
       VALUES ($1, $2, 'synthetic-signature.png', 'image/png', 1024, $3, TRUE)`,
      [assetId, hrManager.userId, 'a'.repeat(64)]
    )

    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO workflow_request
        (id, request_number, request_type, routing_unit_id, status, version, created_by_user_id)
       VALUES ($1, $2, 'PROMOTION', $3, 'ACTIVE', 1, $4)`,
      [requestId, `REQ-S-${requestId.slice(0, 8)}`, routingUnitId, hrManager.userId]
    )

    const iteration1 = randomUUID()
    await pool.query(
      `INSERT INTO workflow_iteration (id, request_id, iteration_no, status, started_at)
       VALUES ($1, $2, 1, 'COMPLETED', CURRENT_TIMESTAMP)`,
      [iteration1, requestId]
    )
    await pool.query(`UPDATE workflow_request SET current_iteration_id = $2, current_stage_code = 'P1' WHERE id = $1`, [requestId, iteration1])
    const exec1 = await insertStageExecution({ iterationId: iteration1, stageCode: 'P1', executionNo: 1, responsibleUnitId: hrUnitId, status: 'COMPLETED', workState: 'COMPLETED' })

    const iteration2 = randomUUID()
    await pool.query(
      `INSERT INTO workflow_iteration (id, request_id, iteration_no, parent_iteration_id, status, started_at)
       VALUES ($1, $2, 2, $3, 'ACTIVE', CURRENT_TIMESTAMP)`,
      [iteration2, requestId, iteration1]
    )
    const exec2 = await insertStageExecution({ iterationId: iteration2, stageCode: 'P1', executionNo: 1, responsibleUnitId: hrUnitId, status: 'OPEN', workState: 'MANAGER_INBOX' })

    for (const [executionId, overridden] of [[exec1, false], [exec2, true]] as const) {
      await pool.query(
        `INSERT INTO workflow_signoff
          (id, stage_execution_id, signer_user_id, manager_assignment_id, signer_snapshot, signature_asset_id, signature_sha256, signed_at)
          VALUES ($1, $2, $3, NULL, $4::jsonb, $5, $6, CURRENT_TIMESTAMP)`,
        [
          randomUUID(),
          executionId,
          hrManager.userId,
          JSON.stringify({
            signerUserId: hrManager.userId,
            signerUsername: hrManager.username,
            signerName: 'مدير الموارد البشرية',
            signerJobTitle: overridden ? 'قائد عام مؤقت' : 'مدير إدارة الموارد البشرية',
            jobTitleWasOverridden: overridden,
            operationalUnitId: hrUnitId,
            operationalUnitKind: 'HR',
            signatureAssetId: assetId
          }),
          assetId,
          'b'.repeat(64)
        ]
      )
    }

    const signoffs = await engine.getRequestSignoffs(requestId, hrManager)
    expect(signoffs).toHaveLength(2)
    expect(signoffs[0]!.stageCode).toBe('P1')
    expect(signoffs[0]!.signerDisplayName).toBe('مدير الموارد البشرية')
    expect(signoffs[0]!.signerJobTitle).toBe('مدير إدارة الموارد البشرية')
    expect(signoffs[0]!.jobTitleWasOverridden).toBe(false)
    expect(signoffs[1]!.jobTitleWasOverridden).toBe(true)
    expect(signoffs[1]!.signatureAssetId).toBe(assetId)
    expect(typeof signoffs[0]!.signedAt).toBe('string')

    for (const view of signoffs) {
      const serialized = JSON.stringify(view)
      expect(serialized).not.toContain('signatureSha256')
      expect(serialized).not.toContain('storageKey')
      expect(serialized).not.toContain('sha256')
      expect(serialized).not.toContain('password')
    }
  })

  it('denies unrelated users with REQUEST_NOT_FOUND', async () => {
    const request = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    await expect(engine.getRequestSignoffs(request.id, orgSubordinate))
      .rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' })
  })
})
