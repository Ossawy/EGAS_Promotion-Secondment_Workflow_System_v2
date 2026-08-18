import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withTransaction } from '../../db/transaction.ts'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import {
  optionalText,
  text,
  uuid
} from '../../shared/validation.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import type { AuthContext } from '../auth/types.ts'
import { createNotification } from '../notifications/notification-service.ts'
import { responsibleRole, type RequestRow, type WorkflowStage } from './types.ts'
import { WorkflowRepository, type TaskRow } from './workflow-repository.ts'
import { resolveAuthorityRecipient } from './authority-routing.ts'
import { captureReceivedSnapshot, freezeFinalSnapshot } from './form-snapshot.ts'

type PositionRow = {
  id: string
  candidateId: string
  iterationId: string
  positionTitle: string
  organizationalDependency: string | null
  qualificationStatus: string | null
  enteredById: string
  enteredByName: string
  displayOrder: number
  isSelected: boolean
  selectedById: string | null
  selectedAt: Date | string | null
  createdAt: Date | string
  version: number
}

const positionProjection = `p.id,p.requestcandidate_id AS "candidateId",p.iteration_id AS "iterationId",
  p.positiontitle AS "positionTitle",p.organizationaldependency AS "organizationalDependency",
  p.qualificationstatus_code AS "qualificationStatus",p.enteredby_id AS "enteredById",
  entered.displayname AS "enteredByName",p.displayorder AS "displayOrder",p.isselected AS "isSelected",
  p.selectedby_id AS "selectedById",p.selectedat AS "selectedAt",p.createdat AS "createdAt",p.version`

function positionView(row: PositionRow): Record<string, unknown> {
  return { ...row, displayOrder: Number(row.displayOrder), version: Number(row.version),
    selectedAt: row.selectedAt ? new Date(row.selectedAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString() }
}

function qualification(value: unknown): 'QUALIFIED' | 'NOT_QUALIFIED' {
  if (value !== 'QUALIFIED' && value !== 'NOT_QUALIFIED') {
    throw new AppError(400, 'qualificationStatus must be QUALIFIED or NOT_QUALIFIED', 'WORKFLOW_VALIDATION_FAILED')
  }
  return value
}

export class SecondmentService {
  constructor(private readonly pool: Pool) {}

  private async migrationReady(db: Queryable): Promise<void> {
    const result = await db.query(`SELECT 1 FROM egas_schemamigration WHERE version='004_secondment_workflow_integrity'`)
    if (!result.rows[0]) throw new AppError(409, 'Secondment workflow migration is required', 'WORKFLOW_MIGRATION_REQUIRED')
  }

  private async request(repo: WorkflowRepository, value: unknown, lock = false): Promise<RequestRow> {
    const row = await repo.request(uuid(value, 'requestId'), lock)
    if (!row || row.requestType !== 'SECONDMENT') throw new AppError(404, 'Secondment request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    return row
  }

  private async task(repo: WorkflowRepository, row: RequestRow, actor: AuthContext, stage: WorkflowStage): Promise<TaskRow> {
    if (row.currentStage !== stage) throw new AppError(409, `Request is not at ${stage}`, 'WORKFLOW_STAGE_CONFLICT')
    const task = await repo.currentTask(row)
    if (!task || task.stageCode !== stage || task.assignedUserId !== actor.userId || !['OPEN','CLAIMED'].includes(task.taskStatus)) {
      throw new AppError(404, 'Actionable workflow task not found', 'WORKFLOW_TASK_NOT_FOUND')
    }
    return task
  }

  private assertActor(row: RequestRow, actor: AuthContext, stage: WorkflowStage): void {
    const role = stage === 'S2' || stage === 'S4' ? 'ORGANIZATION' : stage === 'S3' ? 'APPROVING_AUTHORITY' : 'EMPLOYEE_AFFAIRS'
    if (actor.activeRole !== role || ((stage === 'S1' || stage === 'S5') && row.createdById !== actor.userId)) {
      throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    }
  }

  private async positionsFrom(db: Queryable, requestId: string, iterationNo: number): Promise<PositionRow[]> {
    const result = await db.query<PositionRow>(
      `SELECT ${positionProjection} FROM egas_secondmentpositionoption p
       JOIN egas_requestcandidate c ON c.id=p.requestcandidate_id
       JOIN egas_workflowiteration i ON i.id=p.iteration_id
       JOIN egas_useraccount entered ON entered.id=p.enteredby_id
       WHERE c.request_id=$1 AND c.removedat IS NULL AND i.request_id=$1 AND i.iterationno=$2
       ORDER BY c.displayorder,p.displayorder,p.createdat,p.id`, [requestId, iterationNo]
    )
    return result.rows
  }

  private async canRead(repo: WorkflowRepository, row: RequestRow, actor: AuthContext): Promise<void> {
    if (actor.activeRole === 'EMPLOYEE_AFFAIRS' && row.createdById === actor.userId) return
    if ((actor.activeRole === 'ORGANIZATION' || actor.activeRole === 'APPROVING_AUTHORITY') && await repo.hasParticipated(row.id, actor.userId)) return
    throw new AppError(404, 'Secondment request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
  }

  async positions(requestValue: unknown, actor: AuthContext): Promise<Record<string, unknown>[]> {
    const repo = new WorkflowRepository(this.pool); const row = await this.request(repo, requestValue)
    await this.canRead(repo, row, actor)
    return (await this.positionsFrom(this.pool, row.id, Number(row.currentIterationNo))).map(positionView)
  }

  async setCandidateCategory(requestValue: unknown, candidateValue: unknown, categoryValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId')
    const categoryCode = text(categoryValue, 'jobCategoryCode', 40)
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S2')
      const task = await this.task(repo, row, actor, 'S2')
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
      await db.query(`UPDATE egas_requestcandidate SET formsection_id=$2,version=version+1 WHERE id=$1`, [candidateId, sectionId])
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'FORM_SECTION_SELECTED', { jobCategoryCode: categoryCode })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'FORM_SECTION_SELECTED', fromStage: 'S2', toStage: 'S2', metadata: { jobCategoryCode: categoryCode } })
    })
    return { requestId, candidateId, jobCategoryCode: categoryCode }
  }

  async prepareCandidate(
  requestValue: unknown,
  candidateValue: unknown,
  input: Record<string, unknown>,
  actor: AuthContext,
  evidence: RequestEvidence
): Promise<Record<string, unknown>> {
  const requestId =
    uuid(
      requestValue,
      'requestId'
    )

  const candidateId =
    uuid(
      candidateValue,
      'candidateId'
    )

  const categoryCode =
    text(
      input.jobCategoryCode,
      'jobCategoryCode',
      40
    )

  const lastPromotionReport =
    optionalText(
      input.lastPromotionReport,
      'lastPromotionReport',
      1000
    )

  await withTransaction(
    this.pool,
    async db => {
      const repo =
        new WorkflowRepository(db)

      const row =
        await this.request(
          repo,
          requestId,
          true
        )

      this.assertActor(
        row,
        actor,
        'S2'
      )

      const task =
        await this.task(
          repo,
          row,
          actor,
          'S2'
        )

      if (
        task.taskStatus !==
        'CLAIMED'
      ) {
        throw new AppError(
          409,
          'Organization task must be claimed first',
          'WORKFLOW_TASK_UNAVAILABLE'
        )
      }

      const category =
        await db.query<{
          displayOrder: number
        }>(
          `SELECT displayorder AS "displayOrder"
             FROM egas_jobcategoryreference
            WHERE code=$1
              AND isactive=TRUE`,
          [categoryCode]
        )

      if (
        !category.rows[0]
      ) {
        throw new AppError(
          400,
          'Active job category not found',
          'WORKFLOW_VALIDATION_FAILED'
        )
      }

      if (
        !await repo.candidate(
          row.id,
          candidateId
        )
      ) {
        throw new AppError(
          404,
          'Candidate not found',
          'WORKFLOW_CANDIDATE_NOT_FOUND'
        )
      }

      let sectionId =
        (
          await db.query<{
            id: string
          }>(
            `SELECT id
               FROM egas_requestformsection
              WHERE request_id=$1
                AND jobcategory_code=$2`,
            [
              row.id,
              categoryCode
            ]
          )
        ).rows[0]?.id

      if (!sectionId) {
        sectionId =
          randomUUID()

        await db.query(
          `INSERT INTO egas_requestformsection
            (
              id,
              request_id,
              jobcategory_code,
              displayorder,
              createdby_id,
              createdat
            )
           VALUES (
             $1,$2,$3,$4,$5,
             CURRENT_TIMESTAMP
           )`,
          [
            sectionId,
            row.id,
            categoryCode,
            Number(
              category.rows[0]
                .displayOrder
            ),
            actor.userId
          ]
        )
      }

      await db.query(
        `UPDATE egas_requestcandidate
            SET formsection_id=$2,
                lastpromotionreport=$3,
                version=version+1
          WHERE id=$1`,
        [
          candidateId,
          sectionId,
          lastPromotionReport
        ]
      )

      await repo.insertAction(
        actor,
        row.id,
        task.iterationId,
        task.id,
        candidateId,
        'SECONDMENT_PREPARATION_UPDATED',
        {
          jobCategoryCode:
            categoryCode
        }
      )

      await recordWorkflowAudit(
        db,
        actor,
        evidence,
        {
          requestId:
            row.id,

          iterationId:
            task.iterationId,

          candidateId,

          routingUnitId:
            row.routingUnitId,

          authorityAssignmentId:
            row.authorityAssignmentId,

          actionCode:
            'SECONDMENT_PREPARATION_UPDATED',

          fromStage:
            'S2',

          toStage:
            'S2',

          metadata: {
            jobCategoryCode:
              categoryCode
          }
        }
      )
    }
  )

  return {
    requestId,
    candidateId,
    jobCategoryCode:
      categoryCode,
    lastPromotionReport
  }
}

  async addPosition(requestValue: unknown, candidateValue: unknown, input: Record<string, unknown>, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId')
    const positionTitle = text(input.positionTitle, 'positionTitle', 500)
    const dependency = text(input.organizationalDependency, 'organizationalDependency', 1000)
    const status = qualification(input.qualificationStatus)
    await withTransaction(this.pool, async db => {
      await this.migrationReady(db)
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S2')
      const task = await this.task(repo, row, actor, 'S2')
      if (task.taskStatus !== 'CLAIMED') throw new AppError(409, 'Organization task must be claimed first', 'WORKFLOW_TASK_UNAVAILABLE')
      if (!await repo.candidate(row.id, candidateId)) throw new AppError(404, 'Candidate not found', 'WORKFLOW_CANDIDATE_NOT_FOUND')
      const order = await db.query<{ nextOrder: number }>(
        `SELECT COALESCE(MAX(displayorder),-1)+1 AS "nextOrder" FROM egas_secondmentpositionoption
          WHERE requestcandidate_id=$1 AND iteration_id=$2`, [candidateId, task.iterationId])
      const id = randomUUID()
      await db.query(
        `INSERT INTO egas_secondmentpositionoption
          (id,requestcandidate_id,iteration_id,positiontitle,organizationaldependency,
           qualificationstatus_code,enteredby_id,displayorder,isselected,createdat,version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,CURRENT_TIMESTAMP,1)`,
        [id, candidateId, task.iterationId, positionTitle, dependency, status, actor.userId, Number(order.rows[0]?.nextOrder ?? 0)])
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'SECONDMENT_POSITION_ADDED', { positionId: id })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId,
        candidateId, routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'SECONDMENT_POSITION_ADDED', fromStage: 'S2', toStage: 'S2', metadata: { positionId: id } })
    })
    return await this.positions(requestId, actor)
  }

  async updatePosition(requestValue: unknown, positionValue: unknown, input: Record<string, unknown>, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const positionId = uuid(positionValue, 'positionId')
    const positionTitle = text(input.positionTitle, 'positionTitle', 500)
    const dependency = text(input.organizationalDependency, 'organizationalDependency', 1000)
    const status = qualification(input.qualificationStatus)
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S2')
      const task = await this.task(repo, row, actor, 'S2')
      const changed = await db.query<{ candidateId: string }>(
        `UPDATE egas_secondmentpositionoption p SET positiontitle=$4,organizationaldependency=$5,
                qualificationstatus_code=$6,version=version+1
          FROM egas_requestcandidate c WHERE p.id=$1 AND p.iteration_id=$2 AND c.id=p.requestcandidate_id
            AND c.request_id=$3 AND c.removedat IS NULL RETURNING p.requestcandidate_id AS "candidateId"`,
        [positionId, task.iterationId, row.id, positionTitle, dependency, status])
      const candidateId = changed.rows[0]?.candidateId
      if (!candidateId) throw new AppError(404, 'Secondment position not found', 'WORKFLOW_POSITION_NOT_FOUND')
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'SECONDMENT_POSITION_UPDATED', { positionId })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'SECONDMENT_POSITION_UPDATED', fromStage: 'S2', toStage: 'S2', metadata: { positionId } })
    })
    return await this.positions(requestId, actor)
  }

  async removePosition(requestValue: unknown, positionValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<void> {
    const requestId = uuid(requestValue, 'requestId'); const positionId = uuid(positionValue, 'positionId')
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S2')
      const task = await this.task(repo, row, actor, 'S2')
      const removed = await db.query<{ candidateId: string }>(
        `DELETE FROM egas_secondmentpositionoption p USING egas_requestcandidate c
          WHERE p.id=$1 AND p.iteration_id=$2 AND c.id=p.requestcandidate_id AND c.request_id=$3
          RETURNING p.requestcandidate_id AS "candidateId"`, [positionId, task.iterationId, row.id])
      const candidateId = removed.rows[0]?.candidateId
      if (!candidateId) throw new AppError(404, 'Secondment position not found', 'WORKFLOW_POSITION_NOT_FOUND')
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'SECONDMENT_POSITION_REMOVED', { positionId })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'SECONDMENT_POSITION_REMOVED', fromStage: 'S2', toStage: 'S2', metadata: { positionId } })
    })
  }

  async selectPosition(requestValue: unknown, candidateValue: unknown, positionValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId'); const candidateId = uuid(candidateValue, 'candidateId'); const positionId = uuid(positionValue, 'positionId')
    await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S3')
      const task = await this.task(repo, row, actor, 'S3')
      const target = await db.query(
        `SELECT 1 FROM egas_secondmentpositionoption p JOIN egas_requestcandidate c ON c.id=p.requestcandidate_id
          WHERE p.id=$1 AND p.requestcandidate_id=$2 AND p.iteration_id=$3 AND c.request_id=$4 AND c.removedat IS NULL`,
        [positionId, candidateId, task.iterationId, row.id])
      if (!target.rows[0]) throw new AppError(404, 'Secondment position not found', 'WORKFLOW_POSITION_NOT_FOUND')
      await db.query(
        `UPDATE egas_secondmentpositionoption SET isselected=FALSE,selectedby_id=NULL,selectedat=NULL,version=version+1
          WHERE requestcandidate_id=$1 AND iteration_id=$2 AND isselected=TRUE`, [candidateId, task.iterationId])
      await db.query(
        `UPDATE egas_secondmentpositionoption SET isselected=TRUE,selectedby_id=$2,selectedat=CURRENT_TIMESTAMP,version=version+1
          WHERE id=$1`, [positionId, actor.userId])
      await repo.insertAction(actor, row.id, task.iterationId, task.id, candidateId, 'SECONDMENT_POSITION_SELECTED', { positionId })
      await recordWorkflowAudit(db, actor, evidence, { requestId: row.id, iterationId: task.iterationId, candidateId,
        routingUnitId: row.routingUnitId, authorityAssignmentId: row.authorityAssignmentId,
        actionCode: 'SECONDMENT_POSITION_SELECTED', fromStage: 'S3', toStage: 'S3', metadata: { positionId } })
    })
    return await this.positions(requestId, actor)
  }

  private async hasSignoff(db: Queryable, requestId: string, iterationId: string, stage: 'S1'|'S2'): Promise<boolean> {
    const result = await db.query(
      `SELECT 1 FROM egas_workflowsignoff WHERE request_id=$1 AND iteration_id=$2 AND stagecode=$3 LIMIT 1`,
      [requestId, iterationId, stage])
    return Boolean(result.rows[0])
  }

  private async completeAndAdvance(
    db: Queryable, repo: WorkflowRepository, row: RequestRow, task: TaskRow, actor: AuthContext,
    from: WorkflowStage, to: WorkflowStage | null, recipient: string | null, evidence: RequestEvidence,
    actionCode: string
  ): Promise<void> {
    const completed = await db.query(
      `UPDATE egas_stagetask SET taskstatus='COMPLETED',completedat=CURRENT_TIMESTAMP,version=version+1
        WHERE id=$1 AND assigneduser_id=$2 AND taskstatus IN ('OPEN','CLAIMED') RETURNING id`, [task.id, actor.userId])
    if (!completed.rows[0]) throw new AppError(409, 'Workflow task was already completed', 'WORKFLOW_TASK_CONFLICT')
    let nextTaskId: string | null = null
    if (to) {
      const status = to === 'S5' ? 'IN_PROGRESS' : 'IN_PROGRESS'
      const changed = await db.query(
        `UPDATE egas_workflowrequest SET currentstage=$2,status=$3,updatedat=CURRENT_TIMESTAMP,version=version+1
          WHERE id=$1 AND currentstage=$4 RETURNING id`, [row.id, to, status, from])
      if (!changed.rows[0]) throw new AppError(409, 'Workflow request changed concurrently', 'WORKFLOW_STAGE_CONFLICT')
      nextTaskId = randomUUID()
      await repo.insertTask(nextTaskId, row.id, task.iterationId, to, recipient)
    } else {
      const changed = await db.query(
        `UPDATE egas_workflowrequest SET status='COMPLETED',completedat=CURRENT_TIMESTAMP,
                updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND currentstage=$2 RETURNING id`, [row.id, from])
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
      type: 'WORKFLOW_ACTION_REQUIRED', titleAr: 'طلب ندب بانتظار الإجراء', bodyAr: `تم إحالة الطلب إلى المرحلة ${to}.` })
  }

  async submitS1(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      await this.migrationReady(db); const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true)
      this.assertActor(row, actor, 'S1'); const task = await this.task(repo, row, actor, 'S1')
      if (Number(row.candidateCount) < 1 || !row.routingUnitId || !row.authorityAssignmentId) {
        throw new AppError(409, 'Candidates, routing, and authority are required', 'WORKFLOW_SUBMISSION_INCOMPLETE')
      }
      if (!await this.hasSignoff(db, row.id, task.iterationId, 'S1')) throw new AppError(409, 'Employee Affairs signoff is required', 'WORKFLOW_SIGNOFF_REQUIRED')
      const orgUsers = await db.query<{ id: string }>(
        `SELECT DISTINCT u.id FROM egas_useraccount u JOIN egas_useraccountrole r ON r.user_id=u.id
          WHERE u.isactive=TRUE AND r.role='ORGANIZATION' AND r.isactive=TRUE ORDER BY u.id`)
      await this.completeAndAdvance(db, repo, row, task, actor, 'S1', 'S2', null, evidence, 'SECONDMENT_S1_SUBMITTED')
      for (const recipient of orgUsers.rows) await createNotification(db, { recipientUserId: recipient.id, requestId: row.id,
        type: 'ORGANIZATION_QUEUE_ACTIONABLE', titleAr: 'طلب ندب جديد في قائمة التنظيم', bodyAr: 'يمكن استلام الطلب من قائمة المهام غير المسندة.' })
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'S2' }
    })
  }

  async submitS2(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S2')
      const task = await this.task(repo, row, actor, 'S2')
      if (task.taskStatus !== 'CLAIMED') throw new AppError(409, 'Organization task must be claimed first', 'WORKFLOW_TASK_UNAVAILABLE')
      const completeness =
  await db.query<{
    candidateCount: number
    coveredCount: number
    categorizedCount: number
    reportCount: number
  }>(
    `SELECT
        COUNT(c.id)::integer
          AS "candidateCount",

        COUNT(c.formsection_id)::integer
          AS "categorizedCount",
  COUNT(c.lastpromotionreport)::integer
  AS "reportCount",

        (
          SELECT
            COUNT(
              DISTINCT
              p.requestcandidate_id
            )::integer

          FROM
            egas_secondmentpositionoption p

          JOIN
            egas_requestcandidate pc
              ON pc.id =
                 p.requestcandidate_id

          WHERE
            pc.request_id=$1

            AND pc.removedat
              IS NULL

            AND p.iteration_id=$2
        ) AS "coveredCount"

       FROM
         egas_requestcandidate c

       WHERE
         c.request_id=$1

         AND c.removedat
           IS NULL`,
    [
      row.id,
      task.iterationId
    ]
  )
      const totals = completeness.rows[0]!
      if (
  Number(
    totals.candidateCount
  ) < 1 ||

  Number(
    totals.coveredCount
  ) !==
    Number(
      totals.candidateCount
    ) ||

  Number(
    totals.categorizedCount
  ) !==
    Number(
      totals.candidateCount
    ) ||

  Number(
    totals.reportCount
  ) !==
    Number(
      totals.candidateCount
    )
) {
  throw new AppError(
    409,
    'A category, last promotion report, and at least one complete proposed position are required for every candidate',
    'WORKFLOW_POSITIONS_INCOMPLETE'
  )
}
      if (!await this.hasSignoff(db, row.id, task.iterationId, 'S2')) throw new AppError(409, 'Organization signoff is required', 'WORKFLOW_SIGNOFF_REQUIRED')
      const recipient = await resolveAuthorityRecipient(db, row.authorityAssignmentId!)
      await this.completeAndAdvance(db, repo, row, task, actor, 'S2', 'S3', recipient, evidence, 'SECONDMENT_S2_SUBMITTED')
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'S3' }
    })
  }

  async approveS3(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S3')
      const task = await this.task(repo, row, actor, 'S3')
      const selected = await db.query(
        `SELECT p.requestcandidate_id FROM egas_secondmentpositionoption p
         JOIN egas_requestcandidate c ON c.id=p.requestcandidate_id
         WHERE c.request_id=$1 AND c.removedat IS NULL AND p.iteration_id=$2 AND p.isselected=TRUE`,
        [row.id, task.iterationId])
      if (Number(row.candidateCount) < 1 || selected.rows.length !== Number(row.candidateCount)) {
        throw new AppError(409, 'Exactly one position must be selected for every candidate', 'WORKFLOW_SELECTION_INCOMPLETE')
      }
      const org = await db.query<{ userId: string }>(
        `SELECT assigneduser_id AS "userId" FROM egas_stagetask WHERE iteration_id=$1 AND stagecode='S2' LIMIT 1`, [task.iterationId])
      if (!org.rows[0]?.userId) throw new AppError(409, 'Original Organization assignee is unavailable', 'WORKFLOW_TASK_UNAVAILABLE')
      await this.completeAndAdvance(db, repo, row, task, actor, 'S3', 'S4', org.rows[0].userId, evidence, 'SECONDMENT_S3_APPROVED')
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'S4' }
    })
  }

  async confirmS4(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S4')
      const task = await this.task(repo, row, actor, 'S4')
      await this.completeAndAdvance(db, repo, row, task, actor, 'S4', 'S5', row.createdById, evidence, 'SECONDMENT_S4_CONFIRMED')
      return { requestId: row.id, status: 'IN_PROGRESS', currentStage: 'S5' }
    })
  }

  async approveS5(requestValue: unknown, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    return await withTransaction(this.pool, async db => {
      const repo = new WorkflowRepository(db); const row = await this.request(repo, requestId, true); this.assertActor(row, actor, 'S5')
      const task = await this.task(repo, row, actor, 'S5')
      await this.completeAndAdvance(db, repo, row, task, actor, 'S5', null, null, evidence, 'SECONDMENT_S5_FINAL_APPROVED')
      return { requestId: row.id, status: 'COMPLETED', currentStage: 'S5' }
    })
  }
}
