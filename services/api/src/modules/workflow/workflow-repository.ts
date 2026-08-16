import { randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import type { WorkflowEmployeeSnapshot } from '../employee/employee-data-service.ts'
import type { AuthContext } from '../auth/types.ts'
import type { CandidateRow, RequestRow, WorkflowStage, WorkflowType } from './types.ts'

function requestProjection(): string {
  return `r.id,r.requestnumber AS "requestNumber",r.requesttype AS "requestType",
    r.cycleyear AS "cycleYear",r.formmonth AS "formMonth",r.formyear AS "formYear",
    r.routingunit_id AS "routingUnitId",ru.namear AS "routingUnitName",
    r.approvingauthorityassignment_id AS "authorityAssignmentId",
    r.approvingauthoritypersonnelsnapshot AS "authorityPersonnel",
    r.approvingauthoritynamesnapshot AS "authorityName",
    r.approvingauthorityjobtitlesnapshot AS "authorityJobTitle",
    r.approvingauthoritykindsnapshot AS "authorityKind",
    r.createdby_id AS "createdById",creator.username AS "creatorUsername",
    creator.displayname AS "creatorDisplayName",r.status,r.currentstage AS "currentStage",
    r.currentiterationno AS "currentIterationNo",r.createdat AS "createdAt",
    r.updatedat AS "updatedAt",r.version,COALESCE(cc.candidatecount,0)::integer AS "candidateCount"`
}

function candidateProjection(): string {
  return `c.id,c.employeesnapshot_id AS "snapshotId",s.snapshotyear AS "snapshotYear",
    c.personnelnumbersnapshot AS "personnelNumber",c.employeenamesnapshot AS "employeeName",
    c.subgroupsnapshot AS subgroup,s.sourceroutingunit AS "sourceRoutingUnit",
    c.routingunitnamesnapshot AS "routingUnitName",c.currentjobsnapshot AS "currentJobTitle",
    c.performanceratingsnapshot AS "performanceRating",
    c.qualificationsource1snapshot AS "qualificationSource1",
    c.qualificationsource2snapshot AS "qualificationSource2",
    c.qualificationdatesnapshot AS "qualificationDate",c.displayorder AS "displayOrder",
    c.formsection_id AS "formSectionId",fs.jobcategory_code AS "jobCategoryCode",
    jc.namear AS "jobCategoryName",c.lastpromotionreport AS "lastPromotionReport",c.createdat AS "createdAt"`
}

export type AuthorityOptionRow = {
  id: string
  userAccountId: string
  staffIdentifier: string | null
  displayName: string
  authorityKind: string
  authorityJobTitle: string
  isPrimary: boolean
}

export type TaskRow = {
  id: string
  iterationId: string
  requestId: string
  stageCode: WorkflowStage
  taskStatus: string
  assignedUserId: string | null
  claimedRole: string | null
  claimedAt: Date | string | null
  openedAt: Date | string
}

export class WorkflowRepository {
  constructor(readonly db: Queryable) {}

  async migrationReady(): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM egas_schemamigration WHERE version='003_phase3a_workflow_draft_foundation'`
    )
    return Boolean(result.rows[0])
  }

  async insertRequest(
    id: string,
    type: WorkflowType,
    cycleYear: number,
    formMonth: number,
    formYear: number,
    creatorId: string,
    stage: WorkflowStage
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO egas_workflowrequest
        (id,requestnumber,requesttype,cycleyear,formmonth,formyear,createdby_id,status,
         currentstage,currentiterationno,createdat,updatedat,version)
       VALUES ($1,$1,$2,$3,$4,$5,$6,'DRAFT',$7,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [id, type, cycleYear, formMonth, formYear, creatorId, stage]
    )
  }

  async insertIteration(id: string, requestId: string, creatorId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO egas_workflowiteration
        (id,request_id,iterationno,status,startedby_id,startedat)
       VALUES ($1,$2,1,'ACTIVE',$3,CURRENT_TIMESTAMP)`, [id, requestId, creatorId]
    )
  }

  async insertTask(
    id: string,
    requestId: string,
    iterationId: string,
    stage: WorkflowStage,
    assignedUserId: string | null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO egas_stagetask
        (id,iteration_id,request_id,stagecode,taskstatus,assigneduser_id,openedat,version)
       VALUES ($1,$2,$3,$4,'OPEN',$5,CURRENT_TIMESTAMP,1)`,
      [id, iterationId, requestId, stage, assignedUserId]
    )
  }

  async insertAction(
    actor: AuthContext,
    requestId: string,
    iterationId: string,
    taskId: string | null,
    candidateId: string | null,
    actionCode: string,
    payload: Record<string, string | number | boolean | null> = {},
    reason: string | null = null
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO egas_stageaction
        (id,request_id,iteration_id,stagetask_id,requestcandidate_id,actoruser_id,
         actorrolesnapshot,actioncode,reason,payloadjson,createdat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,CURRENT_TIMESTAMP)`,
      [randomUUID(), requestId, iterationId, taskId, candidateId, actor.userId,
        actor.activeRole, actionCode, reason, JSON.stringify(payload)]
    )
  }

  async request(requestId: string, lock = false): Promise<RequestRow | undefined> {
    if (lock) await this.db.query('SELECT id FROM egas_workflowrequest WHERE id=$1 FOR UPDATE', [requestId])
    const result = await this.db.query<RequestRow>(
      `SELECT ${requestProjection()} FROM egas_workflowrequest r
       JOIN egas_useraccount creator ON creator.id=r.createdby_id
       LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
       LEFT JOIN (SELECT request_id,COUNT(*) AS candidatecount FROM egas_requestcandidate
                   WHERE removedat IS NULL GROUP BY request_id) cc ON cc.request_id=r.id
       WHERE r.id=$1`, [requestId]
    )
    return result.rows[0]
  }

  async listRequests(
    creatorId: string,
    skip: number,
    top: number,
    type: WorkflowType | null,
    status: string | null,
    cycleYear: number | null
  ): Promise<RequestRow[]> {
    const result = await this.db.query<RequestRow>(
      `SELECT ${requestProjection()} FROM egas_workflowrequest r
       JOIN egas_useraccount creator ON creator.id=r.createdby_id
       LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
       LEFT JOIN (SELECT request_id,COUNT(*) AS candidatecount FROM egas_requestcandidate
                   WHERE removedat IS NULL GROUP BY request_id) cc ON cc.request_id=r.id
       WHERE r.createdby_id=$1
         AND ($2::varchar IS NULL OR r.requesttype=$2)
         AND ($3::varchar IS NULL OR r.status=$3)
         AND ($4::integer IS NULL OR r.cycleyear=$4)
       ORDER BY r.updatedat DESC,r.id DESC LIMIT $5 OFFSET $6`,
      [creatorId, type, status, cycleYear, top, skip]
    )
    return result.rows
  }

  async currentTask(request: RequestRow): Promise<TaskRow | undefined> {
    const result = await this.db.query<TaskRow>(
      `SELECT t.id,t.iteration_id AS "iterationId",t.request_id AS "requestId",
              t.stagecode AS "stageCode",t.taskstatus AS "taskStatus",
              t.assigneduser_id AS "assignedUserId",t.claimedrolesnapshot AS "claimedRole",
              t.claimedat AS "claimedAt",t.openedat AS "openedAt"
         FROM egas_stagetask t JOIN egas_workflowiteration i ON i.id=t.iteration_id
        WHERE t.request_id=$1 AND i.iterationno=$2 AND t.stagecode=$3
        ORDER BY t.openedat DESC,t.id DESC LIMIT 1`,
      [request.id, Number(request.currentIterationNo), request.currentStage]
    )
    return result.rows[0]
  }

  async hasParticipated(requestId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM egas_stagetask WHERE request_id=$1 AND assigneduser_id=$2 LIMIT 1`,
      [requestId, userId]
    )
    return Boolean(result.rows[0])
  }

  async candidates(requestId: string): Promise<CandidateRow[]> {
    const result = await this.db.query<CandidateRow>(
      `SELECT ${candidateProjection()} FROM egas_requestcandidate c
       JOIN egas_employeeannualsnapshot s ON s.id=c.employeesnapshot_id
       LEFT JOIN egas_requestformsection fs ON fs.id=c.formsection_id
       LEFT JOIN egas_jobcategoryreference jc ON jc.code=fs.jobcategory_code
       WHERE c.request_id=$1 AND c.removedat IS NULL ORDER BY c.displayorder,c.createdat,c.id`, [requestId]
    )
    return result.rows
  }

  async candidate(requestId: string, candidateId: string): Promise<CandidateRow | undefined> {
    const result = await this.db.query<CandidateRow>(
      `SELECT ${candidateProjection()} FROM egas_requestcandidate c
       JOIN egas_employeeannualsnapshot s ON s.id=c.employeesnapshot_id
       LEFT JOIN egas_requestformsection fs ON fs.id=c.formsection_id
       LEFT JOIN egas_jobcategoryreference jc ON jc.code=fs.jobcategory_code
       WHERE c.request_id=$1 AND c.id=$2 AND c.removedat IS NULL`, [requestId, candidateId]
    )
    return result.rows[0]
  }

  async insertCandidate(requestId: string, employee: WorkflowEmployeeSnapshot): Promise<string> {
    const order = await this.db.query<{ nextOrder: number }>(
      `SELECT COALESCE(MAX(displayorder),-1)+1 AS "nextOrder" FROM egas_requestcandidate
        WHERE request_id=$1 AND removedat IS NULL`, [requestId]
    )
    const id = randomUUID()
    await this.db.query(
      `INSERT INTO egas_requestcandidate
        (id,request_id,formsection_id,employeesnapshot_id,displayorder,personnelnumbersnapshot,
         employeenamesnapshot,currentjobsnapshot,routingunitnamesnapshot,subgroupsnapshot,
         performanceratingsnapshot,qualificationsource1snapshot,qualificationsource2snapshot,
         qualificationdatesnapshot,performancewarningacknowledged,createdat,version)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,CURRENT_TIMESTAMP,1)`,
      [id, requestId, employee.snapshotId, Number(order.rows[0]?.nextOrder ?? 0), employee.personnelNumber,
        employee.employeeName, employee.currentJobTitle, employee.routingUnitName, employee.subgroup,
        employee.performanceRating, employee.qualificationSource1, employee.qualificationSource2,
        employee.qualificationDate]
    )
    return id
  }

  async establishRouting(requestId: string, routingUnitId: string): Promise<void> {
    await this.db.query(
      `UPDATE egas_workflowrequest SET routingunit_id=$2,updatedat=CURRENT_TIMESTAMP,version=version+1
        WHERE id=$1 AND routingunit_id IS NULL`, [requestId, routingUnitId]
    )
  }

  async removeCandidate(candidateId: string, actorId: string): Promise<void> {
    await this.db.query(
      `UPDATE egas_requestcandidate SET removedat=CURRENT_TIMESTAMP,removedby_id=$2,version=version+1
        WHERE id=$1 AND removedat IS NULL`, [candidateId, actorId]
    )
  }

  async clearDraftRouting(requestId: string): Promise<void> {
    await this.db.query(
      `UPDATE egas_workflowrequest
          SET routingunit_id=NULL,approvingauthorityassignment_id=NULL,
              approvingauthoritypersonnelsnapshot=NULL,approvingauthoritynamesnapshot=NULL,
              approvingauthorityjobtitlesnapshot=NULL,approvingauthoritykindsnapshot=NULL,
              updatedat=CURRENT_TIMESTAMP,version=version+1
        WHERE id=$1 AND status='DRAFT'`, [requestId]
    )
  }

  async authorityOptions(routingUnitId: string): Promise<AuthorityOptionRow[]> {
    const result = await this.db.query<AuthorityOptionRow>(
      `SELECT a.id,a.useraccount_id AS "userAccountId",COALESCE(u.staffidentifier,u.username) AS "staffIdentifier",
              u.displayname AS "displayName",a.authoritykind AS "authorityKind",
              a.authorityjobtitle AS "authorityJobTitle",a.isprimary AS "isPrimary"
         FROM egas_approvingauthorityassignment a
         JOIN egas_useraccount u ON u.id=a.useraccount_id AND u.isactive=TRUE
         JOIN egas_useraccountrole ur ON ur.user_id=u.id AND ur.role='APPROVING_AUTHORITY' AND ur.isactive=TRUE
        WHERE a.routingunit_id=$1 AND a.isactive=TRUE
          AND a.validfrom <= CURRENT_DATE
          AND (a.validto IS NULL OR a.validto >= CURRENT_DATE)
        ORDER BY a.isprimary DESC,a.createdat,a.id`, [routingUnitId]
    )
    return result.rows
  }

  async selectAuthority(requestId: string, option: AuthorityOptionRow): Promise<void> {
    await this.db.query(
      `UPDATE egas_workflowrequest
          SET approvingauthorityassignment_id=$2,approvingauthoritypersonnelsnapshot=$3,
              approvingauthoritynamesnapshot=$4,approvingauthorityjobtitlesnapshot=$5,
              approvingauthoritykindsnapshot=$6,updatedat=CURRENT_TIMESTAMP,version=version+1
        WHERE id=$1 AND status='DRAFT'`,
      [requestId, option.id, option.staffIdentifier, option.displayName, option.authorityJobTitle, option.authorityKind]
    )
  }

  async insertNote(
    requestId: string,
    iterationId: string,
    taskId: string | null,
    candidateId: string | null,
    actor: AuthContext,
    message: string
  ): Promise<string> {
    const id = randomUUID()
    await this.db.query(
      `INSERT INTO egas_workflownote
        (id,request_id,iteration_id,stagetask_id,requestcandidate_id,scopecode,
         authoruser_id,authorrolesnapshot,messagetext,createdat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)`,
      [id, requestId, iterationId, taskId, candidateId, candidateId ? 'CANDIDATE' : 'REQUEST',
        actor.userId, actor.activeRole, message]
    )
    return id
  }

  async notes(requestId: string, top: number): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<{
      id: string, iterationNo: number, stageCode: string | null, candidateId: string | null,
      scope: string, authorUserId: string, authorName: string, authorRole: string,
      message: string, createdAt: Date | string
    }>(
      `SELECT n.id,i.iterationno AS "iterationNo",t.stagecode AS "stageCode",
              n.requestcandidate_id AS "candidateId",n.scopecode AS scope,
              n.authoruser_id AS "authorUserId",u.displayname AS "authorName",
              n.authorrolesnapshot AS "authorRole",n.messagetext AS message,n.createdat AS "createdAt"
         FROM egas_workflownote n JOIN egas_workflowiteration i ON i.id=n.iteration_id
         JOIN egas_useraccount u ON u.id=n.authoruser_id
         LEFT JOIN egas_stagetask t ON t.id=n.stagetask_id
        WHERE n.request_id=$1 ORDER BY n.createdat,n.id LIMIT $2`, [requestId, top]
    )
    return result.rows.map(row => ({ ...row, iterationNo: Number(row.iterationNo), createdAt: new Date(row.createdAt).toISOString() }))
  }

  async timeline(requestId: string, top: number): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<{
      id: string, kind: string, code: string, candidateId: string | null,
      actorUserId: string, actorName: string, actorRole: string, stageCode: string | null,
      message: string | null, createdAt: Date | string
    }>(
      `SELECT * FROM (SELECT a.id,'ACTION'::varchar AS kind,a.actioncode AS code,
              a.requestcandidate_id AS "candidateId",a.actoruser_id AS "actorUserId",
              u.displayname AS "actorName",a.actorrolesnapshot AS "actorRole",
              t.stagecode AS "stageCode",a.reason AS message,a.createdat AS "createdAt"
         FROM egas_stageaction a JOIN egas_useraccount u ON u.id=a.actoruser_id
         LEFT JOIN egas_stagetask t ON t.id=a.stagetask_id WHERE a.request_id=$1
       UNION ALL
       SELECT n.id,'NOTE'::varchar AS kind,'NOTE_ADDED'::varchar AS code,
              n.requestcandidate_id AS "candidateId",n.authoruser_id AS "actorUserId",
              u.displayname AS "actorName",n.authorrolesnapshot AS "actorRole",
              t.stagecode AS "stageCode",n.messagetext AS message,n.createdat AS "createdAt"
         FROM egas_workflownote n JOIN egas_useraccount u ON u.id=n.authoruser_id
         LEFT JOIN egas_stagetask t ON t.id=n.stagetask_id WHERE n.request_id=$1
       ) entries ORDER BY "createdAt",entries.id LIMIT $2`, [requestId, top]
    )
    return result.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }))
  }

  async organizationQueue(userId: string, skip: number, top: number): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<{
      taskId: string, requestId: string, requestNumber: string, requestType: WorkflowType,
      cycleYear: number, stageCode: WorkflowStage, taskStatus: string,
      assignedUserId: string | null, claimantName: string | null, openedAt: Date | string,
      candidateCount: number, routingUnitName: string | null
    }>(
      `SELECT t.id AS "taskId",r.id AS "requestId",r.requestnumber AS "requestNumber",
              r.requesttype AS "requestType",r.cycleyear AS "cycleYear",t.stagecode AS "stageCode",
              t.taskstatus AS "taskStatus",t.assigneduser_id AS "assignedUserId",
              claimant.displayname AS "claimantName",t.openedat AS "openedAt",
              COALESCE(cc.candidatecount,0)::integer AS "candidateCount",
              ru.namear AS "routingUnitName"
         FROM egas_stagetask t
         JOIN egas_workflowrequest r ON r.id=t.request_id
         LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
         LEFT JOIN egas_useraccount claimant ON claimant.id=t.assigneduser_id
         LEFT JOIN (SELECT request_id,COUNT(*) AS candidatecount FROM egas_requestcandidate
                     WHERE removedat IS NULL GROUP BY request_id) cc ON cc.request_id=r.id
        WHERE t.stagecode IN ('P2','S2','S4') AND t.taskstatus IN ('OPEN','CLAIMED')
        ORDER BY t.openedat,t.id LIMIT $1 OFFSET $2`, [top, skip]
    )
    return result.rows.map(row => ({
      ...row,
      cycleYear: Number(row.cycleYear),
      candidateCount: Number(row.candidateCount),
      openedAt: new Date(row.openedAt).toISOString(),
      claimable: row.taskStatus === 'OPEN' && row.assignedUserId === null,
      claimedByMe: row.assignedUserId === userId
    }))
  }

  async authorityQueue(userId: string, skip: number, top: number): Promise<Record<string, unknown>[]> {
    const result = await this.db.query<{
      taskId: string, requestId: string, requestNumber: string, requestType: WorkflowType,
      cycleYear: number, stageCode: WorkflowStage, taskStatus: string,
      openedAt: Date | string, candidateCount: number, routingUnitName: string | null
    }>(
      `SELECT t.id AS "taskId",r.id AS "requestId",r.requestnumber AS "requestNumber",
              r.requesttype AS "requestType",r.cycleyear AS "cycleYear",t.stagecode AS "stageCode",
              t.taskstatus AS "taskStatus",t.openedat AS "openedAt",
              COALESCE(cc.candidatecount,0)::integer AS "candidateCount",
              ru.namear AS "routingUnitName"
         FROM egas_stagetask t
         JOIN egas_workflowrequest r ON r.id=t.request_id
         LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
         LEFT JOIN (SELECT request_id,COUNT(*) AS candidatecount FROM egas_requestcandidate
                     WHERE removedat IS NULL GROUP BY request_id) cc ON cc.request_id=r.id
        WHERE t.stagecode IN ('P4','S3') AND t.taskstatus IN ('OPEN','CLAIMED')
          AND t.assigneduser_id=$1
        ORDER BY t.openedat,t.id LIMIT $2 OFFSET $3`, [userId, top, skip]
    )
    return result.rows.map(row => ({
      ...row,
      cycleYear: Number(row.cycleYear),
      candidateCount: Number(row.candidateCount),
      openedAt: new Date(row.openedAt).toISOString(),
      actionable: true
    }))
  }

  async claimOrganizationTask(taskId: string, userId: string): Promise<TaskRow | undefined> {
    const result = await this.db.query<TaskRow>(
      `UPDATE egas_stagetask
          SET taskstatus='CLAIMED',assigneduser_id=$2,claimedrolesnapshot='ORGANIZATION',
              claimedat=CURRENT_TIMESTAMP,version=version+1
        WHERE id=$1 AND stagecode IN ('P2','S2','S4')
          AND taskstatus='OPEN' AND assigneduser_id IS NULL
      RETURNING id,iteration_id AS "iterationId",request_id AS "requestId",
                stagecode AS "stageCode",taskstatus AS "taskStatus",
                assigneduser_id AS "assignedUserId",claimedrolesnapshot AS "claimedRole",
                claimedat AS "claimedAt",openedat AS "openedAt"`, [taskId, userId]
    )
    return result.rows[0]
  }

  async task(taskId: string): Promise<TaskRow | undefined> {
    const result = await this.db.query<TaskRow>(
      `SELECT id,iteration_id AS "iterationId",request_id AS "requestId",stagecode AS "stageCode",
              taskstatus AS "taskStatus",assigneduser_id AS "assignedUserId",
              claimedrolesnapshot AS "claimedRole",claimedat AS "claimedAt",openedat AS "openedAt"
         FROM egas_stagetask WHERE id=$1`, [taskId]
    )
    return result.rows[0]
  }
}
