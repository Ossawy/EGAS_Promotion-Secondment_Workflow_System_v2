import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { optionalText, uuid } from '../../shared/validation.ts'
import { recordAuditEvent } from '../audit/security-events.ts'
import { signaturePassword } from '../auth/current-password-verifier.ts'
import { DatabaseCurrentPasswordVerifier } from '../auth/current-password-verifier.ts'
import { LocalAuthenticationProvider } from '../auth/local-authentication-provider.ts'
import { buildFinalFormSnapshot } from './form-snapshot.ts'
import { PdfService } from './pdf-service.ts'
import { PromotionWorkflowService } from './promotion-workflow-service.ts'
import { SecondmentWorkflowService } from './secondment-workflow-service.ts'
import type { AppConfig } from '../../config/env.ts'
import {
  canReadRequest,
  isCurrentHrManager,
  lockCurrentStageExecution,
  requireCurrentHrManager,
  requireCurrentUnitManager,
  requireOperationalUser,
  requireRequestReadAccess,
  requireUnitMember
} from './workflow-auth.ts'
import { resolveResponsibleOperationalUnit } from './workflow-unit-resolver.ts'
import { createStageSubmissionSnapshot } from './stage-snapshot-service.ts'
import type { StageSnapshotData } from './stage-snapshot-service.ts'
import {
  SIGNING_STAGE_CODES,
  type AddCandidateInput,
  type AddNoteInput,
  type AssignStageInput,
  type CreateRequestInput,
  type InternalCorrectionInput,
  type NotificationSummary,
  type RejectStageInput,
  type RequestCandidateSummary,
  type ReturnPreviousInput,
  type SignAndAdvanceInput,
  type StageCode,
  type StageExecutionSummary,
  type TimelineEvent,
  type WorkflowNoteSummary,
  type WorkflowRequestContext,
  type WorkflowRequestSummary
} from './workflow-types.ts'

type RequestRow = {
  id: string
  requestNumber: string
  requestType: string
  routingUnitId: string | null
  routingUnitNameAr: string | null
  routingUnitCode: string | null
  status: string
  currentIterationId: string | null
  currentIterationNo: number | null
  currentStageCode: string | null
  currentExecutionId: string | null
  currentWorkState: string | null
  currentResponsibleUnitId: string | null
  currentResponsibleUnitName: string | null
  version: number
  createdByUserId: string | null
  createdByUserDisplayName: string | null
  createdAt: string
  completedAt: string | null
  cancelledAt: string | null
}

type StageRow = {
  id: string
  iterationId: string
  iterationNo: number
  requestId: string
  requestNumber: string
  requestType: string
  routingUnitId: string | null
  routingUnitNameAr: string | null
  stageCode: string
  executionNo: number
  responsibleUnitId: string
  responsibleUnitName: string
  responsibleUnitKind: string
  status: string
  workState: string
  openedAt: string
  completedAt: string | null
  activeAssigneeUserId: string | null
  activeAssigneeDisplayName: string | null
  assignedAt: string | null
}

async function insertNotification(
  db: Queryable,
  recipientUserId: string,
  notificationType: string,
  requestId?: string | null,
  stageExecutionId?: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO notification
      (id, recipient_user_id, request_id, stage_execution_id, notification_type, is_read, created_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, CURRENT_TIMESTAMP)`,
    [randomUUID(), recipientUserId, requestId ?? null, stageExecutionId ?? null, notificationType]
  )
}

export async function insertStageAction(
  db: Queryable,
  stageExecutionId: string,
  actorUserId: string,
  unitId: string | null,
  actionType: string,
  reason?: string | null,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO stage_action
      (id, stage_execution_id, actor_user_id, unit_id, action_type, reason, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, CURRENT_TIMESTAMP)`,
    [randomUUID(), stageExecutionId, actorUserId, unitId, actionType, reason ?? null, JSON.stringify(payload)]
  )
}

export class WorkflowEngineService {
  private readonly promotionService: PromotionWorkflowService
  private readonly secondmentService: SecondmentWorkflowService
  private readonly pdfService?: PdfService

  constructor(
    private readonly pool: Pool,
    private readonly config?: AppConfig
  ) {
    this.promotionService = new PromotionWorkflowService(pool)
    this.secondmentService = new SecondmentWorkflowService(pool)
    if (config) this.pdfService = new PdfService(pool, config)
  }

  async createRequest(
    input: CreateRequestInput,
    actor: WorkflowRequestContext
  ): Promise<WorkflowRequestSummary> {
    if (input.requestType !== 'PROMOTION' && input.requestType !== 'SECONDMENT') {
      throw new AppError(400, 'requestType must be PROMOTION or SECONDMENT', 'INVALID_REQUEST_TYPE')
    }
    const routingUnitId = uuid(input.routingUnitId, 'routingUnitId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      await requireCurrentHrManager(db, actor.userId)

      const routingUnitResult = await db.query<{ id: string, nameAr: string }>(
        `SELECT id, name_ar AS "nameAr" FROM routing_unit WHERE id = $1 AND is_active = TRUE`,
        [routingUnitId]
      )
      if (!routingUnitResult.rows[0]) {
        throw new AppError(404, 'Active routing unit not found', 'ROUTING_UNIT_NOT_FOUND')
      }

      const initialStageCode: StageCode = input.requestType === 'PROMOTION' ? 'P1' : 'S1'
      const hrUnit = await resolveResponsibleOperationalUnit(db, initialStageCode, routingUnitId)

      const requestId = randomUUID()
      const requestNumber = requestId
      const iterationId = randomUUID()
      const stageExecutionId = randomUUID()

      // 1. Insert Request with NULL current_iteration_id/current_stage_code to satisfy FK
      await db.query(
        `INSERT INTO workflow_request
          (id, request_number, request_type, routing_unit_id, status, current_iteration_id, current_stage_code, version, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, 'DRAFT', NULL, NULL, 1, $5, CURRENT_TIMESTAMP)`,
        [requestId, requestNumber, input.requestType, routingUnitId, actor.userId]
      )

      // 2. Insert Iteration 1 (request row now exists, FK request_id satisfied)
      await db.query(
        `INSERT INTO workflow_iteration
          (id, request_id, iteration_no, status, started_at)
         VALUES ($1, $2, 1, 'ACTIVE', CURRENT_TIMESTAMP)`,
        [iterationId, requestId]
      )

      // 3. Insert Initial Stage Execution (iteration row now exists, FK iteration_id satisfied)
      await db.query(
        `INSERT INTO stage_execution
          (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at)
         VALUES ($1, $2, $3, 1, $4, 'OPEN', 'MANAGER_INBOX', CURRENT_TIMESTAMP)`,
        [stageExecutionId, iterationId, initialStageCode, hrUnit.id]
      )

      // 4. Wire current_iteration_id and current_stage_code now that both rows exist
      await db.query(
        `UPDATE workflow_request
            SET current_iteration_id = $2,
                current_stage_code = $3
          WHERE id = $1`,
        [requestId, iterationId, initialStageCode]
      )

      // 5. Evidence & Notifications
      await insertStageAction(db, stageExecutionId, actor.userId, hrUnit.id, 'REQUEST_CREATED', null, {
        requestType: input.requestType,
        routingUnitId
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORKFLOW_REQUEST_CREATED',
        subjectType: 'workflow_request',
        subjectId: requestId,
        details: { requestType: input.requestType, routingUnitId, initialStageCode }
      })

      await insertNotification(db, actor.userId, 'STAGE_INBOX_ARRIVED', requestId, stageExecutionId)

      return await this.getRequestById(db, requestId)
    })
  }


  async addCandidate(
    requestIdValue: unknown,
    input: AddCandidateInput,
    actor: WorkflowRequestContext
  ): Promise<RequestCandidateSummary> {
    const requestId = uuid(requestIdValue, 'requestId')
    const personnelNumber = typeof input.personnelNumber === 'string' ? input.personnelNumber.trim() : ''
    if (!personnelNumber) {
      throw new AppError(400, 'personnelNumber is required', 'PERSONNEL_NUMBER_REQUIRED')
    }

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      await requireCurrentHrManager(db, actor.userId)

      const requestResult = await db.query<{ id: string, routingUnitId: string | null, status: string, currentStageCode: string }>(
        `SELECT id, routing_unit_id AS "routingUnitId", status, current_stage_code AS "currentStageCode"
           FROM workflow_request WHERE id = $1 FOR UPDATE`,
        [requestId]
      )
      const request = requestResult.rows[0]
      if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
      if (request.status !== 'DRAFT') {
        throw new AppError(409, 'Candidates can only be added when request is in DRAFT status', 'REQUEST_NOT_DRAFT')
      }
      if (request.currentStageCode !== 'P1' && request.currentStageCode !== 'S1') {
        throw new AppError(409, 'Candidates can only be added during initial P1/S1 preparation', 'STAGE_NOT_INITIAL')
      }

      // Resolve from latest ACTIVATED annual snapshot
      const snapshotResult = await db.query<{
        id: string
        employeeId: string
        snapshotYear: number
        personnelNumber: string
        routingUnitId: string | null
        employeeData: Record<string, unknown>
      }>(
        `SELECT s.id, s.employee_id AS "employeeId", s.snapshot_year AS "snapshotYear",
                s.personnel_number AS "personnelNumber", s.routing_unit_id AS "routingUnitId",
                s.employee_data AS "employeeData"
           FROM employee_annual_snapshot s
           JOIN import_batch b ON b.id = s.import_batch_id
          WHERE s.personnel_number = $1
            AND b.status = 'ACTIVATED'
          ORDER BY s.snapshot_year DESC
          LIMIT 1`,
        [personnelNumber]
      )
      const snapshot = snapshotResult.rows[0]
      if (!snapshot) {
        throw new AppError(404, `Employee ${personnelNumber} not found in an active annual snapshot`, 'EMPLOYEE_NOT_FOUND')
      }
      if (!snapshot.routingUnitId || snapshot.routingUnitId !== request.routingUnitId) {
        throw new AppError(409, 'Employee routing unit does not match request routing unit', 'CANDIDATE_ROUTING_MISMATCH')
      }

      // Check duplicate
      const duplicateCheck = await db.query(
        `SELECT 1 FROM request_candidate WHERE request_id = $1 AND employee_snapshot_id = $2`,
        [requestId, snapshot.id]
      )
      if (duplicateCheck.rows[0]) {
        throw new AppError(409, 'Candidate already added to this request', 'CANDIDATE_DUPLICATE')
      }

      const candidateId = randomUUID()
      await db.query(
        `INSERT INTO request_candidate
          (id, request_id, employee_snapshot_id, frozen_data, accepted_data)
         VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb)`,
        [candidateId, requestId, snapshot.id, JSON.stringify(snapshot.employeeData)]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'REQUEST_CANDIDATE_ADDED',
        subjectType: 'request_candidate',
        subjectId: candidateId,
        details: { requestId, personnelNumber, snapshotId: snapshot.id }
      })

      const data = snapshot.employeeData ?? {}
      return {
        id: candidateId,
        requestId,
        employeeSnapshotId: snapshot.id,
        personnelNumber: snapshot.personnelNumber,
        employeeName: String(data.employeeName ?? ''),
        currentJobTitle: (data.currentJobTitle as string) ?? null,
        frozenData: snapshot.employeeData,
        acceptedData: {}
      }
    })
  }

  async removeCandidate(
    requestIdValue: unknown,
    candidateIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<void> {
    const requestId = uuid(requestIdValue, 'requestId')
    const candidateId = uuid(candidateIdValue, 'candidateId')

    await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      await requireCurrentHrManager(db, actor.userId)

      const requestResult = await db.query<{ id: string, status: string, currentStageCode: string }>(
        `SELECT id, status, current_stage_code AS "currentStageCode"
           FROM workflow_request WHERE id = $1 FOR UPDATE`,
        [requestId]
      )
      const request = requestResult.rows[0]
      if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
      if (request.status !== 'DRAFT') {
        throw new AppError(409, 'Candidates can only be removed when request is in DRAFT status', 'REQUEST_NOT_DRAFT')
      }
      if (request.currentStageCode !== 'P1' && request.currentStageCode !== 'S1') {
        throw new AppError(409, 'Candidates can only be removed during initial P1/S1 preparation', 'STAGE_NOT_INITIAL')
      }

      const deleteResult = await db.query(
        `DELETE FROM request_candidate WHERE id = $1 AND request_id = $2`,
        [candidateId, requestId]
      )
      if (deleteResult.rowCount === 0) {
        throw new AppError(404, 'Candidate not found in this request', 'CANDIDATE_NOT_FOUND')
      }

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'REQUEST_CANDIDATE_REMOVED',
        subjectType: 'request_candidate',
        subjectId: candidateId,
        details: { requestId }
      })
    })
  }

  async assignStage(
    stageExecutionIdValue: unknown,
    input: AssignStageInput,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const assignedToUserId = uuid(input.assignedToUserId, 'assignedToUserId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      await requireUnitMember(db, assignedToUserId, stageExecution.responsibleUnitId)

      // End active assignment if any
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = $2
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId, input.reason ?? 'REASSIGNED']
      )

      // Insert new assignment
      const assignmentId = randomUUID()
      await db.query(
        `INSERT INTO work_assignment
          (id, stage_execution_id, assigned_by_user_id, assigned_to_user_id, assigned_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [assignmentId, stageExecutionId, actor.userId, assignedToUserId]
      )

      const newWorkState = assignedToUserId === actor.userId ? 'IN_PROGRESS' : 'ASSIGNED'
      await db.query(
        `UPDATE stage_execution SET work_state = $2 WHERE id = $1`,
        [stageExecutionId, newWorkState]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_ASSIGNED', input.reason, {
        assignedToUserId
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORK_ASSIGNMENT_CREATED',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { assignedToUserId, newWorkState }
      })

      await insertNotification(db, assignedToUserId, 'STAGE_ASSIGNED', request.id, stageExecutionId)

      return await this.getStageById(db, stageExecutionId)
    })
  }

  async takeStage(
    stageExecutionIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // End active assignment if any
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = 'MANAGER_TAKE'
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )

      // Assign to manager
      const assignmentId = randomUUID()
      await db.query(
        `INSERT INTO work_assignment
          (id, stage_execution_id, assigned_by_user_id, assigned_to_user_id, assigned_at)
         VALUES ($1, $2, $3, $3, CURRENT_TIMESTAMP)`,
        [assignmentId, stageExecutionId, actor.userId]
      )

      await db.query(
        `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
        [stageExecutionId]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_TAKEN_BY_MANAGER')

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'STAGE_TAKEN_BY_MANAGER',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { managerUserId: actor.userId }
      })

      return await this.getStageById(db, stageExecutionId)
    })
  }

  async submitToManager(
    stageExecutionIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      // Verify caller is the current active assignee
      const assignmentResult = await db.query<{ assignedToUserId: string }>(
        `SELECT assigned_to_user_id AS "assignedToUserId"
           FROM work_assignment
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )
      const activeAssignment = assignmentResult.rows[0]
      if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
        throw new AppError(403, 'Only the active assignee may submit to manager', 'NOT_ACTIVE_ASSIGNEE')
      }

      if (stageExecution.workState !== 'ASSIGNED' && stageExecution.workState !== 'IN_PROGRESS' && stageExecution.workState !== 'CORRECTION_REQUIRED') {
        throw new AppError(409, `Cannot submit to manager from work state ${stageExecution.workState}`, 'INVALID_WORK_STATE')
      }

      await db.query(
        `UPDATE stage_execution SET work_state = 'MANAGER_REVIEW' WHERE id = $1`,
        [stageExecutionId]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_SUBMITTED_TO_MANAGER')

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'STAGE_SUBMITTED_TO_MANAGER',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { submitterUserId: actor.userId }
      })

      // Notify current unit manager
      const managerResult = await db.query<{ managerUserId: string }>(
        `SELECT manager_user_id AS "managerUserId"
           FROM unit_manager_assignment
          WHERE unit_id = $1 AND effective_to IS NULL`,
        [stageExecution.responsibleUnitId]
      )
      if (managerResult.rows[0]?.managerUserId) {
        await insertNotification(
          db,
          managerResult.rows[0].managerUserId,
          'STAGE_SUBMITTED_TO_MANAGER',
          request.id,
          stageExecutionId
        )
      }

      return await this.getStageById(db, stageExecutionId)
    })
  }

  async internalCorrection(
    stageExecutionIdValue: unknown,
    input: InternalCorrectionInput,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason) {
      throw new AppError(400, 'Reason is required for internal correction', 'REASON_REQUIRED')
    }

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // Canonical internal work transition: must be in MANAGER_REVIEW
      if (stageExecution.workState !== 'MANAGER_REVIEW') {
        throw new AppError(409, 'Internal correction can only be requested when stage is in MANAGER_REVIEW', 'INVALID_WORK_STATE')
      }

      // Must have an active subordinate assignment
      const assignmentResult = await db.query<{ assignedToUserId: string }>(
        `SELECT assigned_to_user_id AS "assignedToUserId"
           FROM work_assignment
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )
      const activeAssignment = assignmentResult.rows[0]
      if (!activeAssignment || activeAssignment.assignedToUserId === actor.userId) {
        throw new AppError(409, 'Internal correction requires an active subordinate assignee', 'NO_SUBORDINATE_ASSIGNEE')
      }

      await db.query(
        `UPDATE stage_execution SET work_state = 'CORRECTION_REQUIRED' WHERE id = $1`,
        [stageExecutionId]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'INTERNAL_CORRECTION_REQUESTED', reason)

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'INTERNAL_CORRECTION_REQUESTED',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { reason, assigneeUserId: activeAssignment.assignedToUserId }
      })

      await insertNotification(
        db,
        activeAssignment.assignedToUserId,
        'CORRECTION_REQUIRED',
        request.id,
        stageExecutionId
      )

      return await this.getStageById(db, stageExecutionId)
    })
  }

  async returnPreviousStage(
    stageExecutionIdValue: unknown,
    input: ReturnPreviousInput,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason) {
      throw new AppError(400, 'Reason is required when returning to previous business stage', 'REASON_REQUIRED')
    }

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, iteration, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // Determine previous business stage
      let prevStageCode: StageCode
      if (stageExecution.stageCode === 'P2') prevStageCode = 'P1'
      else if (stageExecution.stageCode === 'P3') prevStageCode = 'P2'
      else if (stageExecution.stageCode === 'P4') prevStageCode = 'P3'
      else if (stageExecution.stageCode === 'P4O') prevStageCode = 'P4'
      else if (stageExecution.stageCode === 'P5') {
        const p4oCheck = await db.query(
          `SELECT 1 FROM stage_execution WHERE iteration_id = $1 AND stage_code = 'P4O' LIMIT 1`,
          [iteration.id]
        )
        prevStageCode = p4oCheck.rows[0] ? 'P4O' : 'P4'
      } else if (stageExecution.stageCode === 'S2') prevStageCode = 'S1'
      else if (stageExecution.stageCode === 'S3') prevStageCode = 'S2'
      else if (stageExecution.stageCode === 'S4') prevStageCode = 'S3'
      else if (stageExecution.stageCode === 'S5') prevStageCode = 'S4'
      else {
        throw new AppError(400, `Stage ${stageExecution.stageCode} is an initial stage and cannot be returned`, 'RETURN_INVALID')
      }

      const prevUnit = await resolveResponsibleOperationalUnit(db, prevStageCode, request.routingUnitId)

      // Close current execution
      await db.query(
        `UPDATE stage_execution
            SET status = 'RETURNED',
                completed_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [stageExecutionId]
      )

      // End active assignment
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = 'STAGE_RETURNED'
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )

      // Calculate next execution_no for prevStageCode in this iteration
      const execNoResult = await db.query<{ nextNo: number }>(
        `SELECT COALESCE(MAX(execution_no), 0) + 1 AS "nextNo"
           FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = $2`,
        [iteration.id, prevStageCode]
      )
      const nextExecutionNo = Number(execNoResult.rows[0]?.nextNo ?? 1)

      const newStageExecutionId = randomUUID()

      await db.query(
        `INSERT INTO stage_execution
          (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at, previous_execution_id)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', 'MANAGER_INBOX', CURRENT_TIMESTAMP, $6)`,
        [newStageExecutionId, iteration.id, prevStageCode, nextExecutionNo, prevUnit.id, stageExecutionId]
      )

      await db.query(
        `UPDATE workflow_request SET current_stage_code = $2 WHERE id = $1`,
        [request.id, prevStageCode]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_RETURNED_TO_PREVIOUS', reason, {
        returnedToStageCode: prevStageCode,
        newExecutionNo: nextExecutionNo
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'STAGE_RETURNED_TO_PREVIOUS',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { reason, returnedToStageCode: prevStageCode, newStageExecutionId }
      })

      // Notify destination unit manager
      const managerResult = await db.query<{ managerUserId: string }>(
        `SELECT manager_user_id AS "managerUserId"
           FROM unit_manager_assignment
          WHERE unit_id = $1 AND effective_to IS NULL`,
        [prevUnit.id]
      )
      if (managerResult.rows[0]?.managerUserId) {
        await insertNotification(
          db,
          managerResult.rows[0].managerUserId,
          'STAGE_RETURNED',
          request.id,
          newStageExecutionId
        )
      }

      return await this.getStageById(db, newStageExecutionId)
    })
  }


  async rejectStage(
    stageExecutionIdValue: unknown,
    input: RejectStageInput,
    actor: WorkflowRequestContext
  ): Promise<WorkflowRequestSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason) {
      throw new AppError(400, 'Reason is required when rejecting a stage', 'REASON_REQUIRED')
    }

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, iteration, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // End active assignment
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = 'STAGE_REJECTED'
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )

      // Close StageExecution as REJECTED
      await db.query(
        `UPDATE stage_execution
            SET status = 'REJECTED',
                completed_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [stageExecutionId]
      )

      // Close Iteration as REJECTED
      await db.query(
        `UPDATE workflow_iteration
            SET status = 'REJECTED',
                ended_at = CURRENT_TIMESTAMP,
                rejection_reason = $2
          WHERE id = $1`,
        [iteration.id, reason]
      )

      // Set Request status to REJECTED_PENDING_HR_DECISION and clear current_stage_code
      await db.query(
        `UPDATE workflow_request
            SET status = 'REJECTED_PENDING_HR_DECISION',
                current_stage_code = NULL
          WHERE id = $1`,
        [request.id]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_REJECTED', reason)

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORKFLOW_REQUEST_REJECTED',
        subjectType: 'workflow_request',
        subjectId: request.id,
        details: { stageExecutionId, stageCode: stageExecution.stageCode, reason }
      })

      // Notify current HR manager
      const hrManagerResult = await db.query<{ managerUserId: string }>(
        `SELECT ma.manager_user_id AS "managerUserId"
           FROM operational_unit u
           JOIN unit_manager_assignment ma ON ma.unit_id = u.id AND ma.effective_to IS NULL
          WHERE u.kind = 'HR' AND u.is_active = TRUE`,
        []
      )
      if (hrManagerResult.rows[0]?.managerUserId) {
        await insertNotification(
          db,
          hrManagerResult.rows[0].managerUserId,
          'WORKFLOW_REJECTED',
          request.id,
          stageExecutionId
        )
      }

      return await this.getRequestById(db, request.id)
    })
  }

  async restartRequest(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<WorkflowRequestSummary> {
    const requestId = uuid(requestIdValue, 'requestId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      await requireCurrentHrManager(db, actor.userId)

      const requestResult = await db.query<{
        id: string
        status: string
        requestType: string
        routingUnitId: string | null
        currentIterationId: string | null
      }>(
        `SELECT id, status, request_type AS "requestType", routing_unit_id AS "routingUnitId",
                current_iteration_id AS "currentIterationId"
           FROM workflow_request WHERE id = $1 FOR UPDATE`,
        [requestId]
      )
      const request = requestResult.rows[0]
      if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
      if (request.status !== 'REJECTED_PENDING_HR_DECISION') {
        throw new AppError(409, 'Only rejected requests can be restarted', 'REQUEST_NOT_REJECTED')
      }

      const lastIterResult = await db.query<{ id: string, iterationNo: number }>(
        `SELECT id, iteration_no AS "iterationNo"
           FROM workflow_iteration
          WHERE request_id = $1
          ORDER BY iteration_no DESC
          LIMIT 1`,
        [requestId]
      )
      const lastIter = lastIterResult.rows[0]
      const nextIterationNo = (lastIter?.iterationNo ?? 1) + 1
      const newIterationId = randomUUID()

      await db.query(
        `INSERT INTO workflow_iteration
          (id, request_id, iteration_no, status, parent_iteration_id, started_at)
         VALUES ($1, $2, $3, 'ACTIVE', $4, CURRENT_TIMESTAMP)`,
        [newIterationId, requestId, nextIterationNo, lastIter?.id ?? null]
      )

      const initialStageCode: StageCode = request.requestType === 'PROMOTION' ? 'P1' : 'S1'
      const hrUnit = await resolveResponsibleOperationalUnit(db, initialStageCode, request.routingUnitId)
      const newStageExecutionId = randomUUID()

      await db.query(
        `INSERT INTO stage_execution
          (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at)
         VALUES ($1, $2, $3, 1, $4, 'OPEN', 'MANAGER_INBOX', CURRENT_TIMESTAMP)`,
        [newStageExecutionId, newIterationId, initialStageCode, hrUnit.id]
      )

      await db.query(
        `UPDATE workflow_request
            SET status = 'DRAFT',
                current_iteration_id = $2,
                current_stage_code = $3,
                version = version + 1
          WHERE id = $1`,
        [requestId, newIterationId, initialStageCode]
      )

      await insertStageAction(db, newStageExecutionId, actor.userId, hrUnit.id, 'REQUEST_RESTARTED', null, {
        iterationNo: nextIterationNo
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORKFLOW_REQUEST_RESTARTED',
        subjectType: 'workflow_request',
        subjectId: requestId,
        details: { newIterationId, iterationNo: nextIterationNo, initialStageCode }
      })

      await insertNotification(db, actor.userId, 'STAGE_INBOX_ARRIVED', requestId, newStageExecutionId)

      return await this.getRequestById(db, requestId)
    })
  }

  async cancelRequest(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<WorkflowRequestSummary> {
    const requestId = uuid(requestIdValue, 'requestId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      await requireCurrentHrManager(db, actor.userId)

      const requestResult = await db.query<{ id: string, status: string }>(
        `SELECT id, status FROM workflow_request WHERE id = $1 FOR UPDATE`,
        [requestId]
      )
      const request = requestResult.rows[0]
      if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
      if (request.status !== 'REJECTED_PENDING_HR_DECISION') {
        throw new AppError(409, 'Only rejected requests can be cancelled', 'REQUEST_NOT_REJECTED')
      }

      await db.query(
        `UPDATE workflow_request
            SET status = 'CANCELLED',
                cancelled_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [requestId]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORKFLOW_REQUEST_CANCELLED',
        subjectType: 'workflow_request',
        subjectId: requestId
      })

      return await this.getRequestById(db, requestId)
    })
  }

  async approveAndAdvance(
    stageExecutionIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')

    const txResult = await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, iteration, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      // Reject signing stages
      if (SIGNING_STAGE_CODES.has(stageExecution.stageCode)) {
        throw new AppError(400, `Stage ${stageExecution.stageCode} requires a formal signature signoff`, 'SIGNATURE_REQUIRED')
      }

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // Check for P5 or S5 final completion
      if (stageExecution.stageCode === 'P5' || stageExecution.stageCode === 'S5') {
        const isPromotion = stageExecution.stageCode === 'P5'
        if (isPromotion && request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P5 is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        if (!isPromotion && request.requestType !== 'SECONDMENT') {
          throw new AppError(400, 'Stage S5 is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
        }

        // Build canonical final form snapshot from authoritative current-iteration signoffs
        const { payload: finalPayload, sha256: finalSha256, templateVersion } = await buildFinalFormSnapshot(
          db,
          request.id,
          iteration.id,
          request.requestType as 'PROMOTION' | 'SECONDMENT'
        )

        const finalSnapshotId = randomUUID()
        await db.query(
          `INSERT INTO final_form_snapshot
            (id, request_id, iteration_id, template_version, payload, sha256, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, CURRENT_TIMESTAMP)`,
          [
            finalSnapshotId,
            request.id,
            iteration.id,
            templateVersion,
            JSON.stringify(finalPayload),
            finalSha256
          ]
        )

        // Close stage execution
        await db.query(
          `UPDATE stage_execution
              SET status = 'COMPLETED',
                  work_state = 'COMPLETED',
                  completed_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [stageExecutionId]
        )

        // End active work assignment
        await db.query(
          `UPDATE work_assignment
              SET ended_at = CURRENT_TIMESTAMP,
                  end_reason = 'STAGE_COMPLETED'
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )

        // Complete iteration
        await db.query(
          `UPDATE workflow_iteration
              SET status = 'COMPLETED',
                  ended_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [iteration.id]
        )

        // Complete workflow request
        await db.query(
          `UPDATE workflow_request
              SET status = 'COMPLETED',
                  completed_at = CURRENT_TIMESTAMP,
                  current_stage_code = $2,
                  version = version + 1
            WHERE id = $1`,
          [request.id, stageExecution.stageCode]
        )

        await insertStageAction(
          db,
          stageExecutionId,
          actor.userId,
          stageExecution.responsibleUnitId,
          'STAGE_COMPLETED',
          null,
          {
            isFinalCompletion: true,
            templateVersion,
            finalSnapshotId
          }
        )

        await recordAuditEvent(db, {
          actorUserId: actor.userId,
          eventType: 'WORKFLOW_REQUEST_COMPLETED',
          subjectType: 'workflow_request',
          subjectId: request.id,
          details: {
            finalSnapshotId,
            templateVersion,
            sha256: finalSha256
          }
        })

        return {
          isCompleted: true as const,
          finalSnapshotId,
          requestId: request.id,
          stageExecutionId
        }
      }

      // Determine next deterministic generic stage with request-type validation
      let nextStageCode: StageCode
      if (stageExecution.stageCode === 'P3') {
        if (request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P3 is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'P4'
      } else if (stageExecution.stageCode === 'P4O') {
        if (request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P4O is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'P5'
      } else if (stageExecution.stageCode === 'S4') {
        if (request.requestType !== 'SECONDMENT') {
          throw new AppError(400, 'Stage S4 is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'S5'
      } else {
        throw new AppError(400, `Generic advance not supported from stage ${stageExecution.stageCode}`, 'STAGE_ADVANCE_UNSUPPORTED')
      }

      // Load form sections
      const formSectionsResult = await db.query<{
        id: string
        category: string
        displayOrder: number
        data: Record<string, unknown>
      }>(
        `SELECT id, category, display_order AS "displayOrder", data
           FROM request_form_section
          WHERE request_id = $1
          ORDER BY display_order, category, id`,
        [request.id]
      )

      // Load candidates in deterministic order
      const candidatesResult = await db.query<{
        id: string
        employeeSnapshotId: string
        personnelNumber: string
        frozenData: Record<string, unknown>
        acceptedData: Record<string, unknown>
      }>(
        `SELECT c.id, c.employee_snapshot_id AS "employeeSnapshotId",
                s.personnel_number AS "personnelNumber", c.frozen_data AS "frozenData",
                c.accepted_data AS "acceptedData"
           FROM request_candidate c
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE c.request_id = $1
          ORDER BY s.personnel_number, c.id`,
        [request.id]
      )

      let promotionDecisionsPayload: StageSnapshotData['promotionDecisions']
      let secondmentSelectionsPayload: StageSnapshotData['secondmentSelections']

      if (stageExecution.stageCode === 'P4O') {
        const authoritativeP4 = await db.query<{ id: string }>(
          `SELECT id FROM stage_execution
            WHERE iteration_id = $1 AND stage_code = 'P4' AND status = 'COMPLETED'
            ORDER BY execution_no DESC
            LIMIT 1`,
          [iteration.id]
        )
        const p4Exec = authoritativeP4.rows[0]
        if (!p4Exec) {
          throw new AppError(409, 'Authoritative completed P4 execution not found in current iteration', 'AUTHORITATIVE_P4_NOT_FOUND')
        }

        const decisionsResult = await db.query<{
          candidateId: string
          personnelNumber: string
          employeeData: Record<string, unknown>
          stageExecutionId: string
          decisionType: 'SAME_POSITION' | 'OTHER_POSITION'
          targetJobTitle: string | null
          recommendation: string
          notes: string | null
        }>(
          `SELECT d.candidate_id AS "candidateId", s.personnel_number AS "personnelNumber",
                  s.employee_data AS "employeeData", d.stage_execution_id AS "stageExecutionId",
                  d.decision_type AS "decisionType", d.target_job_title AS "targetJobTitle",
                  d.recommendation, d.notes
             FROM promotion_decision d
             JOIN request_candidate c ON c.id = d.candidate_id
             JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
            WHERE d.stage_execution_id = $1
            ORDER BY s.personnel_number, c.id`,
          [p4Exec.id]
        )

        const hasOtherPosition = decisionsResult.rows.some(d => d.decisionType === 'OTHER_POSITION')
        if (!hasOtherPosition) {
          throw new AppError(409, 'P4O confirmation requires at least one candidate with OTHER_POSITION decision', 'P4O_CONFIRMATION_INVALID')
        }

        promotionDecisionsPayload = decisionsResult.rows.map(d => {
          const empData = (d.employeeData as Record<string, unknown>) ?? {}
          const currentJob = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : null
          const isSame = d.decisionType === 'SAME_POSITION'
          return {
            candidateId: d.candidateId,
            personnelNumber: d.personnelNumber,
            employeeName: String(empData.employeeName ?? ''),
            sourceP4StageExecutionId: d.stageExecutionId,
          decisionType: d.decisionType,
            targetJobTitle: isSame ? null : d.targetJobTitle,
            effectiveNominatedJob: isSame ? currentJob : d.targetJobTitle,
            recommendation: d.recommendation,
            notes: d.notes
          }
        })
      } else if (stageExecution.stageCode === 'S4') {
        const s3ExecResult = await db.query<{ id: string }>(
          `SELECT id FROM stage_execution
            WHERE iteration_id = $1 AND stage_code = 'S3' AND status = 'COMPLETED'
            ORDER BY execution_no DESC
            LIMIT 1`,
          [iteration.id]
        )
        const s3Exec = s3ExecResult.rows[0]
        if (!s3Exec) {
          throw new AppError(409, 'Authoritative completed S3 execution not found in current iteration', 'AUTHORITATIVE_S3_NOT_FOUND')
        }

        const s2ExecResult = await db.query<{ id: string }>(
          `SELECT id FROM stage_execution
            WHERE iteration_id = $1 AND stage_code = 'S2' AND status = 'COMPLETED'
            ORDER BY execution_no DESC
            LIMIT 1`,
          [iteration.id]
        )
        const s2Exec = s2ExecResult.rows[0]
        if (!s2Exec) {
          throw new AppError(409, 'Authoritative completed S2 execution not found in current iteration', 'AUTHORITATIVE_S2_NOT_FOUND')
        }

        const selectionsResult = await db.query<{
          id: string
          stageExecutionId: string
          candidateId: string
          personnelNumber: string
          employeeData: Record<string, unknown>
          selectedOptionId: string
          positionTitle: string
          organizationalDependency: string
          qualificationStatus: string
          qualificationStatusName: string | null
          sourceS2StageExecutionId: string
          optionCandidateId: string
        }>(
          `SELECT d.id, d.stage_execution_id AS "stageExecutionId", d.candidate_id AS "candidateId",
                  s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData",
                  d.selected_option_id AS "selectedOptionId", o.position_title AS "positionTitle",
                  o.organizational_dependency AS "organizationalDependency",
                  o.qualification_status AS "qualificationStatus", r.name AS "qualificationStatusName",
                  o.source_stage_execution_id AS "sourceS2StageExecutionId",
                  o.candidate_id AS "optionCandidateId"
             FROM secondment_decision d
             JOIN secondment_position_option o ON o.id = d.selected_option_id
             JOIN request_candidate c ON c.id = d.candidate_id
             JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
             LEFT JOIN qualification_status_reference r ON r.code = o.qualification_status
            WHERE d.stage_execution_id = $1
            ORDER BY s.personnel_number, c.id`,
          [s3Exec.id]
        )

        const selectionsByCandidate = new Map(selectionsResult.rows.map(selection => [selection.candidateId, selection]))
        if (selectionsResult.rows.length !== candidatesResult.rows.length || selectionsByCandidate.size !== candidatesResult.rows.length) {
          throw new AppError(409, 'All candidates must have valid selections before S4 confirmation', 'SECONDMENT_SELECTIONS_INCOMPLETE')
        }
        for (const candidate of candidatesResult.rows) {
          const selection = selectionsByCandidate.get(candidate.id)
          if (!selection) {
            throw new AppError(409, 'All candidates must have valid selections before S4 confirmation', 'SECONDMENT_SELECTIONS_INCOMPLETE')
          }
          if (
            selection.optionCandidateId !== candidate.id ||
            selection.sourceS2StageExecutionId !== s2Exec.id
          ) {
            throw new AppError(400, 'Selected option is not valid for the authoritative S2 to S3 chain', 'INVALID_OPTION_SELECTION')
          }
        }

        secondmentSelectionsPayload = selectionsResult.rows.map(sel => ({
          candidateId: sel.candidateId,
          personnelNumber: sel.personnelNumber,
          employeeName: String(sel.employeeData?.employeeName ?? ''),
          sourceS3StageExecutionId: sel.stageExecutionId,
          selectedOptionId: sel.selectedOptionId,
          positionTitle: sel.positionTitle,
          organizationalDependency: sel.organizationalDependency,
          qualificationStatusCode: sel.qualificationStatus,
          qualificationStatusName: sel.qualificationStatusName ?? null,
          sourceS2StageExecutionId: sel.sourceS2StageExecutionId
        }))
      }

      // Freeze stage submission snapshot
      await createStageSubmissionSnapshot(db, stageExecutionId, {
        requestId: request.id,
        requestNumber: request.requestNumber,
        requestType: request.requestType,
        routingUnitId: request.routingUnitId,
        iterationId: iteration.id,
        iterationNo: iteration.iterationNo,
        stageExecutionId,
        stageCode: stageExecution.stageCode,
        executionNo: stageExecution.executionNo,
        responsibleUnitId: stageExecution.responsibleUnitId,
        formSections: formSectionsResult.rows,
        candidates: candidatesResult.rows,
        ...(promotionDecisionsPayload !== undefined ? { promotionDecisions: promotionDecisionsPayload } : {}),
        ...(secondmentSelectionsPayload !== undefined ? { secondmentSelections: secondmentSelectionsPayload } : {}),
        submittedAt: new Date().toISOString(),
        submittedByUserId: actor.userId
      })

      // Close current stage
      await db.query(
        `UPDATE stage_execution
            SET status = 'COMPLETED',
                work_state = 'COMPLETED',
                completed_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [stageExecutionId]
      )

      // End active assignment
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = 'STAGE_COMPLETED'
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )

      // Calculate next execution_no for destination stage in same iteration
      const execNoResult = await db.query<{ nextNo: number }>(
        `SELECT COALESCE(MAX(execution_no), 0) + 1 AS "nextNo"
           FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = $2`,
        [iteration.id, nextStageCode]
      )
      const nextExecutionNo = Number(execNoResult.rows[0]?.nextNo ?? 1)

      // Create next stage execution
      const nextUnit = await resolveResponsibleOperationalUnit(db, nextStageCode, request.routingUnitId)
      const nextExecutionId = randomUUID()

      await db.query(
        `INSERT INTO stage_execution
          (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at, previous_execution_id)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', 'MANAGER_INBOX', CURRENT_TIMESTAMP, $6)`,
        [nextExecutionId, iteration.id, nextStageCode, nextExecutionNo, nextUnit.id, stageExecutionId]
      )

      const newRequestStatus = request.status === 'DRAFT' ? 'ACTIVE' : request.status
      await db.query(
        `UPDATE workflow_request
            SET current_stage_code = $2,
                status = $3,
                version = version + 1
          WHERE id = $1`,
        [request.id, nextStageCode, newRequestStatus]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'STAGE_ADVANCED', null, {
        advancedToStageCode: nextStageCode,
        executionNo: nextExecutionNo
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'STAGE_ADVANCED',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: { nextStageCode, nextExecutionId, executionNo: nextExecutionNo }
      })

      // Notify next manager
      const managerResult = await db.query<{ managerUserId: string }>(
        `SELECT manager_user_id AS "managerUserId"
           FROM unit_manager_assignment
          WHERE unit_id = $1 AND effective_to IS NULL`,
        [nextUnit.id]
      )
      if (managerResult.rows[0]?.managerUserId) {
        await insertNotification(
          db,
          managerResult.rows[0].managerUserId,
          'STAGE_INBOX_ARRIVED',
          request.id,
          nextExecutionId
        )
      }

      return {
        isCompleted: false as const,
        nextExecutionId
      }
    })

    if (txResult.isCompleted) {
      if (this.pdfService) {
        void this.pdfService.materializeFinalPdfPostCommit(txResult.requestId, txResult.finalSnapshotId)
      }
      return await this.getStageById(this.pool, txResult.stageExecutionId)
    }

    return await this.getStageById(this.pool, txResult.nextExecutionId)
  }

  async signAndAdvance(
    stageExecutionIdValue: unknown,
    input: SignAndAdvanceInput,
    actor: WorkflowRequestContext,
    requestEvidence?: { ipAddress?: string, userAgent?: string }
  ): Promise<StageExecutionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const password = signaturePassword(input.password)
    const signatureAssetId = uuid(input.signatureAssetId, 'signatureAssetId')
    const jobTitleOverride = optionalText(input.jobTitleOverride, 'jobTitleOverride', 240)

    const txResult = await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, iteration, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      if (!SIGNING_STAGE_CODES.has(stageExecution.stageCode)) {
        throw new AppError(400, `Stage ${stageExecution.stageCode} is not an official signing stage`, 'SIGNING_UNSUPPORTED')
      }

      await requireCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)

      // Lock signer account
      const userRes = await db.query<{
        id: string
        username: string
        displayName: string
        jobTitle: string | null
        passwordHash: string
        isActive: boolean
      }>(
        `SELECT id, username, display_name AS "displayName", job_title AS "jobTitle",
                password_hash AS "passwordHash", is_active AS "isActive"
           FROM user_account
          WHERE id = $1
            FOR UPDATE`,
        [actor.userId]
      )
      const signer = userRes.rows[0]
      if (!signer || !signer.isActive) {
        throw new AppError(401, 'Signer account is inactive or not found', 'SIGNER_ACCOUNT_INACTIVE')
      }

      // Lock & validate selected signature asset
      const assetRes = await db.query<{
        id: string
        user_id: string
        storage_key: string
        sha256: string
        is_active: boolean
      }>(
        `SELECT id, user_id, storage_key, sha256, is_active
           FROM user_signature_asset
          WHERE id = $1 AND user_id = $2
            FOR UPDATE`,
        [signatureAssetId, actor.userId]
      )
      const sigAsset = assetRes.rows[0]
      if (!sigAsset || !sigAsset.is_active) {
        throw new AppError(400, 'Selected signature asset is invalid or inactive', 'SIGNATURE_ASSET_INVALID')
      }

      // Validate effective job title
      const effectiveJobTitle = (jobTitleOverride?.trim() || signer.jobTitle?.trim() || '')
      if (!effectiveJobTitle) {
        throw new AppError(400, 'Effective signer job title is required', 'SIGNER_JOB_TITLE_REQUIRED')
      }
      const jobTitleWasOverridden = Boolean(jobTitleOverride?.trim() && jobTitleOverride.trim() !== (signer.jobTitle ?? '').trim())

      // Verify only after all authority, asset and title prerequisites have been
      // locked/validated. No workflow mutation appears above this boundary.
      if (!this.config) throw new AppError(500, 'Signing service configuration is unavailable', 'SIGNING_CONFIGURATION_MISSING')
      const passwordVerifier = new DatabaseCurrentPasswordVerifier(new LocalAuthenticationProvider(this.pool, this.config))
      if (!await passwordVerifier.verify(db, actor.userId, password)) {
        await db.query(
          `INSERT INTO security_event
            (id, actor_user_id, event_type, ip_address, user_agent, details, created_at)
           VALUES ($1, $2, 'SIGNATURE_PASSWORD_REJECTED', $3, $4, $5::jsonb, CURRENT_TIMESTAMP)`,
          [randomUUID(), actor.userId, requestEvidence?.ipAddress ?? null, requestEvidence?.userAgent ?? null,
            JSON.stringify({ stageExecutionId, requestId: request.id, stageCode: stageExecution.stageCode })]
        )
        return { outcome: 'PASSWORD_INVALID' as const }
      }

      // Load form sections and candidates
      const formSectionsResult = await db.query<{
        id: string
        category: string
        displayOrder: number
        data: Record<string, unknown>
      }>(
        `SELECT id, category, display_order AS "displayOrder", data
           FROM request_form_section
          WHERE request_id = $1
          ORDER BY display_order, category, id`,
        [request.id]
      )

      const candidatesResult = await db.query<{
        id: string
        employeeSnapshotId: string
        personnelNumber: string
        frozenData: Record<string, unknown>
        acceptedData: Record<string, unknown>
      }>(
        `SELECT c.id, c.employee_snapshot_id AS "employeeSnapshotId",
                s.personnel_number AS "personnelNumber", c.frozen_data AS "frozenData",
                c.accepted_data AS "acceptedData"
           FROM request_candidate c
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE c.request_id = $1
          ORDER BY s.personnel_number, c.id`,
        [request.id]
      )

      if (candidatesResult.rows.length === 0) {
        throw new AppError(400, 'Request must contain at least one candidate before signing', 'CANDIDATES_REQUIRED')
      }

      let nextStageCode: StageCode
      let promotionDecisionsPayload: StageSnapshotData['promotionDecisions']
      let secondmentPositionOptionsPayload: StageSnapshotData['secondmentPositionOptions']
      let secondmentSelectionsPayload: StageSnapshotData['secondmentSelections']

      if (stageExecution.stageCode === 'P1') {
        if (request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P1 is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'P2'
      } else if (stageExecution.stageCode === 'P2') {
        if (request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P2 is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'P3'
      } else if (stageExecution.stageCode === 'P4') {
        if (request.requestType !== 'PROMOTION') {
          throw new AppError(400, 'Stage P4 is only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
        }
        const p4Validation = await this.promotionService.validatePromotionP4AndResolveDestination(
          db,
          request.id,
          iteration.id,
          stageExecutionId
        )
        nextStageCode = p4Validation.nextStageCode
        promotionDecisionsPayload = p4Validation.decisions.map(decision => ({
          candidateId: decision.candidateId,
          personnelNumber: decision.personnelNumber,
          employeeName: decision.employeeName,
          sourceP4StageExecutionId: decision.stageExecutionId,
          decisionType: decision.decisionType,
          targetJobTitle: decision.targetJobTitle,
          effectiveNominatedJob: decision.effectiveNominatedJob,
          recommendation: decision.recommendation,
          notes: decision.notes
        }))
      } else if (stageExecution.stageCode === 'S1') {
        if (request.requestType !== 'SECONDMENT') {
          throw new AppError(400, 'Stage S1 is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
        }
        nextStageCode = 'S2'
      } else if (stageExecution.stageCode === 'S2') {
        if (request.requestType !== 'SECONDMENT') {
          throw new AppError(400, 'Stage S2 is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
        }
        const s2Validation = await this.secondmentService.validateSecondmentS2ForSignoff(
          db,
          request.id,
          iteration.id,
          stageExecutionId
        )
        nextStageCode = 'S3'
        secondmentPositionOptionsPayload = s2Validation.candidateOptions
      } else if (stageExecution.stageCode === 'S3') {
        if (request.requestType !== 'SECONDMENT') {
          throw new AppError(400, 'Stage S3 is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
        }
        const s3Validation = await this.secondmentService.validateSecondmentS3ForSignoff(
          db,
          request.id,
          iteration.id,
          stageExecutionId
        )
        nextStageCode = 'S4'
        secondmentSelectionsPayload = s3Validation.selections.map(selection => ({
          candidateId: selection.candidateId,
          personnelNumber: selection.personnelNumber,
          employeeName: selection.employeeName,
          sourceS3StageExecutionId: selection.stageExecutionId,
          selectedOptionId: selection.selectedOptionId,
          sourceS2StageExecutionId: selection.sourceS2StageExecutionId,
          positionTitle: selection.positionTitle,
          organizationalDependency: selection.organizationalDependency,
          qualificationStatusCode: selection.qualificationStatusCode,
          qualificationStatusName: selection.qualificationStatusName
        }))
      } else {
        throw new AppError(400, `Sign-and-advance not supported from stage ${stageExecution.stageCode}`, 'STAGE_ADVANCE_UNSUPPORTED')
      }

      // Freeze StageSubmissionSnapshot
      await createStageSubmissionSnapshot(db, stageExecutionId, {
        requestId: request.id,
        requestNumber: request.requestNumber,
        requestType: request.requestType,
        routingUnitId: request.routingUnitId,
        iterationId: iteration.id,
        iterationNo: iteration.iterationNo,
        stageExecutionId,
        stageCode: stageExecution.stageCode,
        executionNo: stageExecution.executionNo,
        responsibleUnitId: stageExecution.responsibleUnitId,
        formSections: formSectionsResult.rows,
        candidates: candidatesResult.rows,
        ...(promotionDecisionsPayload !== undefined ? { promotionDecisions: promotionDecisionsPayload } : {}),
        ...(secondmentPositionOptionsPayload !== undefined ? { secondmentPositionOptions: secondmentPositionOptionsPayload } : {}),
        ...(secondmentSelectionsPayload !== undefined ? { secondmentSelections: secondmentSelectionsPayload } : {}),
        submittedAt: new Date().toISOString(),
        submittedByUserId: actor.userId
      })

      // Resolve manager assignment & unit kind
      const mgrRes = await db.query<{ id: string }>(
        `SELECT id
           FROM unit_manager_assignment
          WHERE unit_id = $1 AND manager_user_id = $2 AND effective_to IS NULL`,
        [stageExecution.responsibleUnitId, actor.userId]
      )
      if (!mgrRes.rows[0]) {
        throw new AppError(409, 'Current manager assignment changed during signing', 'MANAGER_ASSIGNMENT_MISSING')
      }
      const unitRes = await db.query<{ kind: string }>(
        `SELECT kind FROM operational_unit WHERE id = $1`,
        [stageExecution.responsibleUnitId]
      )

      const signerSnapshot = {
        signerUserId: signer.id,
        signerUsername: signer.username,
        signerName: signer.displayName,
        signerJobTitle: effectiveJobTitle,
        jobTitleWasOverridden,
        operationalUnitId: stageExecution.responsibleUnitId,
        operationalUnitKind: unitRes.rows[0]?.kind ?? '',
        managerAssignmentId: mgrRes.rows[0].id,
        signatureAssetId: sigAsset.id,
        signatureSha256: sigAsset.sha256
      }

      // Insert WorkflowSignoff
      const signoffId = randomUUID()
      await db.query(
        `INSERT INTO workflow_signoff
          (id, stage_execution_id, signer_user_id, manager_assignment_id, signer_snapshot, signature_asset_id, signature_sha256, signed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, CURRENT_TIMESTAMP)`,
        [
          signoffId,
          stageExecutionId,
          actor.userId,
          mgrRes.rows[0].id,
          JSON.stringify(signerSnapshot),
          sigAsset.id,
          sigAsset.sha256
        ]
      )

      // Close current stage execution
      await db.query(
        `UPDATE stage_execution
            SET status = 'COMPLETED',
                work_state = 'COMPLETED',
                completed_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [stageExecutionId]
      )

      // End active work assignment
      await db.query(
        `UPDATE work_assignment
            SET ended_at = CURRENT_TIMESTAMP,
                end_reason = 'STAGE_COMPLETED'
          WHERE stage_execution_id = $1 AND ended_at IS NULL`,
        [stageExecutionId]
      )

      // Next execution_no for destination stage
      const execNoResult = await db.query<{ nextNo: number }>(
        `SELECT COALESCE(MAX(execution_no), 0) + 1 AS "nextNo"
           FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = $2`,
        [iteration.id, nextStageCode]
      )
      const nextExecutionNo = Number(execNoResult.rows[0]?.nextNo ?? 1)

      // Next operational unit
      const nextUnit = await resolveResponsibleOperationalUnit(db, nextStageCode, request.routingUnitId)
      const nextExecutionId = randomUUID()

      await db.query(
        `INSERT INTO stage_execution
          (id, iteration_id, stage_code, execution_no, responsible_unit_id, status, work_state, opened_at, previous_execution_id)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', 'MANAGER_INBOX', CURRENT_TIMESTAMP, $6)`,
        [nextExecutionId, iteration.id, nextStageCode, nextExecutionNo, nextUnit.id, stageExecutionId]
      )

      const newRequestStatus = request.status === 'DRAFT' ? 'ACTIVE' : request.status
      await db.query(
        `UPDATE workflow_request
            SET current_stage_code = $2,
                status = $3,
                version = version + 1
          WHERE id = $1`,
        [request.id, nextStageCode, newRequestStatus]
      )

      await insertStageAction(
        db,
        stageExecutionId,
        actor.userId,
        stageExecution.responsibleUnitId,
        'SIGN_AND_ADVANCE',
        null,
        {
          advancedToStageCode: nextStageCode,
          executionNo: nextExecutionNo,
          signerJobTitle: effectiveJobTitle,
          signatureAssetId: sigAsset.id
        }
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'STAGE_SIGNED_AND_ADVANCED',
        subjectType: 'stage_execution',
        subjectId: stageExecutionId,
        details: {
          nextStageCode,
          nextExecutionId,
          executionNo: nextExecutionNo,
          signerJobTitle: effectiveJobTitle,
          signatureAssetId: sigAsset.id
        }
      })

      // Notify next manager if existing helper is active
      const managerResult = await db.query<{ managerUserId: string }>(
        `SELECT manager_user_id AS "managerUserId"
           FROM unit_manager_assignment
          WHERE unit_id = $1 AND effective_to IS NULL`,
        [nextUnit.id]
      )
      if (managerResult.rows[0]?.managerUserId) {
        await insertNotification(
          db,
          managerResult.rows[0].managerUserId,
          'STAGE_INBOX_ARRIVED',
          request.id,
          nextExecutionId
        )
      }

      return { outcome: 'SUCCESS' as const, nextExecutionId }
    })

    if (txResult.outcome === 'PASSWORD_INVALID') {
      throw new AppError(401, 'Invalid signature password', 'SIGNATURE_PASSWORD_INVALID')
    }

    return await this.getStageById(this.pool, txResult.nextExecutionId)
  }

  async addNote(
    requestIdValue: unknown,
    input: AddNoteInput,
    actor: WorkflowRequestContext
  ): Promise<WorkflowNoteSummary> {
    const requestId = uuid(requestIdValue, 'requestId')
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    if (!body) {
      throw new AppError(400, 'Note body is required', 'BODY_REQUIRED')
    }
    const candidateId = input.candidateId ? uuid(input.candidateId, 'candidateId') : null

    return await withTransaction(this.pool, async db => {
      const opUser = await requireOperationalUser(db, actor.userId)
      await requireRequestReadAccess(db, actor.userId, requestId)

      if (candidateId) {
        const candidateCheck = await db.query(
          `SELECT 1 FROM request_candidate WHERE id = $1 AND request_id = $2`,
          [candidateId, requestId]
        )
        if (!candidateCheck.rows[0]) {
          throw new AppError(404, 'Candidate does not belong to this request', 'CANDIDATE_NOT_FOUND')
        }
      }

      const membership = await db.query<{ unitId: string, unitName: string }>(
        `SELECT m.unit_id AS "unitId", u.name AS "unitName"
           FROM user_unit_membership m
           JOIN operational_unit u ON u.id = m.unit_id
          WHERE m.user_id = $1 AND m.effective_to IS NULL`,
        [actor.userId]
      )
      const unit = membership.rows[0]

      const reqResult = await db.query<{ currentIterationId: string | null, currentStageCode: string | null }>(
        `SELECT current_iteration_id AS "currentIterationId", current_stage_code AS "currentStageCode"
           FROM workflow_request WHERE id = $1`,
        [requestId]
      )
      const req = reqResult.rows[0]

      let stageExecutionId: string | null = null
      if (req?.currentIterationId && req?.currentStageCode) {
        const stageRes = await db.query<{ id: string }>(
          `SELECT id FROM stage_execution
            WHERE iteration_id = $1 AND stage_code = $2 AND status = 'OPEN'`,
          [req.currentIterationId, req.currentStageCode]
        )
        stageExecutionId = stageRes.rows[0]?.id ?? null
      }

      const noteId = randomUUID()
      await db.query(
        `INSERT INTO workflow_note
          (id, request_id, candidate_id, iteration_id, stage_execution_id, author_user_id, unit_id, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
        [
          noteId,
          requestId,
          candidateId,
          req?.currentIterationId ?? null,
          stageExecutionId,
          actor.userId,
          unit?.unitId ?? null,
          body
        ]
      )

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'WORKFLOW_NOTE_ADDED',
        subjectType: 'workflow_note',
        subjectId: noteId,
        details: { requestId, candidateId }
      })

      return {
        id: noteId,
        requestId,
        candidateId,
        iterationId: req?.currentIterationId ?? null,
        stageExecutionId,
        stageCode: (req?.currentStageCode as StageCode) ?? null,
        authorUserId: actor.userId,
        authorDisplayName: opUser.displayName,
        unitId: unit?.unitId ?? null,
        unitName: unit?.unitName ?? null,
        body,
        createdAt: new Date().toISOString()
      }
    })
  }

  async listNotes(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<WorkflowNoteSummary[]> {
    const requestId = uuid(requestIdValue, 'requestId')
    await requireOperationalUser(this.pool, actor.userId)
    await requireRequestReadAccess(this.pool, actor.userId, requestId)

    const result = await this.pool.query<{
      id: string
      requestId: string
      candidateId: string | null
      iterationId: string | null
      stageExecutionId: string | null
      stageCode: StageCode | null
      authorUserId: string
      authorDisplayName: string
      unitId: string | null
      unitName: string | null
      body: string
      createdAt: string
    }>(
      `SELECT n.id, n.request_id AS "requestId", n.candidate_id AS "candidateId",
              n.iteration_id AS "iterationId", n.stage_execution_id AS "stageExecutionId",
              se.stage_code AS "stageCode", n.author_user_id AS "authorUserId",
              a.display_name AS "authorDisplayName", n.unit_id AS "unitId",
              u.name AS "unitName", n.body, n.created_at AS "createdAt"
         FROM workflow_note n
         JOIN user_account a ON a.id = n.author_user_id
         LEFT JOIN operational_unit u ON u.id = n.unit_id
         LEFT JOIN stage_execution se ON se.id = n.stage_execution_id
        WHERE n.request_id = $1
        ORDER BY n.created_at ASC`,
      [requestId]
    )

    return result.rows.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt).toISOString()
    }))
  }

  async getTimeline(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<TimelineEvent[]> {
    const requestId = uuid(requestIdValue, 'requestId')
    await requireOperationalUser(this.pool, actor.userId)
    await requireRequestReadAccess(this.pool, actor.userId, requestId)

    const events: TimelineEvent[] = []

    // 1. Request Creation & Cancellation
    const reqInfo = await this.pool.query<{ createdAt: string, cancelledAt: string | null, status: string }>(
      `SELECT created_at AS "createdAt", cancelled_at AS "cancelledAt", status FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    if (reqInfo.rows[0]) {
      events.push({
        kind: 'REQUEST_STATUS',
        id: `${requestId}-created`,
        timestamp: new Date(reqInfo.rows[0].createdAt).toISOString(),
        title: 'Workflow Request Created'
      })
      if (reqInfo.rows[0].cancelledAt) {
        events.push({
          kind: 'REQUEST_STATUS',
          id: `${requestId}-cancelled`,
          timestamp: new Date(reqInfo.rows[0].cancelledAt).toISOString(),
          title: 'Workflow Request Cancelled'
        })
      }
    }

    // 2. Iterations
    const iterations = await this.pool.query<{ id: string, iterationNo: number, status: string, startedAt: string, endedAt: string | null, rejectionReason: string | null }>(
      `SELECT id, iteration_no AS "iterationNo", status, started_at AS "startedAt", ended_at AS "endedAt", rejection_reason AS "rejectionReason"
         FROM workflow_iteration WHERE request_id = $1 ORDER BY iteration_no ASC`,
      [requestId]
    )
    for (const iter of iterations.rows) {
      events.push({
        kind: 'ITERATION',
        id: iter.id,
        timestamp: new Date(iter.startedAt).toISOString(),
        title: `Workflow Iteration ${iter.iterationNo} Started`,
        details: { iterationNo: iter.iterationNo, status: iter.status }
      })
      if (iter.endedAt && iter.status === 'REJECTED') {
        events.push({
          kind: 'ITERATION',
          id: `${iter.id}-rejected`,
          timestamp: new Date(iter.endedAt).toISOString(),
          title: `Workflow Iteration ${iter.iterationNo} Rejected`,
          details: { iterationNo: iter.iterationNo, rejectionReason: iter.rejectionReason }
        })
      }
    }

    // 3. Stage Executions (Opened, Completed, Returned, Rejected)
    const stageExecs = await this.pool.query<{
      id: string
      stageCode: string
      executionNo: number
      unitName: string | null
      status: string
      openedAt: string
      completedAt: string | null
    }>(
      `SELECT se.id, se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              u.name AS "unitName", se.status, se.opened_at AS "openedAt",
              se.completed_at AS "completedAt"
         FROM stage_execution se
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         LEFT JOIN operational_unit u ON u.id = se.responsible_unit_id
        WHERE wi.request_id = $1
        ORDER BY se.opened_at ASC`,
      [requestId]
    )
    for (const se of stageExecs.rows) {
      events.push({
        kind: 'STAGE_EXECUTION',
        id: `${se.id}-opened`,
        timestamp: new Date(se.openedAt).toISOString(),
        title: `Stage ${se.stageCode} (Exec ${se.executionNo}) Opened`,
        details: { stageCode: se.stageCode, executionNo: se.executionNo, unitName: se.unitName, status: 'OPEN' }
      })
      if (se.completedAt) {
        events.push({
          kind: 'STAGE_EXECUTION',
          id: `${se.id}-ended`,
          timestamp: new Date(se.completedAt).toISOString(),
          title: `Stage ${se.stageCode} (Exec ${se.executionNo}) ${se.status}`,
          details: { stageCode: se.stageCode, executionNo: se.executionNo, unitName: se.unitName, status: se.status }
        })
      }
    }

    // 4. Work Assignments (Created, Ended)
    const assignments = await this.pool.query<{
      id: string
      stageCode: string
      assignedByDisplayName: string
      assignedToDisplayName: string
      assignedAt: string
      endedAt: string | null
      endReason: string | null
    }>(
      `SELECT wa.id, se.stage_code AS "stageCode",
              assigner.display_name AS "assignedByDisplayName",
              assignee.display_name AS "assignedToDisplayName",
              wa.assigned_at AS "assignedAt", wa.ended_at AS "endedAt",
              wa.end_reason AS "endReason"
         FROM work_assignment wa
         JOIN stage_execution se ON se.id = wa.stage_execution_id
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN user_account assigner ON assigner.id = wa.assigned_by_user_id
         JOIN user_account assignee ON assignee.id = wa.assigned_to_user_id
        WHERE wi.request_id = $1
        ORDER BY wa.assigned_at ASC`,
      [requestId]
    )
    for (const wa of assignments.rows) {
      events.push({
        kind: 'WORK_ASSIGNMENT',
        id: `${wa.id}-created`,
        timestamp: new Date(wa.assignedAt).toISOString(),
        title: `Work assigned to ${wa.assignedToDisplayName} (${wa.stageCode})`,
        actorDisplayName: wa.assignedByDisplayName,
        details: { assignedTo: wa.assignedToDisplayName, stageCode: wa.stageCode }
      })
      if (wa.endedAt) {
        events.push({
          kind: 'WORK_ASSIGNMENT',
          id: `${wa.id}-ended`,
          timestamp: new Date(wa.endedAt).toISOString(),
          title: `Work assignment ended for ${wa.assignedToDisplayName} (${wa.stageCode})`,
          details: { assignedTo: wa.assignedToDisplayName, stageCode: wa.stageCode, endReason: wa.endReason }
        })
      }
    }

    // 5. Stage Actions
    const actions = await this.pool.query<{
      id: string
      stageCode: string
      executionNo: number
      actorUserId: string
      actorDisplayName: string
      unitName: string | null
      actionType: string
      reason: string | null
      payload: Record<string, unknown>
      createdAt: string
    }>(
      `SELECT sa.id, se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              sa.actor_user_id AS "actorUserId", a.display_name AS "actorDisplayName",
              u.name AS "unitName", sa.action_type AS "actionType", sa.reason,
              sa.payload, sa.created_at AS "createdAt"
         FROM stage_action sa
         JOIN stage_execution se ON se.id = sa.stage_execution_id
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN user_account a ON a.id = sa.actor_user_id
         LEFT JOIN operational_unit u ON u.id = sa.unit_id
        WHERE wi.request_id = $1
        ORDER BY sa.created_at ASC`,
      [requestId]
    )
    for (const act of actions.rows) {
      events.push({
        kind: 'STAGE_ACTION',
        id: act.id,
        timestamp: new Date(act.createdAt).toISOString(),
        title: `${act.actionType} (${act.stageCode})`,
        actorDisplayName: act.actorDisplayName,
        actorUserId: act.actorUserId,
        details: { stageCode: act.stageCode, executionNo: act.executionNo, unitName: act.unitName, reason: act.reason, ...act.payload }
      })
    }

    // 6. Stage Submission Snapshots
    const snapshots = await this.pool.query<{
      id: string
      stageCode: string
      executionNo: number
      sha256: string
      createdAt: string
    }>(
      `SELECT sn.id, se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              sn.sha256, sn.created_at AS "createdAt"
         FROM stage_submission_snapshot sn
         JOIN stage_execution se ON se.id = sn.stage_execution_id
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
        WHERE wi.request_id = $1
        ORDER BY sn.created_at ASC`,
      [requestId]
    )
    for (const sn of snapshots.rows) {
      events.push({
        kind: 'SUBMISSION_SNAPSHOT',
        id: sn.id,
        timestamp: new Date(sn.createdAt).toISOString(),
        title: `Submission snapshot frozen for Stage ${sn.stageCode} (Exec ${sn.executionNo})`,
        details: { stageCode: sn.stageCode, executionNo: sn.executionNo, sha256: sn.sha256 }
      })
    }

    // 7. Notes
    const notes = await this.listNotes(requestId, actor)
    for (const note of notes) {
      events.push({
        kind: 'NOTE',
        id: note.id,
        timestamp: note.createdAt,
        title: `Note added by ${note.authorDisplayName}`,
        actorDisplayName: note.authorDisplayName,
        actorUserId: note.authorUserId,
        details: { body: note.body, stageCode: note.stageCode, unitName: note.unitName }
      })
    }

    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    return events
  }

  async getManagerInbox(
    actor: WorkflowRequestContext
  ): Promise<{ stages: StageExecutionSummary[], rejectedRequests: WorkflowRequestSummary[] }> {
    await requireOperationalUser(this.pool, actor.userId)

    // Current OPEN stages for units where actor is current manager (requires active membership + active manager assignment)
    const stagesResult = await this.pool.query<StageRow>(
      `SELECT se.id, se.iteration_id AS "iterationId", wi.iteration_no AS "iterationNo",
              wr.id AS "requestId", wr.request_number AS "requestNumber", wr.request_type AS "requestType",
              wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
              se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              se.responsible_unit_id AS "responsibleUnitId", u.name AS "responsibleUnitName",
              u.kind AS "responsibleUnitKind", se.status, se.work_state AS "workState",
              se.opened_at AS "openedAt", se.completed_at AS "completedAt",
              wa.assigned_to_user_id AS "activeAssigneeUserId",
              assignee.display_name AS "activeAssigneeDisplayName",
              wa.assigned_at AS "assignedAt"
         FROM stage_execution se
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN workflow_request wr ON wr.id = wi.request_id
         JOIN operational_unit u ON u.id = se.responsible_unit_id
         JOIN unit_manager_assignment ma ON ma.unit_id = u.id AND ma.effective_to IS NULL
         JOIN user_unit_membership m ON m.unit_id = u.id AND m.user_id = ma.manager_user_id AND m.effective_to IS NULL
         LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
         LEFT JOIN work_assignment wa ON wa.stage_execution_id = se.id AND wa.ended_at IS NULL
         LEFT JOIN user_account assignee ON assignee.id = wa.assigned_to_user_id
        WHERE ma.manager_user_id = $1
          AND se.status = 'OPEN'
          AND wi.status = 'ACTIVE'
          AND wr.status IN ('DRAFT', 'ACTIVE')
          AND wr.current_iteration_id = wi.id
          AND wr.current_stage_code = se.stage_code
        ORDER BY se.opened_at DESC`,
      [actor.userId]
    )

    // If actor is current HR manager, include REJECTED_PENDING_HR_DECISION requests
    const isHrManager = await isCurrentHrManager(this.pool, actor.userId)
    const rejectedRequests: WorkflowRequestSummary[] = []

    if (isHrManager) {
      const rejectedResult = await this.pool.query<RequestRow>(
        `SELECT wr.id, wr.request_number AS "requestNumber", wr.request_type AS "requestType",
                wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
                ru.code AS "routingUnitCode", wr.status, wr.current_iteration_id AS "currentIterationId",
                wi.iteration_no AS "currentIterationNo", wr.current_stage_code AS "currentStageCode",
                NULL AS "currentExecutionId", NULL AS "currentWorkState",
                NULL AS "currentResponsibleUnitId", NULL AS "currentResponsibleUnitName",
                wr.version, wr.created_by_user_id AS "createdByUserId",
                creator.display_name AS "createdByUserDisplayName",
                wr.created_at AS "createdAt", wr.completed_at AS "completedAt", wr.cancelled_at AS "cancelledAt"
           FROM workflow_request wr
           LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
           LEFT JOIN workflow_iteration wi ON wi.id = wr.current_iteration_id
           LEFT JOIN user_account creator ON creator.id = wr.created_by_user_id
          WHERE wr.status = 'REJECTED_PENDING_HR_DECISION'
          ORDER BY wr.created_at DESC`,
        []
      )
      rejectedRequests.push(...rejectedResult.rows.map(r => this.mapRequestSummary(r)))
    }

    return {
      stages: stagesResult.rows.map(r => this.mapStageSummary(r)),
      rejectedRequests
    }
  }

  async getMyWork(
    actor: WorkflowRequestContext
  ): Promise<StageExecutionSummary[]> {
    await requireOperationalUser(this.pool, actor.userId)

    const result = await this.pool.query<StageRow>(
      `SELECT se.id, se.iteration_id AS "iterationId", wi.iteration_no AS "iterationNo",
              wr.id AS "requestId", wr.request_number AS "requestNumber", wr.request_type AS "requestType",
              wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
              se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              se.responsible_unit_id AS "responsibleUnitId", u.name AS "responsibleUnitName",
              u.kind AS "responsibleUnitKind", se.status, se.work_state AS "workState",
              se.opened_at AS "openedAt", se.completed_at AS "completedAt",
              wa.assigned_to_user_id AS "activeAssigneeUserId",
              assignee.display_name AS "activeAssigneeDisplayName",
              wa.assigned_at AS "assignedAt"
         FROM stage_execution se
         JOIN work_assignment wa ON wa.stage_execution_id = se.id AND wa.ended_at IS NULL
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN workflow_request wr ON wr.id = wi.request_id
         JOIN operational_unit u ON u.id = se.responsible_unit_id
         LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
         LEFT JOIN user_account assignee ON assignee.id = wa.assigned_to_user_id
        WHERE wa.assigned_to_user_id = $1
          AND se.status = 'OPEN'
          AND wi.status = 'ACTIVE'
          AND wr.status IN ('DRAFT', 'ACTIVE')
          AND wr.current_iteration_id = wi.id
          AND wr.current_stage_code = se.stage_code
        ORDER BY wa.assigned_at DESC`,
      [actor.userId]
    )

    return result.rows.map(r => this.mapStageSummary(r))
  }

  async getRequest(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<WorkflowRequestSummary & { candidates: RequestCandidateSummary[] }> {
    const requestId = uuid(requestIdValue, 'requestId')
    await requireOperationalUser(this.pool, actor.userId)
    await requireRequestReadAccess(this.pool, actor.userId, requestId)

    const summary = await this.getRequestById(this.pool, requestId)
    const candidatesResult = await this.pool.query<{
      id: string
      requestId: string
      employeeSnapshotId: string
      personnelNumber: string
      frozenData: Record<string, unknown>
      acceptedData: Record<string, unknown>
    }>(
      `SELECT c.id, c.request_id AS "requestId", c.employee_snapshot_id AS "employeeSnapshotId",
              s.personnel_number AS "personnelNumber", c.frozen_data AS "frozenData",
              c.accepted_data AS "acceptedData"
         FROM request_candidate c
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
        WHERE c.request_id = $1
        ORDER BY s.personnel_number`,
      [requestId]
    )

    const candidates = candidatesResult.rows.map(c => {
      const data = c.frozenData ?? {}
      return {
        id: c.id,
        requestId: c.requestId,
        employeeSnapshotId: c.employeeSnapshotId,
        personnelNumber: c.personnelNumber,
        employeeName: String(data.employeeName ?? ''),
        currentJobTitle: (data.currentJobTitle as string) ?? null,
        frozenData: c.frozenData,
        acceptedData: c.acceptedData
      }
    })

    return { ...summary, candidates }
  }

  async listRequests(
    actor: WorkflowRequestContext,
    skip = 0,
    top = 50
  ): Promise<WorkflowRequestSummary[]> {
    await requireOperationalUser(this.pool, actor.userId)

    const result = await this.pool.query<RequestRow>(
      `SELECT DISTINCT wr.id, wr.request_number AS "requestNumber", wr.request_type AS "requestType",
              wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
              ru.code AS "routingUnitCode", wr.status, wr.current_iteration_id AS "currentIterationId",
              wi.iteration_no AS "currentIterationNo", wr.current_stage_code AS "currentStageCode",
              current_se.id AS "currentExecutionId", current_se.work_state AS "currentWorkState",
              current_se.responsible_unit_id AS "currentResponsibleUnitId", u.name AS "currentResponsibleUnitName",
              wr.version, wr.created_by_user_id AS "createdByUserId",
              creator.display_name AS "createdByUserDisplayName",
              wr.created_at AS "createdAt", wr.completed_at AS "completedAt", wr.cancelled_at AS "cancelledAt"
         FROM workflow_request wr
         LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
         LEFT JOIN workflow_iteration wi ON wi.id = wr.current_iteration_id
         LEFT JOIN stage_execution current_se ON current_se.iteration_id = wr.current_iteration_id AND current_se.status = 'OPEN'
         LEFT JOIN operational_unit u ON u.id = current_se.responsible_unit_id
         LEFT JOIN user_account creator ON creator.id = wr.created_by_user_id
        WHERE wr.created_by_user_id = $1
           OR EXISTS (
                SELECT 1 FROM work_assignment wa
                JOIN stage_execution se2 ON se2.id = wa.stage_execution_id
                JOIN workflow_iteration wi2 ON wi2.id = se2.iteration_id
                WHERE wi2.request_id = wr.id AND (wa.assigned_to_user_id = $1 OR wa.assigned_by_user_id = $1)
              )
           OR EXISTS (
                SELECT 1 FROM stage_action sa
                JOIN stage_execution se3 ON se3.id = sa.stage_execution_id
                JOIN workflow_iteration wi3 ON wi3.id = se3.iteration_id
                WHERE wi3.request_id = wr.id AND sa.actor_user_id = $1
              )
           OR EXISTS (
                SELECT 1 FROM workflow_note wn
                WHERE wn.request_id = wr.id AND wn.author_user_id = $1
              )
           OR EXISTS (
                SELECT 1 FROM stage_execution se4
                JOIN workflow_iteration wi4 ON wi4.id = se4.iteration_id
                JOIN unit_manager_assignment ma ON ma.unit_id = se4.responsible_unit_id AND ma.manager_user_id = $1 AND ma.effective_to IS NULL
                JOIN user_unit_membership m ON m.unit_id = se4.responsible_unit_id AND m.user_id = $1 AND m.effective_to IS NULL
                WHERE wi4.request_id = wr.id
              )
           OR EXISTS (
                SELECT 1 FROM operational_unit hr
                JOIN unit_manager_assignment ma_hr ON ma_hr.unit_id = hr.id AND ma_hr.manager_user_id = $1 AND ma_hr.effective_to IS NULL
                JOIN user_unit_membership m_hr ON m_hr.unit_id = hr.id AND m_hr.user_id = $1 AND m_hr.effective_to IS NULL
                WHERE hr.kind = 'HR' AND hr.is_active = TRUE
              )
        ORDER BY wr.created_at DESC
        LIMIT $2 OFFSET $3`,
      [actor.userId, top, skip]
    )

    return result.rows.map(r => this.mapRequestSummary(r))
  }

  async listNotifications(
    actor: WorkflowRequestContext,
    skip = 0,
    top = 50,
    unreadOnly = false
  ): Promise<NotificationSummary[]> {
    await requireOperationalUser(this.pool, actor.userId)

    const result = await this.pool.query<{
      id: string
      recipientUserId: string
      requestId: string | null
      stageExecutionId: string | null
      notificationType: string
      isRead: boolean
      createdAt: string
      requestNumber: string | null
      stageCode: StageCode | null
    }>(
      `SELECT n.id, n.recipient_user_id AS "recipientUserId", n.request_id AS "requestId",
              n.stage_execution_id AS "stageExecutionId", n.notification_type AS "notificationType",
              n.is_read AS "isRead", n.created_at AS "createdAt",
              wr.request_number AS "requestNumber", se.stage_code AS "stageCode"
         FROM notification n
         LEFT JOIN workflow_request wr ON wr.id = n.request_id
         LEFT JOIN stage_execution se ON se.id = n.stage_execution_id
        WHERE n.recipient_user_id = $1
          AND ($2::boolean = FALSE OR n.is_read = FALSE)
        ORDER BY n.created_at DESC
        LIMIT $3 OFFSET $4`,
      [actor.userId, unreadOnly, top, skip]
    )

    return result.rows.map(r => ({
      ...r,
      createdAt: new Date(r.createdAt).toISOString()
    }))
  }

  async markNotificationRead(
    notificationIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<void> {
    const notificationId = uuid(notificationIdValue, 'notificationId')
    await requireOperationalUser(this.pool, actor.userId)

    const result = await this.pool.query(
      `UPDATE notification
          SET is_read = TRUE
        WHERE id = $1 AND recipient_user_id = $2`,
      [notificationId, actor.userId]
    )
    if (result.rowCount === 0) {
      throw new AppError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND')
    }
  }

  private async getRequestById(db: Queryable, requestId: string): Promise<WorkflowRequestSummary> {
    const result = await db.query<RequestRow>(
      `SELECT wr.id, wr.request_number AS "requestNumber", wr.request_type AS "requestType",
              wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
              ru.code AS "routingUnitCode", wr.status, wr.current_iteration_id AS "currentIterationId",
              wi.iteration_no AS "currentIterationNo", wr.current_stage_code AS "currentStageCode",
              current_se.id AS "currentExecutionId", current_se.work_state AS "currentWorkState",
              current_se.responsible_unit_id AS "currentResponsibleUnitId", u.name AS "currentResponsibleUnitName",
              wr.version, wr.created_by_user_id AS "createdByUserId",
              creator.display_name AS "createdByUserDisplayName",
              wr.created_at AS "createdAt", wr.completed_at AS "completedAt", wr.cancelled_at AS "cancelledAt"
         FROM workflow_request wr
         LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
         LEFT JOIN workflow_iteration wi ON wi.id = wr.current_iteration_id
         LEFT JOIN stage_execution current_se ON current_se.iteration_id = wr.current_iteration_id AND current_se.status = 'OPEN'
         LEFT JOIN operational_unit u ON u.id = current_se.responsible_unit_id
         LEFT JOIN user_account creator ON creator.id = wr.created_by_user_id
        WHERE wr.id = $1`,
      [requestId]
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
    return this.mapRequestSummary(row)
  }

  private async getStageById(db: Queryable, stageExecutionId: string): Promise<StageExecutionSummary> {
    const result = await db.query<StageRow>(
      `SELECT se.id, se.iteration_id AS "iterationId", wi.iteration_no AS "iterationNo",
              wr.id AS "requestId", wr.request_number AS "requestNumber", wr.request_type AS "requestType",
              wr.routing_unit_id AS "routingUnitId", ru.name_ar AS "routingUnitNameAr",
              se.stage_code AS "stageCode", se.execution_no AS "executionNo",
              se.responsible_unit_id AS "responsibleUnitId", u.name AS "responsibleUnitName",
              u.kind AS "responsibleUnitKind", se.status, se.work_state AS "workState",
              se.opened_at AS "openedAt", se.completed_at AS "completedAt",
              wa.assigned_to_user_id AS "activeAssigneeUserId",
              assignee.display_name AS "activeAssigneeDisplayName",
              wa.assigned_at AS "assignedAt"
         FROM stage_execution se
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN workflow_request wr ON wr.id = wi.request_id
         JOIN operational_unit u ON u.id = se.responsible_unit_id
         LEFT JOIN routing_unit ru ON ru.id = wr.routing_unit_id
         LEFT JOIN work_assignment wa ON wa.stage_execution_id = se.id AND wa.ended_at IS NULL
         LEFT JOIN user_account assignee ON assignee.id = wa.assigned_to_user_id
        WHERE se.id = $1`,
      [stageExecutionId]
    )
    const row = result.rows[0]
    if (!row) throw new AppError(404, 'Stage execution not found', 'STAGE_NOT_FOUND')
    return this.mapStageSummary(row)
  }

  private mapRequestSummary(row: RequestRow): WorkflowRequestSummary {
    return {
      id: row.id,
      requestNumber: row.requestNumber,
      requestType: row.requestType as any,
      routingUnitId: row.routingUnitId,
      routingUnitNameAr: row.routingUnitNameAr,
      routingUnitCode: row.routingUnitCode,
      status: row.status as any,
      currentIterationId: row.currentIterationId,
      currentIterationNo: row.currentIterationNo !== null ? Number(row.currentIterationNo) : null,
      currentStageCode: (row.currentStageCode as StageCode) ?? null,
      currentExecutionId: row.currentExecutionId,
      currentWorkState: (row.currentWorkState as any) ?? null,
      currentResponsibleUnitId: row.currentResponsibleUnitId,
      currentResponsibleUnitName: row.currentResponsibleUnitName,
      version: Number(row.version),
      createdByUserId: row.createdByUserId,
      createdByUserDisplayName: row.createdByUserDisplayName,
      createdAt: new Date(row.createdAt).toISOString(),
      completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
      cancelledAt: row.cancelledAt ? new Date(row.cancelledAt).toISOString() : null
    }
  }

  private mapStageSummary(row: StageRow): StageExecutionSummary {
    return {
      id: row.id,
      iterationId: row.iterationId,
      iterationNo: Number(row.iterationNo),
      requestId: row.requestId,
      requestNumber: row.requestNumber,
      requestType: row.requestType as any,
      routingUnitId: row.routingUnitId,
      routingUnitNameAr: row.routingUnitNameAr,
      stageCode: row.stageCode as StageCode,
      executionNo: Number(row.executionNo),
      responsibleUnitId: row.responsibleUnitId,
      responsibleUnitName: row.responsibleUnitName,
      responsibleUnitKind: row.responsibleUnitKind,
      status: row.status as any,
      workState: row.workState as any,
      openedAt: new Date(row.openedAt).toISOString(),
      completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : null,
      activeAssigneeUserId: row.activeAssigneeUserId,
      activeAssigneeDisplayName: row.activeAssigneeDisplayName,
      assignedAt: row.assignedAt ? new Date(row.assignedAt).toISOString() : null
    }
  }
}
