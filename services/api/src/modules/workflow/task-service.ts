import type { Pool } from 'pg'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import type { AuthContext } from '../auth/types.ts'
import { isOrganizationStage } from './types.ts'
import { WorkflowRepository } from './workflow-repository.ts'

export class TaskService {
  constructor(private readonly pool: Pool) {}

  async organizationQueue(actor: AuthContext, skip: number, top: number): Promise<Record<string, unknown>[]> {
    return await new WorkflowRepository(this.pool).organizationQueue(actor.userId, skip, top)
  }

  async claim(taskValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    if (actor.activeRole !== 'ORGANIZATION') throw new AppError(403, 'Active ORGANIZATION role required', 'ACTIVE_ROLE_REQUIRED')
    const taskId = uuid(taskValue, 'taskId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const claimed = await repo.claimOrganizationTask(taskId, actor.userId)
      if (!claimed) {
        const existing = await repo.task(taskId)
        if (!existing || !isOrganizationStage(existing.stageCode)) throw new AppError(404, 'Organization task not found', 'WORKFLOW_TASK_NOT_FOUND')
        throw new AppError(409, 'Organization task has already been claimed', 'WORKFLOW_TASK_ALREADY_CLAIMED')
      }
      const request = await repo.request(claimed.requestId)
      await repo.insertAction(actor, claimed.requestId, claimed.iterationId, claimed.id, null, 'TASK_CLAIMED')
      await recordWorkflowAudit(db, actor, evidence, { requestId: claimed.requestId, iterationId: claimed.iterationId,
        routingUnitId: request?.routingUnitId ?? null, authorityAssignmentId: request?.authorityAssignmentId ?? null,
        actionCode: 'TASK_CLAIMED', fromStage: claimed.stageCode, toStage: claimed.stageCode })
      return { taskId: claimed.id, requestId: claimed.requestId, stageCode: claimed.stageCode,
        taskStatus: claimed.taskStatus, assignedUserId: claimed.assignedUserId,
        claimedAt: claimed.claimedAt ? new Date(claimed.claimedAt).toISOString() : null }
    })
  }
}
