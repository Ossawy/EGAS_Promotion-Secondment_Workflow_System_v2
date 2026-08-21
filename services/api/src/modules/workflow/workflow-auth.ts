import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'
import type { StageCode } from './workflow-types.ts'

export interface OperationalUserRecord {
  id: string
  username: string
  displayName: string
  accountType: 'OPERATIONAL'
  isActive: boolean
}

export interface LockedCurrentStageContext {
  request: {
    id: string
    requestNumber: string
    requestType: string
    routingUnitId: string | null
    status: string
    currentIterationId: string | null
    currentStageCode: string | null
    version: number
  }
  iteration: {
    id: string
    iterationNo: number
    status: string
  }
  stageExecution: {
    id: string
    iterationId: string
    stageCode: StageCode
    executionNo: number
    responsibleUnitId: string
    status: string
    workState: string
  }
}

export async function getOperationalUser(
  db: Queryable,
  userId: string
): Promise<OperationalUserRecord> {
  const result = await db.query<OperationalUserRecord>(
    `SELECT id, username, display_name AS "displayName", account_type AS "accountType", is_active AS "isActive"
       FROM user_account
      WHERE id = $1 AND is_active = TRUE AND account_type = 'OPERATIONAL'`,
    [userId]
  )
  const user = result.rows[0]
  if (!user) {
    throw new AppError(403, 'Operational account required', 'OPERATIONAL_REQUIRED')
  }
  return user
}

export async function requireOperationalUser(
  db: Queryable,
  userId: string
): Promise<OperationalUserRecord> {
  return await getOperationalUser(db, userId)
}

export async function isCurrentUnitManager(
  db: Queryable,
  userId: string,
  unitId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM user_account a
       JOIN user_unit_membership m
         ON m.user_id = a.id
        AND m.unit_id = $2
        AND m.effective_to IS NULL
       JOIN unit_manager_assignment ma
         ON ma.unit_id = $2
        AND ma.manager_user_id = a.id
        AND ma.effective_to IS NULL
       JOIN operational_unit u
         ON u.id = $2
      WHERE a.id = $1
        AND a.account_type = 'OPERATIONAL'
        AND a.is_active = TRUE
        AND u.is_active = TRUE`,
    [userId, unitId]
  )
  return Boolean(result.rows[0])
}

export async function isCurrentHrManager(
  db: Queryable,
  userId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM operational_unit u
       JOIN user_unit_membership m
         ON m.unit_id = u.id
        AND m.user_id = $1
        AND m.effective_to IS NULL
       JOIN unit_manager_assignment ma
         ON ma.unit_id = u.id
        AND ma.manager_user_id = $1
        AND ma.effective_to IS NULL
       JOIN user_account a
         ON a.id = $1
        AND a.account_type = 'OPERATIONAL'
        AND a.is_active = TRUE
      WHERE u.kind = 'HR'
        AND u.is_active = TRUE`,
    [userId]
  )
  return Boolean(result.rows[0])
}

export async function requireCurrentUnitManager(
  db: Queryable,
  userId: string,
  unitId: string
): Promise<void> {
  // A. Verify responsible operational unit normally, WITHOUT FOR UPDATE
  const unitResult = await db.query<{ id: string, kind: string, routingUnitId: string | null }>(
    `SELECT id, kind, routing_unit_id AS "routingUnitId" FROM operational_unit WHERE id = $1 AND is_active = TRUE`,
    [unitId]
  )
  if (!unitResult.rows[0]) {
    throw new AppError(403, 'Current active unit manager authority required', 'UNIT_MANAGER_REQUIRED')
  }

  // B. Lock authoritative current account row
  const accountResult = await db.query<{ id: string }>(
    `SELECT id FROM user_account WHERE id = $1 AND account_type = 'OPERATIONAL' AND is_active = TRUE FOR UPDATE`,
    [userId]
  )
  if (!accountResult.rows[0]) {
    throw new AppError(403, 'Current active unit manager authority required', 'UNIT_MANAGER_REQUIRED')
  }

  // C. Lock current membership row
  const memberResult = await db.query<{ id: string }>(
    `SELECT id FROM user_unit_membership WHERE user_id = $1 AND unit_id = $2 AND effective_to IS NULL FOR UPDATE`,
    [userId, unitId]
  )
  if (!memberResult.rows[0]) {
    throw new AppError(403, 'Current active unit manager authority required', 'UNIT_MANAGER_REQUIRED')
  }

  // D. Lock active manager-assignment row itself
  const managerResult = await db.query<{ id: string }>(
    `SELECT id FROM unit_manager_assignment WHERE manager_user_id = $1 AND unit_id = $2 AND effective_to IS NULL FOR UPDATE`,
    [userId, unitId]
  )
  if (!managerResult.rows[0]) {
    throw new AppError(403, 'Current active unit manager authority required', 'UNIT_MANAGER_REQUIRED')
  }
}

export async function requireCurrentHrManager(
  db: Queryable,
  userId: string
): Promise<void> {
  // A. Resolve exactly one active HR unit with a normal SELECT (DO NOT lock operational_unit)
  const hrUnitResult = await db.query<{ id: string }>(
    `SELECT id FROM operational_unit WHERE kind = 'HR' AND is_active = TRUE`,
    []
  )
  if (hrUnitResult.rows.length !== 1) {
    throw new AppError(403, 'Current active HR unit manager authority required', 'HR_MANAGER_REQUIRED')
  }
  const hrUnitId = hrUnitResult.rows[0]!.id

  // B. Lock OPERATIONAL active user_account FOR UPDATE
  const accountResult = await db.query<{ id: string }>(
    `SELECT id FROM user_account WHERE id = $1 AND account_type = 'OPERATIONAL' AND is_active = TRUE FOR UPDATE`,
    [userId]
  )
  if (!accountResult.rows[0]) {
    throw new AppError(403, 'Current active HR unit manager authority required', 'HR_MANAGER_REQUIRED')
  }

  // C. Lock active UserUnitMembership for that user + HR unit FOR UPDATE
  const memberResult = await db.query<{ id: string }>(
    `SELECT id FROM user_unit_membership WHERE user_id = $1 AND unit_id = $2 AND effective_to IS NULL FOR UPDATE`,
    [userId, hrUnitId]
  )
  if (!memberResult.rows[0]) {
    throw new AppError(403, 'Current active HR unit manager authority required', 'HR_MANAGER_REQUIRED')
  }

  // D. Lock active UnitManagerAssignment for that user + HR unit FOR UPDATE
  const managerResult = await db.query<{ id: string }>(
    `SELECT id FROM unit_manager_assignment WHERE manager_user_id = $1 AND unit_id = $2 AND effective_to IS NULL FOR UPDATE`,
    [userId, hrUnitId]
  )
  if (!managerResult.rows[0]) {
    throw new AppError(403, 'Current active HR unit manager authority required', 'HR_MANAGER_REQUIRED')
  }
}

export async function isUnitMember(
  db: Queryable,
  userId: string,
  unitId: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM user_unit_membership m
       JOIN user_account a ON a.id = m.user_id
       JOIN operational_unit u ON u.id = m.unit_id
      WHERE m.user_id = $1
        AND m.unit_id = $2
        AND m.effective_to IS NULL
        AND a.is_active = TRUE
        AND a.account_type = 'OPERATIONAL'
        AND u.is_active = TRUE`,
    [userId, unitId]
  )
  return Boolean(result.rows[0])
}

export async function requireUnitMember(
  db: Queryable,
  userId: string,
  unitId: string
): Promise<void> {
  // A. Verify responsible operational_unit is active using a normal SELECT
  const unitResult = await db.query<{ id: string }>(
    `SELECT id FROM operational_unit WHERE id = $1 AND is_active = TRUE`,
    [unitId]
  )
  if (!unitResult.rows[0]) {
    throw new AppError(403, 'User is not an active operational member of this unit', 'UNIT_MEMBERSHIP_REQUIRED')
  }

  // B. Lock target user_account FOR UPDATE
  const accountResult = await db.query<{ id: string }>(
    `SELECT id FROM user_account WHERE id = $1 AND account_type = 'OPERATIONAL' AND is_active = TRUE FOR UPDATE`,
    [userId]
  )
  if (!accountResult.rows[0]) {
    throw new AppError(403, 'User is not an active operational member of this unit', 'UNIT_MEMBERSHIP_REQUIRED')
  }

  // C. Lock active membership FOR UPDATE
  const memberResult = await db.query<{ id: string }>(
    `SELECT id FROM user_unit_membership WHERE user_id = $1 AND unit_id = $2 AND effective_to IS NULL FOR UPDATE`,
    [userId, unitId]
  )
  if (!memberResult.rows[0]) {
    throw new AppError(403, 'User is not an active operational member of this unit', 'UNIT_MEMBERSHIP_REQUIRED')
  }
}


export async function canReadRequest(
  db: Queryable,
  userId: string,
  requestId: string
): Promise<boolean> {
  // 1. Request creator
  const creatorCheck = await db.query(
    `SELECT 1 FROM workflow_request WHERE id = $1 AND created_by_user_id = $2`,
    [requestId, userId]
  )
  if (creatorCheck.rows[0]) return true

  // 2. Current HR manager
  if (await isCurrentHrManager(db, userId)) return true

  // 3. Current or past assignee/assigner on work_assignment
  const assignmentCheck = await db.query(
    `SELECT 1
       FROM work_assignment wa
       JOIN stage_execution se ON se.id = wa.stage_execution_id
       JOIN workflow_iteration wi ON wi.id = se.iteration_id
      WHERE wi.request_id = $1
        AND (wa.assigned_to_user_id = $2 OR wa.assigned_by_user_id = $2)
      LIMIT 1`,
    [requestId, userId]
  )
  if (assignmentCheck.rows[0]) return true

  // 4. StageAction actor
  const actionCheck = await db.query(
    `SELECT 1
       FROM stage_action sa
       JOIN stage_execution se ON se.id = sa.stage_execution_id
       JOIN workflow_iteration wi ON wi.id = se.iteration_id
      WHERE wi.request_id = $1 AND sa.actor_user_id = $2
      LIMIT 1`,
    [requestId, userId]
  )
  if (actionCheck.rows[0]) return true

  // 5. WorkflowNote author
  const noteCheck = await db.query(
    `SELECT 1 FROM workflow_note WHERE request_id = $1 AND author_user_id = $2 LIMIT 1`,
    [requestId, userId]
  )
  if (noteCheck.rows[0]) return true

  // 6. Current manager of an operational unit involved in this request (requires BOTH active membership + active manager assignment)
  const managerInvolvementCheck = await db.query(
    `SELECT 1
       FROM stage_execution se
       JOIN workflow_iteration wi ON wi.id = se.iteration_id
       JOIN unit_manager_assignment ma ON ma.unit_id = se.responsible_unit_id AND ma.manager_user_id = $2 AND ma.effective_to IS NULL
       JOIN user_unit_membership m ON m.unit_id = se.responsible_unit_id AND m.user_id = $2 AND m.effective_to IS NULL
      WHERE wi.request_id = $1
      LIMIT 1`,
    [requestId, userId]
  )
  if (managerInvolvementCheck.rows[0]) return true

  return false
}

export async function requireRequestReadAccess(
  db: Queryable,
  userId: string,
  requestId: string
): Promise<void> {
  const allowed = await canReadRequest(db, userId, requestId)
  if (!allowed) {
    throw new AppError(404, 'Workflow request not found or access denied', 'REQUEST_NOT_FOUND')
  }
}

export async function lockCurrentStageExecution(
  db: Queryable,
  stageExecutionId: string
): Promise<LockedCurrentStageContext> {
  // First find request & iteration identity for deterministic lock ordering
  const lookup = await db.query<{
    requestId: string
    iterationId: string
  }>(
    `SELECT wi.request_id AS "requestId", se.iteration_id AS "iterationId"
       FROM stage_execution se
       JOIN workflow_iteration wi ON wi.id = se.iteration_id
      WHERE se.id = $1`,
    [stageExecutionId]
  )
  const meta = lookup.rows[0]
  if (!meta) {
    throw new AppError(404, 'Stage execution not found', 'STAGE_NOT_FOUND')
  }

  // 1. Lock Request FOR UPDATE
  const reqResult = await db.query<{
    id: string
    requestNumber: string
    requestType: string
    routingUnitId: string | null
    status: string
    currentIterationId: string | null
    currentStageCode: string | null
    version: number
  }>(
    `SELECT id, request_number AS "requestNumber", request_type AS "requestType",
            routing_unit_id AS "routingUnitId", status, current_iteration_id AS "currentIterationId",
            current_stage_code AS "currentStageCode", version
       FROM workflow_request
      WHERE id = $1
      FOR UPDATE`,
    [meta.requestId]
  )
  const request = reqResult.rows[0]
  if (!request) {
    throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
  }

  // 2. Lock Iteration FOR UPDATE
  const iterResult = await db.query<{
    id: string
    iterationNo: number
    status: string
  }>(
    `SELECT id, iteration_no AS "iterationNo", status
       FROM workflow_iteration
      WHERE id = $1
      FOR UPDATE`,
    [meta.iterationId]
  )
  const iteration = iterResult.rows[0]
  if (!iteration) {
    throw new AppError(404, 'Workflow iteration not found', 'ITERATION_NOT_FOUND')
  }

  // 3. Lock StageExecution FOR UPDATE
  const stageResult = await db.query<{
    id: string
    iterationId: string
    stageCode: StageCode
    executionNo: number
    responsibleUnitId: string
    status: string
    workState: string
  }>(
    `SELECT id, iteration_id AS "iterationId", stage_code AS "stageCode",
            execution_no AS "executionNo", responsible_unit_id AS "responsibleUnitId",
            status, work_state AS "workState"
       FROM stage_execution
      WHERE id = $1
      FOR UPDATE`,
    [stageExecutionId]
  )
  const stageExecution = stageResult.rows[0]
  if (!stageExecution) {
    throw new AppError(404, 'Stage execution not found', 'STAGE_NOT_FOUND')
  }

  // 4. Validate currentness & invariants
  if (request.status !== 'DRAFT' && request.status !== 'ACTIVE') {
    throw new AppError(409, `Request is in status ${request.status} and cannot be mutated`, 'STAGE_NOT_CURRENT')
  }
  if (iteration.status !== 'ACTIVE' || request.currentIterationId !== iteration.id) {
    throw new AppError(409, 'Iteration is not the current active iteration for this request', 'STAGE_NOT_CURRENT')
  }
  if (stageExecution.status !== 'OPEN') {
    throw new AppError(409, `Stage execution is ${stageExecution.status}, not OPEN`, 'STAGE_NOT_OPEN')
  }
  if (request.currentStageCode !== stageExecution.stageCode) {
    throw new AppError(409, 'Stage execution does not match current request stage code', 'STAGE_NOT_CURRENT')
  }

  return { request, iteration, stageExecution }
}
