import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { DataType, newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { testConfig } from './helpers/database.js'
import { WorkflowEngineService } from '../src/modules/workflow/workflow-engine-service.js'
import { PromotionWorkflowService } from '../src/modules/workflow/promotion-workflow-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import type { WorkflowRequestContext } from '../src/modules/workflow/workflow-types.js'
import { exactObject } from '../src/shared/validation.js'

let pool: Pool | undefined
let engine: WorkflowEngineService
let promotion: PromotionWorkflowService

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

  // 1. Create Routing Units
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
     VALUES ($1, 2026, 'annual_2026.xlsx', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '[]'::jsonb, 'ACTIVATED', 3, CURRENT_TIMESTAMP)`,
    [batchId]
  )

  const emp1Id = randomUUID()
  const emp2Id = randomUUID()
  const emp3Id = randomUUID()
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000101')`, [emp1Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000102')`, [emp2Id])
  await pool.query(`INSERT INTO employee (id, personnel_number) VALUES ($1, '000103')`, [emp3Id])

  snapshot1Id = randomUUID()
  snapshot2Id = randomUUID()
  crossRoutingSnapshotId = randomUUID()

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000101', $4, $5::jsonb)`,
    [
      snapshot1Id, emp1Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000101',
        employeeName: 'أحمد محمود علي',
        currentJobTitle: 'أخصائي شئون إدارية ثالث'
      })
    ]
  )

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000102', $4, $5::jsonb)`,
    [
      snapshot2Id, emp2Id, batchId, routingUnitId,
      JSON.stringify({
        personnelNumber: '000102',
        employeeName: 'سارة إبراهيم حسن',
        currentJobTitle: 'باحث تنظيم وإدارة ثان'
      })
    ]
  )

  await pool.query(
    `INSERT INTO employee_annual_snapshot
      (id, employee_id, import_batch_id, snapshot_year, personnel_number, routing_unit_id, employee_data)
     VALUES ($1, $2, $3, 2026, '000103', $4, $5::jsonb)`,
    [
      crossRoutingSnapshotId, emp3Id, batchId, otherRoutingUnitId,
      JSON.stringify({
        personnelNumber: '000103',
        employeeName: 'خالد عبد الله عمر',
        currentJobTitle: 'محاسب مالي أول'
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
 * Helper to advance a request through synthetic stage setup to P4
 */
async function setupRequestAtP4(): Promise<{
  requestId: string
  iterationId: string
  p4StageExecutionId: string
  candidate1Id: string
  candidate2Id: string
}> {
  const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
  const cand1 = await engine.addCandidate(req.id, { personnelNumber: '000101' }, hrManager)
  const cand2 = await engine.addCandidate(req.id, { personnelNumber: '000102' }, hrManager)

  const iterResult = await pool!.query<{ id: string }>(`SELECT id FROM workflow_iteration WHERE request_id = $1`, [req.id])
  const iterId = iterResult.rows[0]!.id

  // Close P1
  await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.currentExecutionId!])

  // Create completed P2
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, completed_at)
     VALUES ($1, $2, 'P2', 1, $3, 'COMPLETED', 'COMPLETED', CURRENT_TIMESTAMP)`,
    [randomUUID(), iterId, orgUnitId]
  )

  // Create completed P3
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, completed_at)
     VALUES ($1, $2, 'P3', 1, $3, 'COMPLETED', 'COMPLETED', CURRENT_TIMESTAMP)`,
    [randomUUID(), iterId, hrUnitId]
  )

  // Create OPEN P4
  const p4ExecId = randomUUID()
  await pool!.query(
    `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
     VALUES ($1, $2, 'P4', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
    [p4ExecId, iterId, authUnitId]
  )
  await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4', status = 'ACTIVE' WHERE id = $1`, [req.id])

  return {
    requestId: req.id,
    iterationId: iterId,
    p4StageExecutionId: p4ExecId,
    candidate1Id: cand1.id,
    candidate2Id: cand2.id
  }
}

describe('Phase 4 Promotion Decisions and Conditional P4O Workflow', () => {
  it('1. Promotion decision API refuses SECONDMENT request', async () => {
    const req = await engine.createRequest({ requestType: 'SECONDMENT', routingUnitId }, hrManager)
    const cand = await engine.addCandidate(req.id, { personnelNumber: '000101' }, hrManager)

    await expect(
      promotion.upsertDecision(
        req.currentExecutionId!,
        cand.id,
        { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
        hrManager
      )
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST_TYPE'
    })

    await expect(
      promotion.getAuthoritativeDecisions(req.id, hrManager)
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST_TYPE'
    })
  })

  it('2. Decision can only be edited in current OPEN P4 execution', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    // At P4 -> succeeds
    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    expect(saved.decisionType).toBe('SAME_POSITION')
    expect(saved.recommendation).toBe('ترشيح')

    // On non-P4 stage execution -> fails with STAGE_NOT_P4
    const req = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const cand = await engine.addCandidate(req.id, { personnelNumber: '000101' }, hrManager)
    await expect(
      promotion.upsertDecision(
        req.currentExecutionId!,
        cand.id,
        { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
        hrManager
      )
    ).rejects.toMatchObject({
      code: 'STAGE_NOT_P4'
    })
  })

  it('3. Current AUTH manager can edit decisions', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح للمستوى الأعلى' },
      authManager
    )
    expect(saved.recommendation).toBe('ترشيح للمستوى الأعلى')
    expect(saved.effectiveNominatedJob).toBe('أخصائي شئون إدارية ثالث')
  })

  it('4. Current active AUTH assignee can edit decisions', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    // Assign P4 to authSubordinate
    await engine.assignStage(p4StageExecutionId, { assignedToUserId: authSubordinate.userId }, authManager)

    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح من الموظف المختص' },
      authSubordinate
    )
    expect(saved.recommendation).toBe('ترشيح من الموظف المختص')
  })

  it('5. Reassigned/old assignee immediately loses edit authority', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    await engine.assignStage(p4StageExecutionId, { assignedToUserId: authSubordinate.userId }, authManager)

    // Reassign to another user
    const otherAuthSub = await createOperationalAccount('auth.sub2', 'موظف نيابة ثان')
    await addMembership(otherAuthSub.userId, authUnitId, authManager.userId)
    await engine.assignStage(p4StageExecutionId, { assignedToUserId: otherAuthSub.userId }, authManager)

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
        authSubordinate
      )
    ).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED_STAGE_EDITOR'
    })

    const savedByNew = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      otherAuthSub
    )
    expect(savedByNew.id).toBeDefined()
  })

  it('6. Replaced manager immediately loses edit authority', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    const newAuthManager = await createOperationalAccount('new.auth.mgr', 'مدير النيابة الجديد')
    await addMembership(newAuthManager.userId, authUnitId, authManager.userId)

    // End old manager assignment and assign new manager
    await pool!.query(
      `UPDATE unit_manager_assignment
          SET effective_to = CURRENT_TIMESTAMP, replacement_reason = 'Transfer'
        WHERE unit_id = $1 AND effective_to IS NULL`,
      [authUnitId]
    )
    await assignManager(authUnitId, newAuthManager.userId, authManager.userId)

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED_STAGE_EDITOR'
    })

    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      newAuthManager
    )
    expect(saved.id).toBeDefined()
  })

  it('7. Candidate from another request is rejected', async () => {
    const { p4StageExecutionId } = await setupRequestAtP4()

    // Create a second request with another candidate
    const req2 = await engine.createRequest({ requestType: 'PROMOTION', routingUnitId }, hrManager)
    const foreignCand = await engine.addCandidate(req2.id, { personnelNumber: '000102' }, hrManager)

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        foreignCand.id,
        { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      code: 'CANDIDATE_NOT_IN_REQUEST'
    })
  })

  it('8. SAME_POSITION stores NULL target and resolves effective nominated job from frozen current job', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    expect(saved.targetJobTitle).toBeNull()
    expect(saved.effectiveNominatedJob).toBe('أخصائي شئون إدارية ثالث')

    const dbRow = await pool!.query<{ target_job_title: string | null }>(
      `SELECT target_job_title FROM promotion_decision WHERE stage_execution_id = $1 AND candidate_id = $2`,
      [p4StageExecutionId, candidate1Id]
    )
    expect(dbRow.rows[0]!.target_job_title).toBeNull()
  })

  it('9. SAME_POSITION cannot smuggle another target job', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', targetJobTitle: 'وظيفة أخرى', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      code: 'TARGET_JOB_NOT_ALLOWED'
    })
  })

  it('10. OTHER_POSITION requires non-empty targetJobTitle', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'OTHER_POSITION', targetJobTitle: '', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/targetJobTitle/i)
    })

    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'OTHER_POSITION', targetJobTitle: '   ', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/targetJobTitle/i)
    })

    const tooLong = 'أ'.repeat(241)
    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'OTHER_POSITION', targetJobTitle: tooLong, recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/targetJobTitle/i)
    })
  })

  it('11. OTHER_POSITION target must differ from current job', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    // Candidate 1 current job is 'أخصائي شئون إدارية ثالث'
    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'OTHER_POSITION', targetJobTitle: 'أخصائي شئون إدارية ثالث', recommendation: 'ترشيح' },
        authManager
      )
    ).rejects.toMatchObject({
      code: 'TARGET_JOB_MUST_DIFFER'
    })

    // Valid different target job
    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'أخصائي شئون إدارية ثان', recommendation: 'ترشيح' },
      authManager
    )
    expect(saved.targetJobTitle).toBe('أخصائي شئون إدارية ثان')
    expect(saved.effectiveNominatedJob).toBe('أخصائي شئون إدارية ثان')
  })

  it('12. write endpoint rejects targetRoutingUnitId as unexpected', async () => {
    // Verify that exactObject allowlist at the route boundary rejects targetRoutingUnitId
    const routeSource = await readFile(new URL('../src/modules/workflow/workflow-routes.ts', import.meta.url), 'utf8')
    expect(routeSource).toContain("exactObject(req.body, ['decisionType', 'targetJobTitle', 'recommendation', 'notes'])")

    expect(() => {
      exactObject(
        {
          decisionType: 'OTHER_POSITION',
          targetJobTitle: 'أخصائي شئون إدارية ثان',
          recommendation: 'ترشيح',
          targetRoutingUnitId: otherRoutingUnitId
        },
        ['decisionType', 'targetJobTitle', 'recommendation', 'notes']
      )
    }).toThrowError(/Unknown field: targetRoutingUnitId/i)
  })

  it('13. recommendation validation requires non-empty text, max 80 characters', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    // Empty or whitespace-only rejected
    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', recommendation: '   ' },
        authManager
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/recommendation/i)
    })

    // > 80 characters rejected
    const tooLong = 'أ'.repeat(81)
    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', recommendation: tooLong },
        authManager
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/recommendation/i)
    })

    // Valid recommendation accepted
    const valid = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    expect(valid.recommendation).toBe('ترشيح')
  })

  it('14. repeated save updates only the row for the SAME current P4 execution', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    const first = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح أول' },
      authManager
    )

    const updated = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'رئيس قسم الإدارة', recommendation: 'ترشيح معدل', notes: 'ملاحظة' },
      authManager
    )

    expect(updated.id).toBe(first.id)
    expect(updated.decisionType).toBe('OTHER_POSITION')
    expect(updated.targetJobTitle).toBe('رئيس قسم الإدارة')
    expect(updated.recommendation).toBe('ترشيح معدل')
    expect(updated.notes).toBe('ملاحظة')

    const countResult = await pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM promotion_decision WHERE stage_execution_id = $1`,
      [p4StageExecutionId]
    )
    expect(Number(countResult.rows[0]!.count)).toBe(1)
  })

  it('15. historical P4 decisions cannot be edited after return', async () => {
    const { p4StageExecutionId, candidate1Id, requestId, iterationId } = await setupRequestAtP4()

    // Save decision at P4
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    // Return P4 -> P3
    await pool!.query(`UPDATE stage_execution SET status = 'RETURNED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])
    const p3ExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P3', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p3ExecId, iterationId, hrUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P3' WHERE id = $1`, [requestId])

    // Attempting edit on historical returned P4 execution must fail
    await expect(
      promotion.upsertDecision(
        p4StageExecutionId,
        candidate1Id,
        { decisionType: 'SAME_POSITION', recommendation: 'تعديل غير مسموح' },
        authManager
      )
    ).rejects.toMatchObject({
      code: expect.stringMatching(/STAGE_NOT_OPEN|STAGE_NOT_CURRENT/)
    })
  })

  it('16. new P4 execution gets fresh decision rows and history remains immutable', async () => {
    const { p4StageExecutionId, candidate1Id, requestId, iterationId } = await setupRequestAtP4()

    // P4 execution 1
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'قرار الإصدار 1' },
      authManager
    )

    // Return to P3 then advance to P4 execution 2
    await pool!.query(`UPDATE stage_execution SET status = 'RETURNED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])
    const p4Exec2Id = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4', 2, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4Exec2Id, iterationId, authUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4' WHERE id = $1`, [requestId])

    // Save decision on P4 execution 2
    await promotion.upsertDecision(
      p4Exec2Id,
      candidate1Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'مدير إدارة مساعد', recommendation: 'قرار الإصدار 2' },
      authManager
    )

    // Both execution decisions exist independently in DB
    const oldDec = await pool!.query<{ decision_type: string, recommendation: string }>(
      `SELECT decision_type, recommendation FROM promotion_decision WHERE stage_execution_id = $1`,
      [p4StageExecutionId]
    )
    expect(oldDec.rows[0]!.decision_type).toBe('SAME_POSITION')
    expect(oldDec.rows[0]!.recommendation).toBe('قرار الإصدار 1')

    const newDec = await pool!.query<{ decision_type: string, recommendation: string }>(
      `SELECT decision_type, recommendation FROM promotion_decision WHERE stage_execution_id = $1`,
      [p4Exec2Id]
    )
    expect(newDec.rows[0]!.decision_type).toBe('OTHER_POSITION')
    expect(newDec.rows[0]!.recommendation).toBe('قرار الإصدار 2')
  })

  it('17. P4 readiness fails if any candidate lacks a decision', async () => {
    const { p4StageExecutionId, candidate1Id, requestId, iterationId } = await setupRequestAtP4()

    // Decision for candidate 1 only (candidate 2 has no decision)
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    await expect(
      promotion.validatePromotionP4AndResolveDestination(pool!, requestId, iterationId, p4StageExecutionId)
    ).rejects.toMatchObject({
      code: 'PROMOTION_DECISION_MISSING'
    })
  })

  it('18. all SAME_POSITION resolves destination P5', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    const result = await promotion.validatePromotionP4AndResolveDestination(pool!, requestId, iterationId, p4StageExecutionId)
    expect(result.nextStageCode).toBe('P5')
    expect(result.hasOtherPosition).toBe(false)
    expect(result.decisions).toHaveLength(2)
  })

  it('19. any one OTHER_POSITION resolves P4O for the WHOLE request', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'أخصائي أول تنظيم', recommendation: 'ترشيح مع تعديل المسمى' },
      authManager
    )

    const result = await promotion.validatePromotionP4AndResolveDestination(pool!, requestId, iterationId, p4StageExecutionId)
    expect(result.nextStageCode).toBe('P4O')
    expect(result.hasOtherPosition).toBe(true)
    expect(result.decisions).toHaveLength(2)
  })

  it('20. P4O confirmation refuses an invalid/orphan P4O with no OTHER_POSITION', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    // Save all SAME_POSITION decisions at P4
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    // Complete P4
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    // Synthetically open P4O (even though all are SAME_POSITION)
    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    // approveAndAdvance on P4O must fail because no candidate has OTHER_POSITION
    await expect(engine.approveAndAdvance(p4oExecId, orgManager)).rejects.toMatchObject({
      code: 'P4O_CONFIRMATION_INVALID'
    })
  })

  it('21. P4O confirmation does not mutate P4 decisions', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح 1' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'رئيس قسم', recommendation: 'ترشيح 2' },
      authManager
    )

    // Complete P4
    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    // Open P4O
    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    // Advance P4O -> P5
    const advanced = await engine.approveAndAdvance(p4oExecId, orgManager)
    expect(advanced.stageCode).toBe('P5')

    // Verify P4 decision rows in DB remain identical
    const p4Decs = await pool!.query<{ decision_type: string, target_job_title: string | null }>(
      `SELECT decision_type, target_job_title FROM promotion_decision WHERE stage_execution_id = $1 ORDER BY decision_type`,
      [p4StageExecutionId]
    )
    expect(p4Decs.rows).toHaveLength(2)
    expect(p4Decs.rows[0]!.decision_type).toBe('OTHER_POSITION')
    expect(p4Decs.rows[0]!.target_job_title).toBe('رئيس قسم')
    expect(p4Decs.rows[1]!.decision_type).toBe('SAME_POSITION')
    expect(p4Decs.rows[1]!.target_job_title).toBeNull()
  })

  it('22. P4O submission snapshot includes immutable authoritative P4 decisions', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح 1' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'رئيس قسم', recommendation: 'ترشيح 2' },
      authManager
    )

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    await engine.approveAndAdvance(p4oExecId, orgManager)

    const snapshotResult = await pool!.query<{ payload: any, sha256: string }>(
      `SELECT payload, sha256 FROM stage_submission_snapshot WHERE stage_execution_id = $1`,
      [p4oExecId]
    )
    expect(snapshotResult.rows).toHaveLength(1)
    const payload = snapshotResult.rows[0]!.payload
    expect(payload.promotionDecisions).toBeDefined()
    expect(payload.promotionDecisions).toHaveLength(2)
    expect(payload.promotionDecisions[0].personnelNumber).toBe('000101')
    expect(payload.promotionDecisions[0].decisionType).toBe('SAME_POSITION')
    expect(payload.promotionDecisions[1].personnelNumber).toBe('000102')
    expect(payload.promotionDecisions[1].decisionType).toBe('OTHER_POSITION')
    expect(payload.promotionDecisions[1].targetJobTitle).toBe('رئيس قسم')
  })

  it('23. P4O confirm advances stage to P5', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId, iterationId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'مدير تنفيذي', recommendation: 'ترشيح' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    const p5Exec = await engine.approveAndAdvance(p4oExecId, orgManager)
    expect(p5Exec.stageCode).toBe('P5')
    expect(p5Exec.responsibleUnitId).toBe(hrUnitId)

    const reqStatus = await pool!.query<{ current_stage_code: string }>(
      `SELECT current_stage_code FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    expect(reqStatus.rows[0]!.current_stage_code).toBe('P5')
  })

  it('24. P4O return creates fresh P4 StageExecution', async () => {
    const { p4StageExecutionId, requestId, iterationId } = await setupRequestAtP4()

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    const returned = await engine.returnPreviousStage(p4oExecId, { reason: 'إعادة مراجعة الترشيحات' }, orgManager)
    expect(returned.stageCode).toBe('P4')
    expect(returned.executionNo).toBe(2)
    expect(returned.responsibleUnitId).toBe(authUnitId)
  })

  it('25. P4O reject sets request status to REJECTED_PENDING_HR_DECISION', async () => {
    const { p4StageExecutionId, requestId, iterationId } = await setupRequestAtP4()

    await pool!.query(`UPDATE stage_execution SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [p4StageExecutionId])

    const p4oExecId = randomUUID()
    await pool!.query(
      `INSERT INTO stage_execution (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state)
       VALUES ($1, $2, 'P4O', 1, $3, 'OPEN', 'MANAGER_INBOX')`,
      [p4oExecId, iterationId, orgUnitId]
    )
    await pool!.query(`UPDATE workflow_request SET current_stage_code = 'P4O' WHERE id = $1`, [requestId])

    const rejected = await engine.rejectStage(p4oExecId, { reason: 'رفض المقترح من التنظيم والإدارة' }, orgManager)
    expect(rejected.status).toBe('REJECTED_PENDING_HR_DECISION')
    expect(rejected.currentStageCode).toBeNull()
    expect(rejected.currentExecutionId).toBeNull()
  })

  it('26. decision read API enforces IDOR/participant access and returns safe DTOs', async () => {
    const { p4StageExecutionId, candidate1Id, candidate2Id, requestId } = await setupRequestAtP4()

    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'SAME_POSITION', recommendation: 'ترشيح' },
      authManager
    )
    await promotion.upsertDecision(
      p4StageExecutionId,
      candidate2Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'رئيس وحدة', recommendation: 'ترشيح معدل', notes: 'ملاحظة سرية' },
      authManager
    )

    // Authorized unit member can read decisions
    const decisions = await promotion.getAuthoritativeDecisions(requestId, authManager)
    expect(decisions).toHaveLength(2)
    expect(decisions[0]!.personnelNumber).toBe('000101')
    expect(decisions[0]!.effectiveNominatedJob).toBe('أخصائي شئون إدارية ثالث')
    expect(decisions[1]!.personnelNumber).toBe('000102')
    expect(decisions[1]!.targetJobTitle).toBe('رئيس وحدة')
    expect(decisions[1]!.effectiveNominatedJob).toBe('رئيس وحدة')
    expect(decisions[1]!.notes).toBe('ملاحظة سرية')

    // Unauthorized other user fails with 404 (IDOR fail-closed)
    await expect(promotion.getAuthoritativeDecisions(requestId, otherUser)).rejects.toMatchObject({
      code: 'REQUEST_NOT_FOUND'
    })

    // Confirm route mounting in workflow-routes
    const routeSource = await readFile(new URL('../src/modules/workflow/workflow-routes.ts', import.meta.url), 'utf8')
    expect(routeSource).toContain("router.get('/requests/:requestId/promotion/decisions'")
    expect(routeSource).toContain("router.put('/stages/:stageExecutionId/promotion/candidates/:candidateId/decision'")
  })

  it('27. generic approveAndAdvance on P4 remains SIGNATURE_REQUIRED', async () => {
    const { p4StageExecutionId } = await setupRequestAtP4()

    await expect(engine.approveAndAdvance(p4StageExecutionId, authManager)).rejects.toMatchObject({
      code: 'SIGNATURE_REQUIRED'
    })
  })

  it('28. no cross-routing field or cross-routing target exists in decision table or API', async () => {
    const { p4StageExecutionId, candidate1Id } = await setupRequestAtP4()

    const saved = await promotion.upsertDecision(
      p4StageExecutionId,
      candidate1Id,
      { decisionType: 'OTHER_POSITION', targetJobTitle: 'مشرف إداري', recommendation: 'ترشيح' },
      authManager
    )

    // Check schema columns of promotion_decision
    const cols = await pool!.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'promotion_decision'`
    )
    const colNames = cols.rows.map(c => c.column_name)
    expect(colNames).not.toContain('target_routing_unit_id')
    expect(colNames).not.toContain('target_department_id')

    expect(saved).not.toHaveProperty('targetRoutingUnitId')
  })
})
