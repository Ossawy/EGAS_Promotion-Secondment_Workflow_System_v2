import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { optionalText, text, uuid } from '../../shared/validation.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import type { AuthContext } from '../auth/types.ts'
import { createNotification } from '../notifications/notification-service.ts'
import { resolveAuthorityRecipient } from './authority-routing.ts'
import { responsibleRole, type RequestRow, type WorkflowStage } from './types.ts'
import { WorkflowRepository, type TaskRow } from './workflow-repository.ts'
import { captureReceivedSnapshot, freezeFinalSnapshot } from './form-snapshot.ts'

type DecisionRow = {
  id: string
  candidateId: string
  iterationId: string
  decisionType: 'SAME_POSITION'|'OTHER_POSITION'
  targetJobTitle: string | null
  notes: string | null
  decidedById: string
  decidedByName: string
  decidedAt: Date | string
}

function decisionView(row: DecisionRow): Record<string, unknown> {
  return { ...row, decidedAt: new Date(row.decidedAt).toISOString() }
}

export class PromotionService {
  constructor(private readonly pool: Pool) {}

  private async migrationReady(db: Queryable): Promise<void> {
    const result = await db.query(`SELECT 1 FROM egas_schemamigration WHERE version='005_promotion_workflow_integrity'`)
    if (!result.rows[0]) throw new AppError(409, 'Promotion workflow migration is required', 'WORKFLOW_MIGRATION_REQUIRED')
  }

  private async request(repo: WorkflowRepository, value: unknown, lock = false): Promise<RequestRow> {
    const row = await repo.request(uuid(value, 'requestId'), lock)
    if (!row || row.requestType !== 'PROMOTION') throw new AppError(404, 'Promotion request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    return row
  }

  private assertActor(row: RequestRow, actor: AuthContext, stage: WorkflowStage): void {
    const role = stage === 'P2' ? 'ORGANIZATION' : stage === 'P4' ? 'APPROVING_AUTHORITY' : 'EMPLOYEE_AFFAIRS'
    if (actor.activeRole !== role || ((stage === 'P1' || stage === 'P3' || stage === 'P5') && row.createdById !== actor.userId)) {
      throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    }
  }

  private async task(repo: WorkflowRepository, row: RequestRow, actor: AuthContext, stage: WorkflowStage): Promise<TaskRow> {
    if (row.currentStage !== stage) throw new AppError(409, `Request is not at ${stage}`, 'WORKFLOW_STAGE_CONFLICT')
    const task = await repo.currentTask(row)
    if (!task || task.assignedUserId !== actor.userId || !['OPEN','CLAIMED'].includes(task.taskStatus)) {
      throw new AppError(404, 'Actionable workflow task not found', 'WORKFLOW_TASK_NOT_FOUND')
    }
    return task
  }

  private async canRead(repo: WorkflowRepository, row: RequestRow, actor: AuthContext): Promise<void> {
    if (actor.activeRole === 'EMPLOYEE_AFFAIRS' && row.createdById === actor.userId) return
    if ((actor.activeRole === 'ORGANIZATION' || actor.activeRole === 'APPROVING_AUTHORITY') && await repo.hasParticipated(row.id, actor.userId)) return
    throw new AppError(404, 'Promotion request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
  }

  async decisions(requestValue: unknown, actor: AuthContext): Promise<Record<string, unknown>[]> {
    const repo = new WorkflowRepository(this.pool); const row = await this.request(repo, requestValue)
    await this.canRead(repo, row, actor)
    const result = await this.pool.query<DecisionRow>(
      `SELECT d.id,d.requestcandidate_id AS "candidateId",d.iteration_id AS "iterationId",
              d.decisiontype AS "decisionType",d.targetjobtitle AS "targetJobTitle",d.notes,
              d.decidedby_id AS "decidedById",u.displayname AS "decidedByName",d.decidedat AS "decidedAt"
       FROM egas_promotiondecision d JOIN egas_requestcandidate c ON c.id=d.requestcandidate_id
       JOIN egas_workflowiteration i ON i.id=d.iteration_id JOIN egas_useraccount u ON u.id=d.decidedby_id
       WHERE c.request_id=$1 AND c.removedat IS NULL AND i.request_id=$1 AND i.iterationno=$2
       ORDER BY c.displayorder,d.decidedat,d.id`, [row.id, Number(row.currentIterationNo)])
    return result.rows.map(decisionView)
  }

  async prepareCandidate(requestValue: unknown, candidateValue: unknown, input: Record<string, unknown>, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId')
    const categoryCode = text(input.jobCategoryCode, 'jobCategoryCode', 40)
    const lastPromotionReport = optionalText(input.lastPromotionReport, 'lastPromotionReport', 1000)
    await withTransaction(this.pool, async db => {
      await this.migrationReady(db); const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      this.assertActor(row, actor, 'P2'); const task = await this.task(repo, row, actor, 'P2')
      if (task.taskStatus !== 'CLAIMED') throw new AppError(409, 'Organization task must be claimed first', 'WORKFLOW_TASK_UNAVAILABLE')
      const category = await db.query<{ displayOrder: number }>(
        `SELECT displayorder AS "displayOrder" FROM egas_jobcategoryreference WHERE code=$1 AND isactive=TRUE`, [categoryCode])
      if (!category.rows[0]) throw new AppError(400, 'Active job category not found', 'WORKFLOW_VALIDATION_FAILED')
      if (!await repo.candidate(row.id, candidateId)) throw new AppError(404, 'Candidate not found', 'WORKFLOW_CANDIDATE_NOT_FOUND')
      let sectionId = (await db.query<{ id: string }>(
        `SELECT id FROM egas_requestformsection WHERE request_id=$1 AND jobcategory_code=$2`, [row.id, categoryCode])).rows[0]?.id
      if (!sectionId) {
        sectionId = randomUUID()
        await db.query(
          `INSERT INTO egas_requestformsection
            (id,request_id,jobcategory_code,displayorder,createdby_id,createdat)
           VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,
          [sectionId, row.id, categoryCode, Number(category.rows[0].displayOrder), actor.userId])
      }
      await db.query(
        `UPDATE egas_requestcandidate SET formsection_id=$2,lastpromotionreport=$3,version=version+1 WHERE id=$1`,
        [candidateId, sectionId, lastPromotionReport])
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'PROMOTION_PREPARATION_UPDATED', { jobCategoryCode: categoryCode })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'PROMOTION_PREPARATION_UPDATED', fromStage: 'P2', toStage: 'P2', metadata: { jobCategoryCode: categoryCode } })
    })
    return { requestId, candidateId, jobCategoryCode: categoryCode, lastPromotionReport }
  }

  async decide(requestValue: unknown, candidateValue: unknown, input: Record<string, unknown>, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId')
    const decisionType = input.decisionType
    if (decisionType !== 'SAME_POSITION' && decisionType !== 'OTHER_POSITION') {
      throw new AppError(400, 'decisionType is invalid', 'WORKFLOW_VALIDATION_FAILED')
    }
    const targetJobTitle = decisionType === 'OTHER_POSITION' ? text(input.targetJobTitle, 'targetJobTitle', 500) : null
    const notes = optionalText(input.notes, 'notes', 2000)
    await withTransaction(this.pool, async db => {
      await this.migrationReady(db); const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      this.assertActor(row, actor, 'P4'); const task = await this.task(repo, row, actor, 'P4')
      if (!await repo.candidate(row.id, candidateId)) throw new AppError(404, 'Candidate not found', 'WORKFLOW_CANDIDATE_NOT_FOUND')
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM egas_promotiondecision WHERE requestcandidate_id=$1 AND iteration_id=$2`, [candidateId, task.iterationId])
      const decisionId = existing.rows[0]?.id ?? randomUUID()
      if (existing.rows[0]) {
        await db.query(
          `UPDATE egas_promotiondecision SET decisiontype=$2,targetjobtitle=$3,notes=$4,
                  decidedby_id=$5,decidedat=CURRENT_TIMESTAMP WHERE id=$1`,
          [decisionId, decisionType, targetJobTitle, notes, actor.userId])
      } else {
        await db.query(
          `INSERT INTO egas_promotiondecision
            (id,requestcandidate_id,iteration_id,decisiontype,targetjobtitle,notes,decidedby_id,decidedat)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)`,
          [decisionId, candidateId, task.iterationId, decisionType, targetJobTitle, notes, actor.userId])
      }
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'PROMOTION_DECISION_RECORDED', { decisionType })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'PROMOTION_DECISION_RECORDED', fromStage: 'P4', toStage: 'P4', metadata: { decisionType } })
    })
    return await this.decisions(requestId, actor)
  }

  private async hasSignoff(db: Queryable, requestId: string, iterationId: string, stage: 'P1'|'P2'): Promise<boolean> {
    const result = await db.query(`SELECT 1 FROM egas_workflowsignoff WHERE request_id=$1 AND iteration_id=$2 AND stagecode=$3 LIMIT 1`, [requestId, iterationId, stage])
    return Boolean(result.rows[0])
  }

  private async advance(db: Queryable, repo: WorkflowRepository, row: RequestRow, task: TaskRow, actor: AuthContext,
    from: WorkflowStage, to: WorkflowStage | null, recipient: string | null, actionCode: string, evidence: RequestEvidence): Promise<void> {
    const completed = await db.query(
      `UPDATE egas_stagetask SET taskstatus='COMPLETED',completedat=CURRENT_TIMESTAMP,version=version+1
       WHERE id=$1 AND assigneduser_id=$2 AND taskstatus IN ('OPEN','CLAIMED') RETURNING id`, [task.id, actor.userId])
    if (!completed.rows[0]) throw new AppError(409, 'Workflow task was already completed', 'WORKFLOW_TASK_CONFLICT')
    let nextTaskId: string | null = null
    if (to) {
      const changed = await db.query(
        `UPDATE egas_workflowrequest SET currentstage=$2,status='IN_PROGRESS',updatedat=CURRENT_TIMESTAMP,version=version+1
         WHERE id=$1 AND currentstage=$3 RETURNING id`, [row.id, to, from])
      if (!changed.rows[0]) throw new AppError(409, 'Workflow request changed concurrently', 'WORKFLOW_STAGE_CONFLICT')
      nextTaskId = randomUUID()
      await repo.insertTask(nextTaskId, row.id, task.iterationId, to, recipient)
    } else {
      const changed = await db.query(
        `UPDATE egas_workflowrequest SET status='COMPLETED',completedat=CURRENT_TIMESTAMP,updatedat=CURRENT_TIMESTAMP,
                version=version+1 WHERE id=$1 AND currentstage=$2 RETURNING id`, [row.id, from])
      if (!changed.rows[0]) throw new AppError(409, 'Workflow request changed concurrently', 'WORKFLOW_STAGE_CONFLICT')
    }
    await repo.insertAction(actor, row.id, task.iterationId, task.id, null, actionCode, { fromStage: from, toStage: to })
    await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId,
      routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
      actionCode, fromStage: from, toStage: to })
    if (to && recipient && nextTaskId) {
      await captureReceivedSnapshot(db, { taskId: nextTaskId, requestId: row.id, iterationId: task.iterationId,
        stageCode: to, recipientUserId: recipient, recipientRole: responsibleRole(to) })
    }
    if (!to) await freezeFinalSnapshot(db, row.id, task.iterationId)
    if (recipient) await createNotification(db, { recipientUserId: recipient, requestId: row.id,
      type: 'WORKFLOW_ACTION_REQUIRED', titleAr: 'طلب ترقية بانتظار الإجراء', bodyAr: `تم إحالة الطلب إلى المرحلة ${to}.` })
  }

  async submitP1(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      await this.migrationReady(db); const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      this.assertActor(row, actor, 'P1'); const task = await this.task(repo, row, actor, 'P1')
      if (Number(row.candidateCount) < 1 || !row.routingUnitId || !row.authorityAssignmentId) throw new AppError(409, 'Candidates, routing, and authority are required', 'WORKFLOW_SUBMISSION_INCOMPLETE')
      if (!await this.hasSignoff(db, row.id, task.iterationId, 'P1')) throw new AppError(409, 'Employee Affairs signoff is required', 'WORKFLOW_SIGNOFF_REQUIRED')
      const orgUsers = await db.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM egas_useraccount u JOIN egas_useraccountrole r ON r.user_id=u.id
         WHERE u.isactive=TRUE AND r.role='ORGANIZATION' AND r.isactive=TRUE ORDER BY u.id`)
      await this.advance(db, repo, row, task, actor, 'P1', 'P2', null, 'PROMOTION_P1_SUBMITTED', evidence)
      for (const recipient of orgUsers.rows) await createNotification(db, { recipientUserId: recipient.id, requestId: row.id,
        type: 'ORGANIZATION_QUEUE_ACTIONABLE', titleAr: 'طلب ترقية جديد في قائمة التنظيم', bodyAr: 'يمكن استلام الطلب من قائمة المهام غير المسندة.' })
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'P2' }
    })
  }

  async submitP2(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'P2')
      const task = await this.task(repo, row, actor, 'P2')
      if (task.taskStatus !== 'CLAIMED') throw new AppError(409, 'Organization task must be claimed first', 'WORKFLOW_TASK_UNAVAILABLE')
      const categories = await db.query<{ total: number, categorized: number }>(
        `SELECT COUNT(id)::integer AS total,COUNT(formsection_id)::integer AS categorized
         FROM egas_requestcandidate WHERE request_id=$1 AND removedat IS NULL`, [row.id])
      if (Number(categories.rows[0]?.total) < 1 || Number(categories.rows[0]?.total) !== Number(categories.rows[0]?.categorized)) {
        throw new AppError(409, 'Every candidate requires an approved job category', 'WORKFLOW_PREPARATION_INCOMPLETE')
      }
      if (!await this.hasSignoff(db, row.id, task.iterationId, 'P2')) throw new AppError(409, 'Organization signoff is required', 'WORKFLOW_SIGNOFF_REQUIRED')
      await this.advance(db, repo, row, task, actor, 'P2', 'P3', row.createdById, 'PROMOTION_P2_SUBMITTED', evidence)
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'P3' }
    })
  }

  async approveP3(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'P3')
      const task = await this.task(repo, row, actor, 'P3')
      const recipient = await resolveAuthorityRecipient(db, row.authorityAssignmentId!)
      await this.advance(db, repo, row, task, actor, 'P3', 'P4', recipient, 'PROMOTION_P3_APPROVED', evidence)
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'P4' }
    })
  }

  async approveP4(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'P4')
      const task = await this.task(repo, row, actor, 'P4')
      const decisions = await db.query(
        `SELECT d.requestcandidate_id FROM egas_promotiondecision d JOIN egas_requestcandidate c ON c.id=d.requestcandidate_id
         WHERE c.request_id=$1 AND c.removedat IS NULL AND d.iteration_id=$2`, [row.id, task.iterationId])
      if (Number(row.candidateCount) < 1 || decisions.rows.length !== Number(row.candidateCount)) {
        throw new AppError(409, 'A promotion decision is required for every candidate', 'WORKFLOW_DECISION_INCOMPLETE')
      }
      await this.advance(db, repo, row, task, actor, 'P4', 'P5', row.createdById, 'PROMOTION_P4_APPROVED', evidence)
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'P5' }
    })
  }

  async approveP5(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'P5')
      const task = await this.task(repo, row, actor, 'P5')
      await this.advance(db, repo, row, task, actor, 'P5', null, null, 'PROMOTION_P5_FINAL_APPROVED', evidence)
      return { requestId: row.id, status: 'COMPLETED', currentStage: 'P5' }
    })
  }
}
