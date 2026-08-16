import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import type { AuthContext } from '../auth/types.ts'
import { EmployeeDataService } from '../employee/employee-data-service.ts'
import { initialStage, responsibleRole, type CandidateRow, type RequestRow, type WorkflowType } from './types.ts'
import type { CreateRequestInput } from './validation.ts'
import { WorkflowRepository } from './workflow-repository.ts'
import { captureReceivedSnapshot } from './form-snapshot.ts'

function iso(value: Date | string): string { return new Date(value).toISOString() }

function requestView(row: RequestRow, actor?: AuthContext, taskActionable = false): Record<string, unknown> {
  const editable = actor?.activeRole === 'EMPLOYEE_AFFAIRS' && actor.userId === row.createdById
    && row.status === 'DRAFT' && (row.currentStage === 'P1' || row.currentStage === 'S1')
  return {
    id: row.id, requestNumber: row.requestNumber, requestType: row.requestType,
    cycleYear: Number(row.cycleYear), formMonth: Number(row.formMonth), formYear: Number(row.formYear),
    status: row.status, currentStage: row.currentStage, currentIterationNo: Number(row.currentIterationNo),
    routingUnit: row.routingUnitId ? { id: row.routingUnitId, nameAr: row.routingUnitName } : null,
    approvingAuthority: row.authorityAssignmentId ? {
      assignmentId: row.authorityAssignmentId, personnelNumber: row.authorityPersonnel,
      displayName: row.authorityName, jobTitle: row.authorityJobTitle, kind: row.authorityKind
    } : null,
    createdBy: { id: row.createdById, username: row.creatorUsername, displayName: row.creatorDisplayName },
    candidateCount: Number(row.candidateCount), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    version: Number(row.version), editable, actionable: editable || taskActionable
  }
}

function candidateView(row: CandidateRow): Record<string, unknown> {
  return {
    id: row.id, snapshotYear: Number(row.snapshotYear), personnelNumber: row.personnelNumber,
    employeeName: row.employeeName, subgroup: row.subgroup, sourceRoutingUnit: row.sourceRoutingUnit,
    routingUnitName: row.routingUnitName, currentJobTitle: row.currentJobTitle,
    performanceRating: row.performanceRating, qualificationSource1: row.qualificationSource1,
    qualificationSource2: row.qualificationSource2, qualificationDate: row.qualificationDate,
    formSection: row.formSectionId ? { id: row.formSectionId, jobCategoryCode: row.jobCategoryCode, nameAr: row.jobCategoryName } : null,
    lastPromotionReport: row.lastPromotionReport,
    displayOrder: Number(row.displayOrder), createdAt: iso(row.createdAt),
    warnings: { performanceRequiresAttention: row.performanceRating === 'جيد', performanceMissing: row.performanceRating === null }
  }
}

function activeActor(actor: AuthContext): asserts actor is AuthContext & { activeRole: NonNullable<AuthContext['activeRole']> } {
  if (!actor.activeRole) throw new AppError(403, 'An active role is required', 'ACTIVE_ROLE_REQUIRED')
}

function ownDraft(row: RequestRow, actor: AuthContext): void {
  if (actor.activeRole !== 'EMPLOYEE_AFFAIRS' || row.createdById !== actor.userId) {
    throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
  }
  if (row.status !== 'DRAFT' || !['P1','S1'].includes(row.currentStage)) {
    throw new AppError(409, 'The request is no longer editable', 'WORKFLOW_REQUEST_NOT_EDITABLE')
  }
}

export class WorkflowService {
  constructor(private readonly pool: Pool) {}

  private async requireAccess(
  repo: WorkflowRepository,
  row: RequestRow,
  actor: AuthContext
): Promise<boolean> {
  const task = await repo.currentTask(row)

  if (
    actor.activeRole === responsibleRole(row.currentStage) &&
    task?.assignedUserId === actor.userId &&
    ['OPEN', 'CLAIMED'].includes(task.taskStatus)
  ) {
    return true
  }

  if (
    actor.activeRole === 'EMPLOYEE_AFFAIRS' &&
    row.createdById === actor.userId
  ) {
    return false
  }

  if (
    (actor.activeRole === 'ORGANIZATION' ||
      actor.activeRole === 'APPROVING_AUTHORITY') &&
    await repo.hasParticipated(row.id, actor.userId)
  ) {
    return false
  }

  throw new AppError(
    404,
    'Workflow request not found',
    'WORKFLOW_REQUEST_NOT_FOUND'
  )
}

  

  private async detailFrom(repo: WorkflowRepository, requestId: string, actor: AuthContext): Promise<Record<string, unknown>> {
    const row = await repo.request(requestId)
    if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    const taskActionable = await this.requireAccess(repo, row, actor)
    return { ...requestView(row, actor, taskActionable), candidates: (await repo.candidates(requestId)).map(candidateView) }
  }

  async create(input: CreateRequestInput, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    activeActor(actor)
    const requestId = randomUUID(); const iterationId = randomUUID(); const taskId = randomUUID()
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db)
      if (!await repo.migrationReady()) throw new AppError(409, 'Phase 3A database migration is required', 'WORKFLOW_MIGRATION_REQUIRED')
      const stage = initialStage(input.requestType)
      await repo.insertRequest(requestId, input.requestType, input.cycleYear, input.formMonth, input.formYear, actor.userId, stage)
      await repo.insertIteration(iterationId, requestId, actor.userId)
      await repo.insertTask(taskId, requestId, iterationId, stage, actor.userId)
      await repo.insertAction(actor, requestId, iterationId, taskId, null, 'REQUEST_CREATED')
      await repo.insertAction(actor, requestId, iterationId, taskId, null, 'STAGE_TASK_CREATED', { stage })
      await recordWorkflowAudit(db, actor, evidence, { requestId, iterationId, actionCode: 'REQUEST_CREATED', toStage: stage })
      await captureReceivedSnapshot(db, { taskId, requestId, iterationId, stageCode: stage,
        recipientUserId: actor.userId, recipientRole: 'EMPLOYEE_AFFAIRS' })
    })
    return await this.detail(requestId, actor)
  }

  async list(actor: AuthContext, skip: number, top: number, type: WorkflowType | null, status: string | null, year: number | null): Promise<Record<string, unknown>[]> {
    return (await new WorkflowRepository(this.pool).listRequests(actor.userId, skip, top, type, status, year))
      .map(row => requestView(row, actor))
  }

  async detail(requestValue: unknown, actor: AuthContext): Promise<Record<string, unknown>> {
    return await this.detailFrom(new WorkflowRepository(this.pool), uuid(requestValue, 'requestId'), actor)
  }

  async addCandidate(requestValue: unknown, personnelValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    activeActor(actor); const requestId = uuid(requestValue, 'requestId')
    let candidateId = ''
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await repo.request(requestId, true)
      if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      ownDraft(row, actor)
      const employee = await new EmployeeDataService(db).employeeForWorkflow(personnelValue)
      if (row.routingUnitId && row.routingUnitId !== employee.routingUnitId) {
        throw new AppError(409, 'All candidates in a request must belong to the same routing unit', 'WORKFLOW_ROUTING_MISMATCH')
      }
      if (!row.routingUnitId) {
        await repo.establishRouting(requestId, employee.routingUnitId)
        const established = await repo.request(requestId)
        if (established?.routingUnitId !== employee.routingUnitId) {
          throw new AppError(409, 'Another candidate established a different routing unit', 'WORKFLOW_ROUTING_MISMATCH')
        }
      }
      try { candidateId = await repo.insertCandidate(requestId, employee) } catch (error) {
        if (isUniqueViolation(error)) throw new AppError(409, 'Employee is already an active candidate', 'WORKFLOW_CANDIDATE_DUPLICATE')
        throw error
      }
      const task = await repo.currentTask(row)
      await repo.insertAction(actor, requestId, task!.iterationId, task!.id, candidateId, 'CANDIDATE_ADDED', { personnelNumber: employee.personnelNumber })
      await recordWorkflowAudit(db, actor, evidence, { requestId, iterationId: task!.iterationId, candidateId,
        routingUnitId: employee.routingUnitId, actionCode: 'CANDIDATE_ADDED', metadata: { personnelNumber: employee.personnelNumber } })
    })
    return await this.detail(requestId, actor)
  }

  async removeCandidate(requestValue: unknown, candidateValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<void> {
    activeActor(actor); const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId')
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await repo.request(requestId, true)
      if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      ownDraft(row, actor)
      const candidate = await repo.candidate(requestId, candidateId)
      if (!candidate) throw new AppError(404, 'Candidate not found', 'WORKFLOW_CANDIDATE_NOT_FOUND')
      await repo.removeCandidate(candidateId, actor.userId)
      if ((await repo.candidates(requestId)).length === 0) await repo.clearDraftRouting(requestId)
      const task = await repo.currentTask(row)
      await repo.insertAction(actor, requestId, task!.iterationId, task!.id, candidateId, 'CANDIDATE_REMOVED', { personnelNumber: candidate.personnelNumber })
      await recordWorkflowAudit(db, actor, evidence, { requestId, iterationId: task!.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'CANDIDATE_REMOVED', metadata: { personnelNumber: candidate.personnelNumber } })
    })
  }

  async authorityOptions(requestValue: unknown, actor: AuthContext): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const repo = new WorkflowRepository(this.pool); const row = await repo.request(requestId)
    if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    ownDraft(row, actor)
    if (!row.routingUnitId) throw new AppError(409, 'Add a candidate before selecting an authority', 'WORKFLOW_ROUTING_REQUIRED')
    return (await repo.authorityOptions(row.routingUnitId)).map(option => ({
      id: option.id, displayName: option.displayName, staffIdentifier: option.staffIdentifier,
      authorityKind: option.authorityKind, authorityJobTitle: option.authorityJobTitle, preferred: option.isPrimary
    }))
  }

  async selectAuthority(requestValue: unknown, assignmentValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    activeActor(actor); const requestId = uuid(requestValue, 'requestId'); const assignmentId = uuid(assignmentValue, 'authorityAssignmentId')
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await repo.request(requestId, true)
      if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      ownDraft(row, actor)
      if (!row.routingUnitId) throw new AppError(409, 'Add a candidate before selecting an authority', 'WORKFLOW_ROUTING_REQUIRED')
      const option = (await repo.authorityOptions(row.routingUnitId)).find(item => item.id === assignmentId)
      if (!option) throw new AppError(404, 'Active authority assignment not found for this routing unit', 'WORKFLOW_AUTHORITY_NOT_FOUND')
      await repo.selectAuthority(requestId, option)
      const task = await repo.currentTask(row)
      await repo.insertAction(actor, requestId, task!.iterationId, task!.id, null, 'AUTHORITY_SELECTED', { authorityAssignmentId: option.id })
      await recordWorkflowAudit(db, actor, evidence, { requestId, iterationId: task!.iterationId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: option.id, actionCode: 'AUTHORITY_SELECTED' })
    })
    return await this.detail(requestId, actor)
  }

  async notes(requestValue: unknown, actor: AuthContext, top: number): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const repo = new WorkflowRepository(this.pool); const row = await repo.request(requestId)
    if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    await this.requireAccess(repo, row, actor); return await repo.notes(requestId, top)
  }

  async addNote(requestValue: unknown, candidateValue: unknown, message: string, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>[]> {
    activeActor(actor); const requestId = uuid(requestValue, 'requestId')
    const candidateId = candidateValue === undefined || candidateValue === null ? null : uuid(candidateValue, 'candidateId')
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await repo.request(requestId, true)
      if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      await this.requireAccess(repo, row, actor)
      const task = await repo.currentTask(row)
      if (!task) throw new AppError(409, 'No current workflow task exists', 'WORKFLOW_TASK_UNAVAILABLE')
      if (candidateId && !await repo.candidate(requestId, candidateId)) throw new AppError(404, 'Candidate not found', 'WORKFLOW_CANDIDATE_NOT_FOUND')
      await repo.insertNote(requestId, task.iterationId, task.id, candidateId, actor, message)
      await recordWorkflowAudit(db, actor, evidence, { requestId, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'WORKFLOW_NOTE_ADDED', metadata: { scope: candidateId ? 'CANDIDATE' : 'REQUEST' } })
    })
    return await this.notes(requestId, actor, 100)
  }

  async timeline(requestValue: unknown, actor: AuthContext, top: number): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const repo = new WorkflowRepository(this.pool); const row = await repo.request(requestId)
    if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    await this.requireAccess(repo, row, actor); return await repo.timeline(requestId, top)
  }
}
