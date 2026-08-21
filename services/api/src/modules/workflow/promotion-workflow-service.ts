import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { optionalText, text, uuid } from '../../shared/validation.ts'
import { recordAuditEvent } from '../audit/security-events.ts'
import {
  isCurrentUnitManager,
  lockCurrentStageExecution,
  requireOperationalUser,
  requireRequestReadAccess
} from './workflow-auth.ts'
import { insertStageAction } from './workflow-engine-service.ts'
import type {
  PromotionDecisionSummary,
  PromotionDecisionType,
  PromotionP4ValidationResult,
  UpsertPromotionDecisionInput,
  WorkflowRequestContext
} from './workflow-types.ts'

export class PromotionWorkflowService {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert a promotion decision for a candidate on the current active P4 stage execution.
   */
  async upsertDecision(
    stageExecutionIdValue: unknown,
    candidateIdValue: unknown,
    input: UpsertPromotionDecisionInput,
    actor: WorkflowRequestContext
  ): Promise<PromotionDecisionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const candidateId = uuid(candidateIdValue, 'candidateId')

    // 1. Validate decisionType
    if (input.decisionType !== 'SAME_POSITION' && input.decisionType !== 'OTHER_POSITION') {
      throw new AppError(400, 'decisionType must be SAME_POSITION or OTHER_POSITION', 'INVALID_DECISION_TYPE')
    }
    const decisionType: PromotionDecisionType = input.decisionType

    // 2. Validate recommendation (required non-empty text, max 80)
    const recommendation = text(input.recommendation, 'recommendation', 80, 1)

    // 3. Validate notes (optional text, max 4000)
    const notes = optionalText(input.notes, 'notes', 4000)

    return await withTransaction(this.pool, async db => {
      // Step 1: Require active operational user
      await requireOperationalUser(db, actor.userId)

      // Step 2: Lock current stage execution
      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      // Step 3: Verify request type and stage code
      if (request.requestType !== 'PROMOTION') {
        throw new AppError(400, 'Promotion decisions are only valid for PROMOTION requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'P4') {
        throw new AppError(409, `Promotion decisions can only be edited at stage P4, current is ${stageExecution.stageCode}`, 'STAGE_NOT_P4')
      }

      // Step 4: Verify stage editor authorization
      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        // Must be active assignee on this stage execution
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to edit decisions on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }

        // Assignee can only edit when work_state is ASSIGNED, IN_PROGRESS, or CORRECTION_REQUIRED
        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot edit decisions after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      // Step 5: Verify candidate belongs to this request
      const candidateResult = await db.query<{
        id: string
        requestId: string
        personnelNumber: string
        employeeData: Record<string, unknown>
      }>(
        `SELECT c.id, c.request_id AS "requestId", s.personnel_number AS "personnelNumber",
                s.employee_data AS "employeeData"
           FROM request_candidate c
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE c.id = $1`,
        [candidateId]
      )
      const candidate = candidateResult.rows[0]
      if (!candidate || candidate.requestId !== request.id) {
        throw new AppError(404, 'Candidate not found in this workflow request', 'CANDIDATE_NOT_IN_REQUEST')
      }

      const empData = candidate.employeeData ?? {}
      const currentJobTitle = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : ''

      // Step 6: Validate targetJobTitle depending on decisionType
      let targetJobTitle: string | null = null
      let effectiveNominatedJob: string | null = null

      if (decisionType === 'SAME_POSITION') {
        // For SAME_POSITION: targetJobTitle must not be provided / must be empty
        if (input.targetJobTitle !== undefined && input.targetJobTitle !== null && typeof input.targetJobTitle === 'string' && input.targetJobTitle.trim() !== '') {
          throw new AppError(400, 'targetJobTitle must not be provided for SAME_POSITION decisions', 'TARGET_JOB_NOT_ALLOWED')
        }
        targetJobTitle = null
        effectiveNominatedJob = currentJobTitle || null
      } else {
        // For OTHER_POSITION: targetJobTitle is required (max 240, trimmed)
        const trimmedTarget = text(input.targetJobTitle, 'targetJobTitle', 240, 1)
        if (currentJobTitle && trimmedTarget.toLowerCase() === currentJobTitle.toLowerCase()) {
          throw new AppError(400, 'targetJobTitle for OTHER_POSITION must differ from current job title', 'TARGET_JOB_MUST_DIFFER')
        }
        targetJobTitle = trimmedTarget
        effectiveNominatedJob = trimmedTarget
      }

      // Step 7: Update work_state to IN_PROGRESS if currently ASSIGNED
      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(
          `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
          [stageExecutionId]
        )
      }

      // Step 8: Upsert promotion_decision for (stage_execution_id, candidate_id) with stable row id
      const existingResult = await db.query<{ id: string }>(
        `SELECT id FROM promotion_decision WHERE stage_execution_id = $1 AND candidate_id = $2`,
        [stageExecutionId, candidateId]
      )

      let decisionId: string
      if (existingResult.rows[0]) {
        decisionId = existingResult.rows[0].id
        await db.query(
          `UPDATE promotion_decision
              SET decision_type = $2,
                  target_job_title = $3,
                  recommendation = $4,
                  notes = $5
            WHERE id = $1`,
          [decisionId, decisionType, targetJobTitle, recommendation, notes]
        )
      } else {
        decisionId = randomUUID()
        await db.query(
          `INSERT INTO promotion_decision
            (id, stage_execution_id, candidate_id, decision_type, target_job_title, recommendation, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [decisionId, stageExecutionId, candidateId, decisionType, targetJobTitle, recommendation, notes]
        )
      }

      // Step 9: Record stage action and audit event
      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'PROMOTION_DECISION_SAVED', null, {
        candidateId,
        personnelNumber: candidate.personnelNumber,
        decisionType,
        targetJobTitle,
        recommendation
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'PROMOTION_DECISION_SAVED',
        subjectType: 'promotion_decision',
        subjectId: decisionId,
        details: {
          requestId: request.id,
          stageExecutionId,
          candidateId,
          personnelNumber: candidate.personnelNumber,
          decisionType,
          targetJobTitle,
          recommendation
        }
      })

      return {
        id: decisionId,
        stageExecutionId,
        candidateId,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        decisionType,
        targetJobTitle,
        effectiveNominatedJob,
        recommendation,
        notes
      }
    })
  }

  /**
   * Get current authoritative promotion decisions for a request.
   */
  async getAuthoritativeDecisions(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<PromotionDecisionSummary[]> {
    const requestId = uuid(requestIdValue, 'requestId')

    await requireOperationalUser(this.pool, actor.userId)
    await requireRequestReadAccess(this.pool, actor.userId, requestId)

    const requestResult = await this.pool.query<{
      id: string
      requestType: string
      status: string
      currentIterationId: string | null
      currentStageCode: string | null
    }>(
      `SELECT id, request_type AS "requestType", status,
              current_iteration_id AS "currentIterationId",
              current_stage_code AS "currentStageCode"
         FROM workflow_request
        WHERE id = $1`,
      [requestId]
    )
    const request = requestResult.rows[0]
    if (!request) {
      throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
    }
    if (request.requestType !== 'PROMOTION') {
      throw new AppError(400, 'Promotion decisions are only available for PROMOTION requests', 'INVALID_REQUEST_TYPE')
    }

    if (!request.currentIterationId) {
      return []
    }

    // Determine authoritative P4 execution
    let targetP4ExecutionId: string | null = null

    if (request.currentStageCode === 'P4') {
      // At P4: use the current OPEN P4 execution in the current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'P4' AND status = 'OPEN'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetP4ExecutionId = execResult.rows[0]?.id ?? null
    } else if (
      request.currentStageCode === 'P4O' ||
      request.currentStageCode === 'P5' ||
      (request.status === 'COMPLETED' && request.currentStageCode === null)
    ) {
      // At P4O or P5 (or completed): use the latest COMPLETED P4 execution in the current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'P4' AND status = 'COMPLETED'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetP4ExecutionId = execResult.rows[0]?.id ?? null
    } else {
      // Earlier stage (P1, P2, P3) or returned: prior decisions are historical only
      return []
    }

    if (!targetP4ExecutionId) {
      return []
    }

    const decisionsResult = await this.pool.query<{
      id: string
      stageExecutionId: string
      candidateId: string
      personnelNumber: string
      employeeData: Record<string, unknown>
      decisionType: string
      targetJobTitle: string | null
      recommendation: string | null
      notes: string | null
    }>(
      `SELECT d.id, d.stage_execution_id AS "stageExecutionId", d.candidate_id AS "candidateId",
              s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData",
              d.decision_type AS "decisionType", d.target_job_title AS "targetJobTitle",
              d.recommendation, d.notes
         FROM promotion_decision d
         JOIN request_candidate c ON c.id = d.candidate_id
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
        WHERE d.stage_execution_id = $1
        ORDER BY s.personnel_number`,
      [targetP4ExecutionId]
    )

    return decisionsResult.rows.map(row => {
      const empData = row.employeeData ?? {}
      const currentJob = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : null
      const decisionType = row.decisionType as PromotionDecisionType
      return {
        id: row.id,
        stageExecutionId: row.stageExecutionId,
        candidateId: row.candidateId,
        personnelNumber: row.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        decisionType,
        targetJobTitle: decisionType === 'SAME_POSITION' ? null : row.targetJobTitle,
        effectiveNominatedJob: decisionType === 'SAME_POSITION' ? currentJob : row.targetJobTitle,
        recommendation: row.recommendation ?? '',
        notes: row.notes
      }
    })
  }

  /**
   * Validate P4 readiness and resolve destination (P5 if all SAME_POSITION, P4O if any OTHER_POSITION).
   * Intended for Phase 6 single-transaction sign-and-advance invocation.
   */
  async validatePromotionP4AndResolveDestination(
    db: Queryable,
    requestId: string,
    iterationId: string,
    p4StageExecutionId: string
  ): Promise<PromotionP4ValidationResult> {
    // 1. Verify request type
    const requestResult = await db.query<{ requestType: string }>(
      `SELECT request_type AS "requestType" FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    if (requestResult.rows[0]?.requestType !== 'PROMOTION') {
      throw new AppError(400, 'Promotion P4 validation requires PROMOTION request', 'INVALID_REQUEST_TYPE')
    }

    // 2. Verify stage execution is P4 and OPEN
    const stageResult = await db.query<{ stageCode: string, status: string }>(
      `SELECT stage_code AS "stageCode", status FROM stage_execution WHERE id = $1`,
      [p4StageExecutionId]
    )
    const stage = stageResult.rows[0]
    if (!stage || stage.stageCode !== 'P4') {
      throw new AppError(409, 'Stage execution is not P4', 'STAGE_NOT_P4')
    }
    if (stage.status !== 'OPEN') {
      throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
    }

    // 3. Load all candidates
    const candidatesResult = await db.query<{
      id: string
      personnelNumber: string
      employeeData: Record<string, unknown>
    }>(
      `SELECT c.id, s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData"
         FROM request_candidate c
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
        WHERE c.request_id = $1
        ORDER BY s.personnel_number`,
      [requestId]
    )
    if (candidatesResult.rows.length === 0) {
      throw new AppError(400, 'At least one candidate is required for promotion request', 'CANDIDATES_REQUIRED')
    }

    // 4. Load decisions for this P4 execution
    const decisionsResult = await db.query<{
      id: string
      stageExecutionId: string
      candidateId: string
      decisionType: string
      targetJobTitle: string | null
      recommendation: string | null
      notes: string | null
    }>(
      `SELECT id, stage_execution_id AS "stageExecutionId", candidate_id AS "candidateId",
              decision_type AS "decisionType", target_job_title AS "targetJobTitle",
              recommendation, notes
         FROM promotion_decision
        WHERE stage_execution_id = $1`,
      [p4StageExecutionId]
    )

    const decisionMap = new Map(decisionsResult.rows.map(d => [d.candidateId, d]))

    // 5. Check every candidate has a valid decision
    const summaries: PromotionDecisionSummary[] = []
    let hasOtherPosition = false

    for (const candidate of candidatesResult.rows) {
      const decision = decisionMap.get(candidate.id)
      if (!decision) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} lacks a promotion decision`, 'PROMOTION_DECISION_MISSING')
      }

      const rec = (decision.recommendation ?? '').trim()
      if (!rec) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} recommendation is required`, 'RECOMMENDATION_REQUIRED')
      }

      const empData = candidate.employeeData ?? {}
      const currentJob = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : null
      const decisionType = decision.decisionType as PromotionDecisionType

      let targetJob: string | null = null
      let nominatedJob: string | null = null

      if (decisionType === 'SAME_POSITION') {
        targetJob = null
        nominatedJob = currentJob
      } else if (decisionType === 'OTHER_POSITION') {
        const target = (decision.targetJobTitle ?? '').trim()
        if (!target) {
          throw new AppError(400, `Candidate ${candidate.personnelNumber} targetJobTitle is required for OTHER_POSITION`, 'TARGET_JOB_REQUIRED')
        }
        if (currentJob && target.toLowerCase() === currentJob.toLowerCase()) {
          throw new AppError(400, `Candidate ${candidate.personnelNumber} targetJobTitle must differ from current job`, 'TARGET_JOB_MUST_DIFFER')
        }
        targetJob = target
        nominatedJob = target
        hasOtherPosition = true
      }

      summaries.push({
        id: decision.id,
        stageExecutionId: p4StageExecutionId,
        candidateId: candidate.id,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        decisionType,
        targetJobTitle: targetJob,
        effectiveNominatedJob: nominatedJob,
        recommendation: rec,
        notes: decision.notes
      })
    }

    const nextStageCode: 'P5' | 'P4O' = hasOtherPosition ? 'P4O' : 'P5'
    return {
      nextStageCode,
      decisions: summaries,
      hasOtherPosition
    }
  }
}
