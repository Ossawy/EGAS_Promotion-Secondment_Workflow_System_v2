import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { text, uuid } from '../../shared/validation.ts'
import { recordAuditEvent } from '../audit/security-events.ts'
import {
  isCurrentUnitManager,
  lockCurrentStageExecution,
  requireOperationalUser,
  requireRequestReadAccess
} from './workflow-auth.ts'
import { insertStageAction } from './workflow-engine-service.ts'
import type {
  SecondmentPositionOptionInput,
  SecondmentPositionOptionSummary,
  SecondmentS2PreparationInput,
  SecondmentS2PreparationSummary,
  SecondmentS2CandidateOptionGroup,
  SecondmentS2ValidationResult,
  SecondmentS3ValidationResult,
  SecondmentSelectionInput,
  SecondmentSelectionSummary,
  WorkflowRequestContext
} from './workflow-types.ts'

export class SecondmentWorkflowService {
  constructor(private readonly pool: Pool) {}

  async upsertS2CandidatePreparation(
    stageExecutionIdValue: unknown,
    candidateIdValue: unknown,
    input: SecondmentS2PreparationInput,
    actor: WorkflowRequestContext
  ): Promise<SecondmentS2PreparationSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const candidateId = uuid(candidateIdValue, 'candidateId')
    const lastPromotionReport = text(input.lastPromotionReport, 'lastPromotionReport', 4000, 1)
    const jobCategoryCode = text(input.jobCategoryCode, 'jobCategoryCode', 80, 1)

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)
      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)
      if (request.requestType !== 'SECONDMENT') {
        throw new AppError(400, 'Secondment preparation is only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'S2') {
        throw new AppError(409, `Secondment preparation can only be edited at stage S2, current is ${stageExecution.stageCode}`, 'STAGE_NOT_S2')
      }
      if (stageExecution.status !== 'OPEN') {
        throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
      }

      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to edit Secondment preparation on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }
        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot edit Secondment preparation after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      const candidateResult = await db.query<{ id: string, requestId: string, personnelNumber: string, acceptedData: Record<string, unknown> | null }>(
        `SELECT c.id, c.request_id AS "requestId", s.personnel_number AS "personnelNumber",
                c.accepted_data AS "acceptedData"
          FROM request_candidate c
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE c.id = $1
          FOR UPDATE`,
        [candidateId]
      )
      const candidate = candidateResult.rows[0]
      if (!candidate || candidate.requestId !== request.id) {
        throw new AppError(404, 'Candidate not found in this workflow request', 'CANDIDATE_NOT_IN_REQUEST')
      }

      const categoryResult = await db.query<{ code: string, name: string }>(
        `SELECT code, name FROM job_category_reference WHERE code = $1 AND is_active = TRUE`,
        [jobCategoryCode]
      )
      const category = categoryResult.rows[0]
      if (!category) {
        throw new AppError(400, `Active job category reference not found for code: ${jobCategoryCode}`, 'INVALID_JOB_CATEGORY')
      }

      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(`UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`, [stageExecutionId])
      }
      const existingAcceptedData = candidate.acceptedData && typeof candidate.acceptedData === 'object' && !Array.isArray(candidate.acceptedData)
        ? candidate.acceptedData
        : {}
      const nextAcceptedData = {
        ...existingAcceptedData,
        secondmentS2Preparation: {
          lastPromotionReport,
          jobCategoryCode: category.code,
          jobCategoryName: category.name
        }
      }
      await db.query(
        `UPDATE request_candidate
            SET accepted_data = $2::jsonb
          WHERE id = $1`,
        [
          candidateId,
          JSON.stringify(nextAcceptedData)
        ]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'SECONDMENT_PREPARATION_SAVED', null, {
        candidateId,
        personnelNumber: candidate.personnelNumber,
        lastPromotionReport,
        jobCategoryCode: category.code,
        jobCategoryName: category.name
      })
      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'SECONDMENT_PREPARATION_SAVED',
        subjectType: 'request_candidate',
        subjectId: candidateId,
        details: { requestId: request.id, stageExecutionId, jobCategoryCode: category.code }
      })

      return { candidateId, lastPromotionReport, jobCategoryCode: category.code, jobCategoryName: category.name }
    })
  }

  /**
   * Add a proposed position option for a candidate at stage S2 (Organization).
   * displayOrder is server-controlled (COALESCE(MAX(display_order), -1) + 1).
   */
  async addPositionOption(
    stageExecutionIdValue: unknown,
    candidateIdValue: unknown,
    input: SecondmentPositionOptionInput,
    actor: WorkflowRequestContext
  ): Promise<SecondmentPositionOptionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const candidateId = uuid(candidateIdValue, 'candidateId')

    const positionTitle = text(input.positionTitle, 'positionTitle', 240, 1)
    const organizationalDependency = text(input.organizationalDependency, 'organizationalDependency', 240, 1)
    const qualificationStatusCode = text(input.qualificationStatus, 'qualificationStatus', 80, 1)

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)

      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      if (request.requestType !== 'SECONDMENT') {
        throw new AppError(400, 'Position options are only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'S2') {
        throw new AppError(409, `Position options can only be edited at stage S2, current is ${stageExecution.stageCode}`, 'STAGE_NOT_S2')
      }
      if (stageExecution.status !== 'OPEN') {
        throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
      }

      // Verify stage editor authorization
      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to edit position options on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }

        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot edit position options after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      // Verify candidate belongs to this request
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

      // Validate qualificationStatus against active reference table
      const refResult = await db.query<{ code: string, name: string }>(
        `SELECT code, name FROM qualification_status_reference WHERE code = $1 AND is_active = TRUE`,
        [qualificationStatusCode]
      )
      const qualificationRef = refResult.rows[0]
      if (!qualificationRef) {
        throw new AppError(400, `Active qualification status reference not found for code: ${qualificationStatusCode}`, 'INVALID_QUALIFICATION_STATUS')
      }

      // Calculate server-controlled display_order
      const orderResult = await db.query<{ nextOrder: number }>(
        `SELECT COALESCE(MAX(display_order), -1) + 1 AS "nextOrder"
           FROM secondment_position_option
          WHERE candidate_id = $1 AND source_stage_execution_id = $2`,
        [candidateId, stageExecutionId]
      )
      const displayOrder = Number(orderResult.rows[0]?.nextOrder ?? 0)

      // Update work_state to IN_PROGRESS if currently ASSIGNED
      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(
          `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
          [stageExecutionId]
        )
      }

      const optionId = randomUUID()
      await db.query(
        `INSERT INTO secondment_position_option
          (id, candidate_id, source_stage_execution_id, position_title, organizational_dependency, qualification_status, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [optionId, candidateId, stageExecutionId, positionTitle, organizationalDependency, qualificationStatusCode, displayOrder]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'SECONDMENT_OPTION_ADDED', null, {
        optionId,
        candidateId,
        personnelNumber: candidate.personnelNumber,
        positionTitle,
        organizationalDependency,
        qualificationStatus: qualificationStatusCode,
        displayOrder
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'SECONDMENT_OPTION_ADDED',
        subjectType: 'secondment_position_option',
        subjectId: optionId,
        details: {
          requestId: request.id,
          stageExecutionId,
          candidateId,
          personnelNumber: candidate.personnelNumber,
          positionTitle,
          organizationalDependency,
          qualificationStatus: qualificationStatusCode,
          displayOrder
        }
      })

      const empData = candidate.employeeData ?? {}
      return {
        id: optionId,
        sourceStageExecutionId: stageExecutionId,
        candidateId,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        positionTitle,
        organizationalDependency,
        qualificationStatusCode,
        qualificationStatusName: qualificationRef.name,
        displayOrder
      }
    })
  }

  /**
   * Update an existing proposed position option on current OPEN S2 execution.
   */
  async updatePositionOption(
    stageExecutionIdValue: unknown,
    optionIdValue: unknown,
    input: SecondmentPositionOptionInput,
    actor: WorkflowRequestContext
  ): Promise<SecondmentPositionOptionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const optionId = uuid(optionIdValue, 'optionId')

    const positionTitle = text(input.positionTitle, 'positionTitle', 240, 1)
    const organizationalDependency = text(input.organizationalDependency, 'organizationalDependency', 240, 1)
    const qualificationStatusCode = text(input.qualificationStatus, 'qualificationStatus', 80, 1)

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)

      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      if (request.requestType !== 'SECONDMENT') {
        throw new AppError(400, 'Position options are only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'S2') {
        throw new AppError(409, `Position options can only be edited at stage S2, current is ${stageExecution.stageCode}`, 'STAGE_NOT_S2')
      }
      if (stageExecution.status !== 'OPEN') {
        throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
      }

      // Verify stage editor authorization
      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to edit position options on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }

        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot edit position options after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      // Find option and verify it belongs to this stage execution and request
      const optionResult = await db.query<{
        id: string
        candidateId: string
        sourceStageExecutionId: string
        displayOrder: number
        requestId: string
        personnelNumber: string
        employeeData: Record<string, unknown>
      }>(
        `SELECT o.id, o.candidate_id AS "candidateId", o.source_stage_execution_id AS "sourceStageExecutionId",
                o.display_order AS "displayOrder", c.request_id AS "requestId",
                s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData"
           FROM secondment_position_option o
           JOIN request_candidate c ON c.id = o.candidate_id
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE o.id = $1`,
        [optionId]
      )
      const existingOption = optionResult.rows[0]
      if (!existingOption || existingOption.sourceStageExecutionId !== stageExecutionId || existingOption.requestId !== request.id) {
        throw new AppError(404, 'Position option not found on this stage execution', 'OPTION_NOT_FOUND')
      }

      // Validate qualificationStatus against active reference table
      const refResult = await db.query<{ code: string, name: string }>(
        `SELECT code, name FROM qualification_status_reference WHERE code = $1 AND is_active = TRUE`,
        [qualificationStatusCode]
      )
      const qualificationRef = refResult.rows[0]
      if (!qualificationRef) {
        throw new AppError(400, `Active qualification status reference not found for code: ${qualificationStatusCode}`, 'INVALID_QUALIFICATION_STATUS')
      }

      // Update work_state to IN_PROGRESS if currently ASSIGNED
      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(
          `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
          [stageExecutionId]
        )
      }

      await db.query(
        `UPDATE secondment_position_option
            SET position_title = $2,
                organizational_dependency = $3,
                qualification_status = $4
          WHERE id = $1`,
        [optionId, positionTitle, organizationalDependency, qualificationStatusCode]
      )

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'SECONDMENT_OPTION_UPDATED', null, {
        optionId,
        candidateId: existingOption.candidateId,
        personnelNumber: existingOption.personnelNumber,
        positionTitle,
        organizationalDependency,
        qualificationStatus: qualificationStatusCode,
        displayOrder: Number(existingOption.displayOrder)
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'SECONDMENT_OPTION_UPDATED',
        subjectType: 'secondment_position_option',
        subjectId: optionId,
        details: {
          requestId: request.id,
          stageExecutionId,
          candidateId: existingOption.candidateId,
          personnelNumber: existingOption.personnelNumber,
          positionTitle,
          organizationalDependency,
          qualificationStatus: qualificationStatusCode,
          displayOrder: Number(existingOption.displayOrder)
        }
      })

      const empData = existingOption.employeeData ?? {}
      return {
        id: optionId,
        sourceStageExecutionId: stageExecutionId,
        candidateId: existingOption.candidateId,
        personnelNumber: existingOption.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        positionTitle,
        organizationalDependency,
        qualificationStatusCode,
        qualificationStatusName: qualificationRef.name,
        displayOrder: Number(existingOption.displayOrder)
      }
    })
  }

  /**
   * Remove a proposed position option on current OPEN S2 execution.
   */
  async removePositionOption(
    stageExecutionIdValue: unknown,
    optionIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<{ success: true, optionId: string }> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const optionId = uuid(optionIdValue, 'optionId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)

      const { request, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      if (request.requestType !== 'SECONDMENT') {
        throw new AppError(400, 'Position options are only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'S2') {
        throw new AppError(409, `Position options can only be edited at stage S2, current is ${stageExecution.stageCode}`, 'STAGE_NOT_S2')
      }
      if (stageExecution.status !== 'OPEN') {
        throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
      }

      // Verify stage editor authorization
      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to remove position options on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }

        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot remove position options after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      const optionResult = await db.query<{
        id: string
        candidateId: string
        sourceStageExecutionId: string
        displayOrder: number
        requestId: string
        personnelNumber: string
      }>(
        `SELECT o.id, o.candidate_id AS "candidateId", o.source_stage_execution_id AS "sourceStageExecutionId",
                o.display_order AS "displayOrder", c.request_id AS "requestId",
                s.personnel_number AS "personnelNumber"
           FROM secondment_position_option o
           JOIN request_candidate c ON c.id = o.candidate_id
           JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
          WHERE o.id = $1`,
        [optionId]
      )
      const existingOption = optionResult.rows[0]
      if (!existingOption || existingOption.sourceStageExecutionId !== stageExecutionId || existingOption.requestId !== request.id) {
        throw new AppError(404, 'Position option not found on this stage execution', 'OPTION_NOT_FOUND')
      }

      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(
          `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
          [stageExecutionId]
        )
      }

      await db.query(`DELETE FROM secondment_position_option WHERE id = $1`, [optionId])

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'SECONDMENT_OPTION_REMOVED', null, {
        optionId,
        candidateId: existingOption.candidateId,
        personnelNumber: existingOption.personnelNumber,
        displayOrder: Number(existingOption.displayOrder)
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'SECONDMENT_OPTION_REMOVED',
        subjectType: 'secondment_position_option',
        subjectId: optionId,
        details: {
          requestId: request.id,
          stageExecutionId,
          candidateId: existingOption.candidateId,
          personnelNumber: existingOption.personnelNumber
        }
      })

      return { success: true, optionId }
    })
  }

  /**
   * Get authoritative position options for a Secondment request.
   */
  async getAuthoritativePositionOptions(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<SecondmentPositionOptionSummary[]> {
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
    if (request.requestType !== 'SECONDMENT') {
      throw new AppError(400, 'Position options are only available for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
    }

    if (!request.currentIterationId) {
      return []
    }

    let targetS2ExecutionId: string | null = null

    if (request.currentStageCode === 'S2') {
      // At S2: use the current OPEN S2 execution in the current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'S2' AND status = 'OPEN'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetS2ExecutionId = execResult.rows[0]?.id ?? null
    } else if (
      request.currentStageCode === 'S3' ||
      request.currentStageCode === 'S4' ||
      request.currentStageCode === 'S5' ||
      (request.status === 'COMPLETED' && request.currentStageCode === null)
    ) {
      // At S3, S4, S5 (or completed): use latest COMPLETED S2 execution in the current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'S2' AND status = 'COMPLETED'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetS2ExecutionId = execResult.rows[0]?.id ?? null
    } else {
      // Earlier stage (S1) or returned prior to S2
      return []
    }

    if (!targetS2ExecutionId) {
      return []
    }

    const optionsResult = await this.pool.query<{
      id: string
      sourceStageExecutionId: string
      candidateId: string
      personnelNumber: string
      employeeData: Record<string, unknown>
      positionTitle: string
      organizationalDependency: string
      qualificationStatus: string
      qualificationStatusName: string | null
      displayOrder: number
    }>(
      `SELECT o.id, o.source_stage_execution_id AS "sourceStageExecutionId", o.candidate_id AS "candidateId",
              s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData",
              o.position_title AS "positionTitle", o.organizational_dependency AS "organizationalDependency",
              o.qualification_status AS "qualificationStatus", r.name AS "qualificationStatusName",
              o.display_order AS "displayOrder"
         FROM secondment_position_option o
         JOIN request_candidate c ON c.id = o.candidate_id
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
         LEFT JOIN qualification_status_reference r ON r.code = o.qualification_status
        WHERE o.source_stage_execution_id = $1 AND c.request_id = $2
        ORDER BY s.personnel_number, o.display_order, o.id`,
      [targetS2ExecutionId, request.id]
    )

    return optionsResult.rows.map(row => {
      const empData = row.employeeData ?? {}
      return {
        id: row.id,
        sourceStageExecutionId: row.sourceStageExecutionId,
        candidateId: row.candidateId,
        personnelNumber: row.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        positionTitle: row.positionTitle,
        organizationalDependency: row.organizationalDependency,
        qualificationStatusCode: row.qualificationStatus,
        qualificationStatusName: row.qualificationStatusName ?? null,
        displayOrder: Number(row.displayOrder)
      }
    })
  }

  /**
   * Validate S2 readiness for future Phase 6 atomic sign-and-advance.
   */
  async validateSecondmentS2ForSignoff(
    db: Queryable,
    requestId: string,
    iterationId: string,
    s2StageExecutionId: string
  ): Promise<SecondmentS2ValidationResult> {
    const requestResult = await db.query<{ requestType: string }>(
      `SELECT request_type AS "requestType" FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    if (requestResult.rows[0]?.requestType !== 'SECONDMENT') {
      throw new AppError(400, 'Secondment S2 validation requires SECONDMENT request', 'INVALID_REQUEST_TYPE')
    }

    const stageResult = await db.query<{ stageCode: string, status: string }>(
      `SELECT stage_code AS "stageCode", status FROM stage_execution WHERE id = $1`,
      [s2StageExecutionId]
    )
    const stage = stageResult.rows[0]
    if (!stage || stage.stageCode !== 'S2') {
      throw new AppError(409, 'Stage execution is not S2', 'STAGE_NOT_S2')
    }
    if (stage.status !== 'OPEN') {
      throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
    }

    const candidatesResult = await db.query<{
      id: string
      personnelNumber: string
      employeeData: Record<string, unknown>
      acceptedData: Record<string, unknown>
    }>(
      `SELECT c.id, s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData",
              c.accepted_data AS "acceptedData"
         FROM request_candidate c
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
        WHERE c.request_id = $1
        ORDER BY s.personnel_number`,
      [requestId]
    )
    if (candidatesResult.rows.length === 0) {
      throw new AppError(400, 'At least one candidate is required for secondment request', 'CANDIDATES_REQUIRED')
    }

    const optionsResult = await db.query<{
      id: string
      candidateId: string
      positionTitle: string
      organizationalDependency: string
      qualificationStatus: string
      displayOrder: number
    }>(
      `SELECT id, candidate_id AS "candidateId", position_title AS "positionTitle",
              organizational_dependency AS "organizationalDependency",
              qualification_status AS "qualificationStatus", display_order AS "displayOrder"
         FROM secondment_position_option
        WHERE source_stage_execution_id = $1
        ORDER BY display_order, id`,
      [s2StageExecutionId]
    )

    // Load active qualification references
    const activeRefsResult = await db.query<{ code: string, name: string }>(
      `SELECT code, name FROM qualification_status_reference WHERE is_active = TRUE`
    )
    const activeRefMap = new Map(activeRefsResult.rows.map(r => [r.code, r.name]))

    const activeCategoriesResult = await db.query<{ code: string, name: string }>(
      `SELECT code, name FROM job_category_reference WHERE is_active = TRUE`
    )
    const activeCategoryMap = new Map(activeCategoriesResult.rows.map(category => [category.code, category.name]))

    const optionsByCandidate = new Map<string, typeof optionsResult.rows>()
    for (const opt of optionsResult.rows) {
      const list = optionsByCandidate.get(opt.candidateId) ?? []
      list.push(opt)
      optionsByCandidate.set(opt.candidateId, list)
    }

    const groups: SecondmentS2CandidateOptionGroup[] = []

    for (const candidate of candidatesResult.rows) {
      const preparation = candidate.acceptedData?.secondmentS2Preparation
      const prep = preparation && typeof preparation === 'object'
        ? preparation as Record<string, unknown>
        : {}
      const lastPromotionReport = typeof prep.lastPromotionReport === 'string' ? prep.lastPromotionReport.trim() : ''
      if (!lastPromotionReport) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} requires lastPromotionReport`, 'SECONDMENT_LAST_PROMOTION_REPORT_REQUIRED')
      }
      const jobCategoryCode = typeof prep.jobCategoryCode === 'string' ? prep.jobCategoryCode.trim() : ''
      if (!jobCategoryCode) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} requires a job category`, 'SECONDMENT_JOB_CATEGORY_REQUIRED')
      }
      const jobCategoryName = activeCategoryMap.get(jobCategoryCode)
      if (!jobCategoryName) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} has an invalid or inactive job category: ${jobCategoryCode}`, 'INVALID_JOB_CATEGORY')
      }
      const candidateOpts = optionsByCandidate.get(candidate.id) ?? []
      if (candidateOpts.length === 0) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} requires at least one position option`, 'SECONDMENT_OPTIONS_REQUIRED')
      }

      const summaries: SecondmentPositionOptionSummary[] = []
      for (const opt of candidateOpts) {
        const title = (opt.positionTitle ?? '').trim()
        if (!title) {
          throw new AppError(400, `Candidate ${candidate.personnelNumber} option positionTitle is required`, 'POSITION_TITLE_REQUIRED')
        }
        const orgDep = (opt.organizationalDependency ?? '').trim()
        if (!orgDep) {
          throw new AppError(400, `Candidate ${candidate.personnelNumber} option organizationalDependency is required`, 'ORGANIZATIONAL_DEPENDENCY_REQUIRED')
        }
        const qualCode = (opt.qualificationStatus ?? '').trim()
        if (!qualCode || !activeRefMap.has(qualCode)) {
          throw new AppError(400, `Candidate ${candidate.personnelNumber} option has invalid or inactive qualificationStatus: ${qualCode}`, 'INVALID_QUALIFICATION_STATUS')
        }

        const empData = candidate.employeeData ?? {}
        summaries.push({
          id: opt.id,
          sourceStageExecutionId: s2StageExecutionId,
          candidateId: candidate.id,
          personnelNumber: candidate.personnelNumber,
          employeeName: String(empData.employeeName ?? ''),
          positionTitle: title,
          organizationalDependency: orgDep,
          qualificationStatusCode: qualCode,
          qualificationStatusName: activeRefMap.get(qualCode) ?? null,
          displayOrder: Number(opt.displayOrder)
        })
      }

      const empData = candidate.employeeData ?? {}
      groups.push({
        candidateId: candidate.id,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        lastPromotionReport,
        jobCategoryCode,
        jobCategoryName,
        options: summaries
      })
    }

    return {
      stageCode: 'S2',
      candidateOptions: groups
    }
  }

  /**
   * Upsert a candidate position selection at stage S3 (Approving Authority).
   * Stable row identity is preserved for (stage_execution_id, candidate_id).
   */
  async upsertSelection(
    stageExecutionIdValue: unknown,
    candidateIdValue: unknown,
    input: SecondmentSelectionInput,
    actor: WorkflowRequestContext
  ): Promise<SecondmentSelectionSummary> {
    const stageExecutionId = uuid(stageExecutionIdValue, 'stageExecutionId')
    const candidateId = uuid(candidateIdValue, 'candidateId')
    const selectedOptionId = uuid(input.selectedOptionId, 'selectedOptionId')

    return await withTransaction(this.pool, async db => {
      await requireOperationalUser(db, actor.userId)

      const { request, iteration, stageExecution } = await lockCurrentStageExecution(db, stageExecutionId)

      if (request.requestType !== 'SECONDMENT') {
        throw new AppError(400, 'Candidate selections are only valid for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
      }
      if (stageExecution.stageCode !== 'S3') {
        throw new AppError(409, `Candidate selections can only be made at stage S3, current is ${stageExecution.stageCode}`, 'STAGE_NOT_S3')
      }
      if (stageExecution.status !== 'OPEN') {
        throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
      }

      // Verify stage editor authorization
      const isMgr = await isCurrentUnitManager(db, actor.userId, stageExecution.responsibleUnitId)
      if (!isMgr) {
        const assignmentResult = await db.query<{ assignedToUserId: string }>(
          `SELECT assigned_to_user_id AS "assignedToUserId"
             FROM work_assignment
            WHERE stage_execution_id = $1 AND ended_at IS NULL`,
          [stageExecutionId]
        )
        const activeAssignment = assignmentResult.rows[0]
        if (!activeAssignment || activeAssignment.assignedToUserId !== actor.userId) {
          throw new AppError(403, 'Not authorized to make selections on this stage execution', 'NOT_AUTHORIZED_STAGE_EDITOR')
        }

        if (stageExecution.workState === 'MANAGER_REVIEW' || stageExecution.workState === 'COMPLETED') {
          throw new AppError(403, 'Employee cannot edit selections after submitting to manager for review', 'STAGE_NOT_EDITABLE')
        }
      }

      // Verify candidate belongs to this request
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

      // Resolve authoritative completed S2 execution for current iteration
      const s2ExecResult = await db.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'S2' AND status = 'COMPLETED'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [iteration.id]
      )
      const authoritativeS2 = s2ExecResult.rows[0]
      if (!authoritativeS2) {
        throw new AppError(409, 'Authoritative completed S2 execution not found in current iteration', 'AUTHORITATIVE_S2_NOT_FOUND')
      }

      // Verify selectedOptionId exists, belongs to same candidate, and originates from authoritative S2
      const optionResult = await db.query<{
        id: string
        candidateId: string
        sourceStageExecutionId: string
        positionTitle: string
        organizationalDependency: string
        qualificationStatus: string
        qualificationStatusName: string | null
      }>(
        `SELECT o.id, o.candidate_id AS "candidateId", o.source_stage_execution_id AS "sourceStageExecutionId",
                o.position_title AS "positionTitle", o.organizational_dependency AS "organizationalDependency",
                o.qualification_status AS "qualificationStatus", r.name AS "qualificationStatusName"
           FROM secondment_position_option o
           LEFT JOIN qualification_status_reference r ON r.code = o.qualification_status
          WHERE o.id = $1`,
        [selectedOptionId]
      )
      const option = optionResult.rows[0]
      if (!option) {
        throw new AppError(404, 'Selected position option not found', 'OPTION_NOT_FOUND')
      }
      if (option.candidateId !== candidateId) {
        throw new AppError(400, 'Selected position option does not belong to this candidate', 'INVALID_OPTION_SELECTION')
      }
      if (option.sourceStageExecutionId !== authoritativeS2.id) {
        throw new AppError(400, 'Selected position option does not come from the authoritative S2 execution', 'STALE_OPTION_SELECTION')
      }

      // Update work_state to IN_PROGRESS if currently ASSIGNED
      if (stageExecution.workState === 'ASSIGNED') {
        await db.query(
          `UPDATE stage_execution SET work_state = 'IN_PROGRESS' WHERE id = $1`,
          [stageExecutionId]
        )
      }

      // Stable row identity for (stage_execution_id, candidate_id)
      const existingResult = await db.query<{ id: string }>(
        `SELECT id FROM secondment_decision WHERE stage_execution_id = $1 AND candidate_id = $2`,
        [stageExecutionId, candidateId]
      )

      let decisionId: string
      if (existingResult.rows[0]) {
        decisionId = existingResult.rows[0].id
        await db.query(
          `UPDATE secondment_decision
              SET selected_option_id = $2
            WHERE id = $1`,
          [decisionId, selectedOptionId]
        )
      } else {
        decisionId = randomUUID()
        await db.query(
          `INSERT INTO secondment_decision
            (id, stage_execution_id, candidate_id, selected_option_id)
           VALUES ($1, $2, $3, $4)`,
          [decisionId, stageExecutionId, candidateId, selectedOptionId]
        )
      }

      await insertStageAction(db, stageExecutionId, actor.userId, stageExecution.responsibleUnitId, 'SECONDMENT_SELECTION_SAVED', null, {
        decisionId,
        candidateId,
        personnelNumber: candidate.personnelNumber,
        selectedOptionId,
        positionTitle: option.positionTitle,
        organizationalDependency: option.organizationalDependency,
        qualificationStatus: option.qualificationStatus,
        sourceS2StageExecutionId: authoritativeS2.id
      })

      await recordAuditEvent(db, {
        actorUserId: actor.userId,
        eventType: 'SECONDMENT_SELECTION_SAVED',
        subjectType: 'secondment_decision',
        subjectId: decisionId,
        details: {
          requestId: request.id,
          stageExecutionId,
          candidateId,
          personnelNumber: candidate.personnelNumber,
          selectedOptionId,
          positionTitle: option.positionTitle,
          organizationalDependency: option.organizationalDependency,
          qualificationStatus: option.qualificationStatus,
          sourceS2StageExecutionId: authoritativeS2.id
        }
      })

      const empData = candidate.employeeData ?? {}
      return {
        id: decisionId,
        stageExecutionId,
        candidateId,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        selectedOptionId,
        positionTitle: option.positionTitle,
        organizationalDependency: option.organizationalDependency,
        qualificationStatusCode: option.qualificationStatus,
        qualificationStatusName: option.qualificationStatusName ?? null,
        sourceS2StageExecutionId: authoritativeS2.id
      }
    })
  }

  /**
   * Get authoritative selections for a Secondment request.
   */
  async getAuthoritativeSelections(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<SecondmentSelectionSummary[]> {
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
    if (request.requestType !== 'SECONDMENT') {
      throw new AppError(400, 'Selections are only available for SECONDMENT requests', 'INVALID_REQUEST_TYPE')
    }

    if (!request.currentIterationId) {
      return []
    }

    let targetS3ExecutionId: string | null = null

    if (request.currentStageCode === 'S3') {
      // At S3: use current OPEN S3 execution in current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'S3' AND status = 'OPEN'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetS3ExecutionId = execResult.rows[0]?.id ?? null
    } else if (
      request.currentStageCode === 'S4' ||
      request.currentStageCode === 'S5' ||
      (request.status === 'COMPLETED' && request.currentStageCode === null)
    ) {
      // At S4, S5 (or completed): use latest COMPLETED S3 execution in current iteration
      const execResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM stage_execution
          WHERE iteration_id = $1 AND stage_code = 'S3' AND status = 'COMPLETED'
          ORDER BY execution_no DESC
          LIMIT 1`,
        [request.currentIterationId]
      )
      targetS3ExecutionId = execResult.rows[0]?.id ?? null
    } else {
      // Earlier stage (S1, S2) or returned prior to S3
      return []
    }

    if (!targetS3ExecutionId) {
      return []
    }

    const selectionsResult = await this.pool.query<{
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
    }>(
      `SELECT d.id, d.stage_execution_id AS "stageExecutionId", d.candidate_id AS "candidateId",
              s.personnel_number AS "personnelNumber", s.employee_data AS "employeeData",
              d.selected_option_id AS "selectedOptionId", o.position_title AS "positionTitle",
              o.organizational_dependency AS "organizationalDependency",
              o.qualification_status AS "qualificationStatus", r.name AS "qualificationStatusName",
              o.source_stage_execution_id AS "sourceS2StageExecutionId"
         FROM secondment_decision d
         JOIN request_candidate c ON c.id = d.candidate_id
         JOIN employee_annual_snapshot s ON s.id = c.employee_snapshot_id
         JOIN secondment_position_option o ON o.id = d.selected_option_id
         LEFT JOIN qualification_status_reference r ON r.code = o.qualification_status
        WHERE d.stage_execution_id = $1 AND c.request_id = $2
        ORDER BY s.personnel_number`,
      [targetS3ExecutionId, request.id]
    )

    return selectionsResult.rows.map(row => {
      const empData = row.employeeData ?? {}
      return {
        id: row.id,
        stageExecutionId: row.stageExecutionId,
        candidateId: row.candidateId,
        personnelNumber: row.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        selectedOptionId: row.selectedOptionId,
        positionTitle: row.positionTitle,
        organizationalDependency: row.organizationalDependency,
        qualificationStatusCode: row.qualificationStatus,
        qualificationStatusName: row.qualificationStatusName ?? null,
        sourceS2StageExecutionId: row.sourceS2StageExecutionId
      }
    })
  }

  /**
   * Validate S3 readiness for future Phase 6 atomic sign-and-advance.
   */
  async validateSecondmentS3ForSignoff(
    db: Queryable,
    requestId: string,
    iterationId: string,
    s3StageExecutionId: string
  ): Promise<SecondmentS3ValidationResult> {
    const requestResult = await db.query<{ requestType: string }>(
      `SELECT request_type AS "requestType" FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    if (requestResult.rows[0]?.requestType !== 'SECONDMENT') {
      throw new AppError(400, 'Secondment S3 validation requires SECONDMENT request', 'INVALID_REQUEST_TYPE')
    }

    const stageResult = await db.query<{ stageCode: string, status: string }>(
      `SELECT stage_code AS "stageCode", status FROM stage_execution WHERE id = $1`,
      [s3StageExecutionId]
    )
    const stage = stageResult.rows[0]
    if (!stage || stage.stageCode !== 'S3') {
      throw new AppError(409, 'Stage execution is not S3', 'STAGE_NOT_S3')
    }
    if (stage.status !== 'OPEN') {
      throw new AppError(409, 'Stage execution is not OPEN', 'STAGE_NOT_OPEN')
    }

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
      throw new AppError(400, 'At least one candidate is required for secondment request', 'CANDIDATES_REQUIRED')
    }

    // Resolve authoritative completed S2 execution for current iteration
    const s2ExecResult = await db.query<{ id: string }>(
      `SELECT id FROM stage_execution
        WHERE iteration_id = $1 AND stage_code = 'S2' AND status = 'COMPLETED'
        ORDER BY execution_no DESC
        LIMIT 1`,
      [iterationId]
    )
    const authoritativeS2 = s2ExecResult.rows[0]
    if (!authoritativeS2) {
      throw new AppError(409, 'Authoritative completed S2 execution not found in current iteration', 'AUTHORITATIVE_S2_NOT_FOUND')
    }

    const decisionsResult = await db.query<{
      id: string
      stageExecutionId: string
      candidateId: string
      selectedOptionId: string
      positionTitle: string
      organizationalDependency: string
      qualificationStatus: string
      qualificationStatusName: string | null
      sourceS2StageExecutionId: string
      optionCandidateId: string
    }>(
      `SELECT d.id, d.stage_execution_id AS "stageExecutionId", d.candidate_id AS "candidateId",
              d.selected_option_id AS "selectedOptionId", o.position_title AS "positionTitle",
              o.organizational_dependency AS "organizationalDependency",
              o.qualification_status AS "qualificationStatus", r.name AS "qualificationStatusName",
              o.source_stage_execution_id AS "sourceS2StageExecutionId",
              o.candidate_id AS "optionCandidateId"
         FROM secondment_decision d
         JOIN secondment_position_option o ON o.id = d.selected_option_id
         LEFT JOIN qualification_status_reference r ON r.code = o.qualification_status
        WHERE d.stage_execution_id = $1`,
      [s3StageExecutionId]
    )

    const decisionMap = new Map(decisionsResult.rows.map(d => [d.candidateId, d]))
    const summaries: SecondmentSelectionSummary[] = []

    for (const candidate of candidatesResult.rows) {
      const decision = decisionMap.get(candidate.id)
      if (!decision) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} lacks a secondment selection`, 'SECONDMENT_SELECTION_MISSING')
      }

      if (decision.optionCandidateId !== candidate.id) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} selection does not belong to this candidate`, 'INVALID_OPTION_SELECTION')
      }
      if (decision.sourceS2StageExecutionId !== authoritativeS2.id) {
        throw new AppError(400, `Candidate ${candidate.personnelNumber} selection does not come from authoritative S2 execution`, 'STALE_OPTION_SELECTION')
      }

      const empData = candidate.employeeData ?? {}
      summaries.push({
        id: decision.id,
        stageExecutionId: s3StageExecutionId,
        candidateId: candidate.id,
        personnelNumber: candidate.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        selectedOptionId: decision.selectedOptionId,
        positionTitle: decision.positionTitle,
        organizationalDependency: decision.organizationalDependency,
        qualificationStatusCode: decision.qualificationStatus,
        qualificationStatusName: decision.qualificationStatusName ?? null,
        sourceS2StageExecutionId: authoritativeS2.id
      })
    }

    return {
      nextStageCode: 'S4',
      selections: summaries
    }
  }
}
