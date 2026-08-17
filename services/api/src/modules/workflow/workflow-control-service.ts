import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { optionalText, text, uuid } from '../../shared/validation.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import type { AuthContext } from '../auth/types.ts'
import { createNotification } from '../notifications/notification-service.ts'
import { initialStage, responsibleRole, type RequestRow, type WorkflowStage } from './types.ts'
import { WorkflowRepository } from './workflow-repository.ts'
import { captureReceivedSnapshot } from './form-snapshot.ts'

const returnableStages = new Set<WorkflowStage>(['P2','P3','P4','P4O','S2','S3','S4'])
const rejectableStages = new Set<WorkflowStage>(['P2','P3','P4','S2','S3','S4'])

export class WorkflowControlService {
  constructor(private readonly pool: Pool) {}

  private async request(repo: WorkflowRepository, value: unknown, lock = false): Promise<RequestRow> {
    const row = await repo.request(uuid(value, 'requestId'), lock)
    if (!row) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    return row
  }

  async returnOrReject(requestValue: unknown, action: 'RETURN'|'REJECT', reasonValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const reason = text(reasonValue, 'reason', 2000)
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      const allowedStages = action === 'RETURN' ? returnableStages : rejectableStages
      if (row.status !== 'IN_PROGRESS' || !allowedStages.has(row.currentStage)
        || actor.activeRole !== responsibleRole(row.currentStage)) {
        throw new AppError(409, 'This stage does not permit this action', 'WORKFLOW_ACTION_NOT_ALLOWED')
      }
      const task = await repo.currentTask(row)
      if (!task || task.assignedUserId !== actor.userId || !['OPEN','CLAIMED'].includes(task.taskStatus)) {
        throw new AppError(404, 'Actionable workflow task not found', 'WORKFLOW_TASK_NOT_FOUND')
      }
      const completed = await db.query(
        `UPDATE egas_stagetask SET taskstatus='RETURNED',completedat=CURRENT_TIMESTAMP,version=version+1
          WHERE id=$1 AND assigneduser_id=$2 AND taskstatus IN ('OPEN','CLAIMED') RETURNING id`, [task.id, actor.userId])
      if (!completed.rows[0]) throw new AppError(409, 'Workflow task changed concurrently', 'WORKFLOW_TASK_CONFLICT')
      await db.query(
        `UPDATE egas_workflowiteration SET status='RETURNED',endedat=CURRENT_TIMESTAMP,restartreason=$2
          WHERE id=$1 AND status='ACTIVE'`, [task.iterationId, reason])
      const start = initialStage(row.requestType)
      await db.query(
        `UPDATE egas_workflowrequest SET status='RETURNED',currentstage=$2,updatedat=CURRENT_TIMESTAMP,version=version+1
          WHERE id=$1`, [row.id, start])
      const code = action === 'RETURN' ? 'WORKFLOW_RETURNED_FOR_CORRECTION' : 'WORKFLOW_REJECTED'
      await repo.insertAction(actor, row.id, task.iterationId, task.id, null, code, { fromStage: row.currentStage }, reason)
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: code, fromStage: row.currentStage, toStage: start, reason })
      await createNotification(db, { recipientUserId: row.createdById, requestId: row.id,
        type: action === 'RETURN' ? 'WORKFLOW_RETURNED' : 'WORKFLOW_REJECTED',
        titleAr: action === 'RETURN' ? 'طلب مرتجع للتصحيح' : 'طلب مرفوض', bodyAr: reason })
      return { requestId: row.id, status: 'RETURNED', currentStage: start, returnKind: action, reason }
    })
  }

  async restart(requestValue: unknown, reasonValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const reason = optionalText(reasonValue, 'reason', 2000)
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      if (actor.activeRole !== 'EMPLOYEE_AFFAIRS' || actor.userId !== row.createdById) {
        throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      }
      if (row.status !== 'RETURNED') throw new AppError(409, 'Only a returned request can be restarted', 'WORKFLOW_ACTION_NOT_ALLOWED')
      const parent = await db.query<{ id: string }>(
        `SELECT id FROM egas_workflowiteration WHERE request_id=$1 AND iterationno=$2 AND status='RETURNED' FOR UPDATE`,
        [row.id, Number(row.currentIterationNo)])
      if (!parent.rows[0]) throw new AppError(409, 'Returned iteration is unavailable', 'WORKFLOW_ITERATION_CONFLICT')
      const iterationId = randomUUID(); const taskId = randomUUID(); const nextNo = Number(row.currentIterationNo) + 1
      await db.query(
        `INSERT INTO egas_workflowiteration
          (id,request_id,iterationno,status,startedby_id,startedat,restartreason,parentiteration_id)
         VALUES ($1,$2,$3,'ACTIVE',$4,CURRENT_TIMESTAMP,$5,$6)`,
        [iterationId, row.id, nextNo, actor.userId, reason, parent.rows[0].id])
      const start = initialStage(row.requestType)
      await repo.insertTask(taskId, row.id, iterationId, start, actor.userId)
      const changed = await db.query(
        `UPDATE egas_workflowrequest SET status='DRAFT',currentstage=$2,currentiterationno=$3,
                updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND status='RETURNED' RETURNING id`,
        [row.id, start, nextNo])
      if (!changed.rows[0]) throw new AppError(409, 'Workflow request changed concurrently', 'WORKFLOW_ITERATION_CONFLICT')
      await repo.insertAction(actor, row.id, iterationId, taskId, null, 'WORKFLOW_RESTARTED', { iterationNo: nextNo }, reason)
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'WORKFLOW_RESTARTED', fromStage: start, toStage: start, reason, metadata: { iterationNo: nextNo } })
      await captureReceivedSnapshot(db, { taskId, requestId: row.id, iterationId, stageCode: start,
        recipientUserId: actor.userId, recipientRole: 'EMPLOYEE_AFFAIRS' })
      return { requestId: row.id, status: 'DRAFT', currentStage: start, currentIterationNo: nextNo }
    })
  }

  async cancelReturned(requestValue: unknown, reasonValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const reason = optionalText(reasonValue, 'reason', 2000)
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      if (actor.activeRole !== 'EMPLOYEE_AFFAIRS' || actor.userId !== row.createdById) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      if (row.status !== 'RETURNED') throw new AppError(409, 'Only a returned request can be cancelled', 'WORKFLOW_ACTION_NOT_ALLOWED')
      const iteration = await db.query<{ id: string }>(
        `UPDATE egas_workflowiteration SET status='CANCELLED',endedat=COALESCE(endedat,CURRENT_TIMESTAMP)
          WHERE request_id=$1 AND iterationno=$2 AND status='RETURNED' RETURNING id`, [row.id, Number(row.currentIterationNo)])
      if (!iteration.rows[0]) throw new AppError(409, 'Returned iteration is unavailable', 'WORKFLOW_ITERATION_CONFLICT')
      await db.query(
        `UPDATE egas_workflowrequest SET status='CANCELLED',cancelledat=CURRENT_TIMESTAMP,
                updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`, [row.id])
      await repo.insertAction(actor, row.id, iteration.rows[0].id, null, null, 'WORKFLOW_CANCELLED', {}, reason)
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: iteration.rows[0].id,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'WORKFLOW_CANCELLED', fromStage: row.currentStage, toStage: row.currentStage, reason })
      return { requestId: row.id, status: 'CANCELLED', currentStage: row.currentStage }
    })
  }

  async recall(requestValue: unknown, reasonValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const reason = text(reasonValue, 'reason', 2000)
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      if (actor.activeRole !== 'EMPLOYEE_AFFAIRS' || actor.userId !== row.createdById) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
      if (!['DRAFT','IN_PROGRESS'].includes(row.status)) throw new AppError(409, 'Only a non-final active request can be recalled', 'WORKFLOW_ACTION_NOT_ALLOWED')
      const previous = await db.query<{ id: string }>(
        `UPDATE egas_workflowiteration SET status='RECALLED',endedat=CURRENT_TIMESTAMP,restartreason=$3
          WHERE request_id=$1 AND iterationno=$2 AND status='ACTIVE' RETURNING id`,
        [row.id, Number(row.currentIterationNo), reason])
      if (!previous.rows[0]) throw new AppError(409, 'Active iteration is unavailable', 'WORKFLOW_ITERATION_CONFLICT')
      await db.query(
        `UPDATE egas_stagetask SET taskstatus='CANCELLED',completedat=CURRENT_TIMESTAMP,version=version+1
          WHERE iteration_id=$1 AND taskstatus IN ('OPEN','CLAIMED')`, [previous.rows[0].id])
      const iterationId = randomUUID(); const taskId = randomUUID(); const nextNo = Number(row.currentIterationNo) + 1
      await db.query(
        `INSERT INTO egas_workflowiteration
          (id,request_id,iterationno,status,startedby_id,startedat,restartreason,parentiteration_id)
         VALUES ($1,$2,$3,'ACTIVE',$4,CURRENT_TIMESTAMP,$5,$6)`,
        [iterationId, row.id, nextNo, actor.userId, reason, previous.rows[0].id])
      const start = initialStage(row.requestType)
      await repo.insertTask(taskId, row.id, iterationId, start, actor.userId)
      await db.query(
        `UPDATE egas_workflowrequest SET status='DRAFT',currentstage=$2,currentiterationno=$3,
                updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`, [row.id, start, nextNo])
      await repo.insertAction(actor, row.id, previous.rows[0].id, null, null, 'WORKFLOW_RECALLED', { fromStage: row.currentStage }, reason)
      await repo.insertAction(actor, row.id, iterationId, taskId, null, 'RECALL_ITERATION_STARTED', { iterationNo: nextNo }, reason)
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: previous.rows[0].id,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'WORKFLOW_RECALLED', fromStage: row.currentStage, toStage: start, reason, metadata: { newIterationNo: nextNo } })
      await captureReceivedSnapshot(db, { taskId, requestId: row.id, iterationId, stageCode: start,
        recipientUserId: actor.userId, recipientRole: 'EMPLOYEE_AFFAIRS' })
      return { requestId: row.id, status: 'DRAFT', currentStage: start, currentIterationNo: nextNo }
    })
  }
}
