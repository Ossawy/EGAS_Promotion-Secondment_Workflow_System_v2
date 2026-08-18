import { createHash, randomUUID } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'
import type { Role } from '../../shared/roles.ts'
import type { WorkflowStage } from './types.ts'

export const PDF_TEMPLATE_V1 = 'EGAS-OFFICIAL-AR-1.0'
export const PDF_TEMPLATE_V2 = 'EGAS-OFFICIAL-AR-2.0'

/*
 * Keep V1 active until the V2 renderer is implemented and tested.
 * Switching this constant activates V2 for newly captured snapshots.
 */
export const PDF_TEMPLATE_VERSION = PDF_TEMPLATE_V2

export type FormSnapshot = {
  schemaVersion: 1
  kind: 'RECEIVED' | 'DRAFT' | 'FINAL'
  capturedAt: string
  task: { id: string, stageCode: WorkflowStage, recipientUserId: string, recipientRole: Role } | null
  request: Record<string, unknown>
  candidates: Array<Record<string, unknown>>
  signoffs: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  requestNotes: Array<Record<string, unknown>>
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

export function snapshotJson(snapshot: FormSnapshot): string { return JSON.stringify(canonical(snapshot)) }
export function snapshotSha256(snapshot: FormSnapshot): string {
  return createHash('sha256').update(snapshotJson(snapshot)).digest('hex')
}

export async function buildFormSnapshot(
  db: Queryable,
  requestId: string,
  iterationId: string,
  kind: FormSnapshot['kind'],
  task: FormSnapshot['task']
): Promise<FormSnapshot> {
  const clock = await db.query<{ capturedAt: Date | string }>(`SELECT CURRENT_TIMESTAMP AS "capturedAt"`)
  const request = await db.query<Record<string, unknown>>(
    `SELECT r.id,r.requestnumber AS "requestNumber",r.requesttype AS "requestType",
            r.cycleyear AS "cycleYear",r.formmonth AS "formMonth",r.formyear AS "formYear",
            r.status,r.currentstage AS "currentStage",i.iterationno AS "iterationNo",
            r.routingunit_id AS "routingUnitId",ru.namear AS "routingUnitName",
            r.approvingauthoritypersonnelsnapshot AS "authorityPersonnelNumber",
            r.approvingauthoritynamesnapshot AS "authorityName",
            r.approvingauthorityjobtitlesnapshot AS "authorityJobTitle",
            r.approvingauthoritykindsnapshot AS "authorityKind",
            creator.displayname AS "createdByName",creator.username AS "createdByUsername",
            r.createdat AS "createdAt",r.completedat AS "completedAt"
       FROM egas_workflowrequest r
       JOIN egas_workflowiteration i ON i.request_id=r.id AND i.id=$2
       JOIN egas_useraccount creator ON creator.id=r.createdby_id
       LEFT JOIN egas_routingunit ru ON ru.id=r.routingunit_id
      WHERE r.id=$1`, [requestId, iterationId]
  )
  if (!request.rows[0]) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')

  const candidates = await db.query<Record<string, unknown>>(
    `SELECT c.id,c.personnelnumbersnapshot AS "personnelNumber",c.employeenamesnapshot AS "employeeName",
            c.currentjobsnapshot AS "currentJobTitle",c.subgroupsnapshot AS subgroup,
            c.performanceratingsnapshot AS "performanceRating",
            c.qualificationsource1snapshot AS "qualificationSource1",
            c.qualificationsource2snapshot AS "qualificationSource2",
            c.qualificationdatesnapshot AS "qualificationDate",
            c.lastpromotionreport AS "lastPromotionReport",c.displayorder AS "displayOrder",
            fs.jobcategory_code AS "jobCategoryCode",jc.namear AS "jobCategoryName"
       FROM egas_requestcandidate c
       LEFT JOIN egas_requestformsection fs ON fs.id=c.formsection_id
       LEFT JOIN egas_jobcategoryreference jc ON jc.code=fs.jobcategory_code
      WHERE c.request_id=$1 AND c.removedat IS NULL
      ORDER BY COALESCE(fs.displayorder,2147483647),c.displayorder,c.id`, [requestId]
  )
  const positions = await db.query<Record<string, unknown>>(
    `SELECT p.id,p.requestcandidate_id AS "candidateId",p.positiontitle AS "positionTitle",
            p.organizationaldependency AS "organizationalDependency",
            p.qualificationstatus_code AS "qualificationStatus",p.isselected AS "isSelected",
            p.displayorder AS "displayOrder",p.createdat AS "createdAt"
       FROM egas_secondmentpositionoption p JOIN egas_requestcandidate c ON c.id=p.requestcandidate_id
      WHERE c.request_id=$1 AND p.iteration_id=$2 AND c.removedat IS NULL
      ORDER BY c.displayorder,p.displayorder,p.id`, [requestId, iterationId]
  )
  const decisions = await db.query<Record<string, unknown>>(
    `SELECT d.requestcandidate_id AS "candidateId",d.decisiontype AS "decisionType",
        d.targetjobtitle AS "targetJobTitle",d.targetroutingunit_id AS "targetRoutingUnitId",
        tru.namear AS "targetRoutingUnitName",d.notes,d.decidedat AS "decidedAt",
            u.displayname AS "decidedByName",u.username AS "decidedByUsername"
       FROM egas_promotiondecision d
       JOIN egas_requestcandidate c ON c.id=d.requestcandidate_id
       JOIN egas_useraccount u ON u.id=d.decidedby_id
      LEFT JOIN egas_routingunit tru ON tru.id=d.targetroutingunit_id
      WHERE c.request_id=$1 AND d.iteration_id=$2 AND c.removedat IS NULL
      ORDER BY c.displayorder,d.id`, [requestId, iterationId]
  )
  const notes = await db.query<Record<string, unknown>>(
    `SELECT n.id,n.requestcandidate_id AS "candidateId",n.scopecode AS scope,
            n.messageText AS message,n.authorrolesnapshot AS "authorRole",
            u.displayname AS "authorName",u.username AS "authorUsername",n.createdat AS "createdAt",
            i.iterationno AS "iterationNo",t.stagecode AS "stageCode"
       FROM egas_workflownote n
       JOIN egas_useraccount u ON u.id=n.authoruser_id
       JOIN egas_workflowiteration i ON i.id=n.iteration_id
       LEFT JOIN egas_stagetask t ON t.id=n.stagetask_id
      WHERE n.request_id=$1 ORDER BY n.createdat,n.id`, [requestId]
  )
  const signoffs = await db.query<Record<string, unknown>>(
    `SELECT s.id,s.stagecode AS "stageCode",s.signeruser_id AS "signerUserId",
            s.signerrolesnapshot AS "signerRole",s.signernamesnapshot AS "signerName",
            s.signerjobtitlesnapshot AS "signerJobTitle",s.signatureasset_id AS "signatureAssetId",
            s.signaturesha256snapshot AS "signatureSha256",s.signedat AS "signedAt"
       FROM egas_workflowsignoff s
      WHERE s.request_id=$1 AND s.iteration_id=$2 ORDER BY s.signedat,s.id`, [requestId, iterationId]
  )
  const approvals = await db.query<Record<string, unknown>>(
    `SELECT a.id,a.actioncode AS "actionCode",a.actorrolesnapshot AS "actorRole",a.reason,
            u.displayname AS "actorName",u.username AS "actorUsername",a.createdat AS "createdAt"
       FROM egas_stageaction a JOIN egas_useraccount u ON u.id=a.actoruser_id
      WHERE a.request_id=$1 AND a.iteration_id=$2
      ORDER BY a.createdat,a.id`, [requestId, iterationId]
  )

  const positionByCandidate = new Map<string, Record<string, unknown>[]>()
  for (const position of positions.rows) {
    const candidateId = String(position.candidateId)
    positionByCandidate.set(candidateId, [...(positionByCandidate.get(candidateId) ?? []), {
      ...position, createdAt: iso(position.createdAt as Date | string)
    }])
  }
  const decisionByCandidate = new Map(decisions.rows.map(decision => [String(decision.candidateId), {
    ...decision, decidedAt: iso(decision.decidedAt as Date | string)
  }]))
  const notesByCandidate = new Map<string, Record<string, unknown>[]>()
  const requestNotes: Record<string, unknown>[] = []
  for (const note of notes.rows) {
    const view = { ...note, createdAt: iso(note.createdAt as Date | string) }
    if (note.candidateId) {
      const candidateId = String(note.candidateId)
      notesByCandidate.set(candidateId, [...(notesByCandidate.get(candidateId) ?? []), view])
    } else requestNotes.push(view)
  }

  const requestView = { ...request.rows[0], createdAt: iso(request.rows[0].createdAt as Date | string),
    completedAt: iso(request.rows[0].completedAt as Date | string | null) }
  return {
    schemaVersion: 1,
    kind,
    capturedAt: iso(clock.rows[0]!.capturedAt)!,
    task,
    request: requestView,
    candidates: candidates.rows.map(candidate => ({
      ...candidate,
      positions: positionByCandidate.get(String(candidate.id)) ?? [],
      promotionDecision: decisionByCandidate.get(String(candidate.id)) ?? null,
      notes: notesByCandidate.get(String(candidate.id)) ?? []
    })),
    signoffs: signoffs.rows.map(signoff => ({ ...signoff, signedAt: iso(signoff.signedAt as Date | string) })),
    approvals: approvals.rows.map(approval => ({ ...approval, createdAt: iso(approval.createdAt as Date | string) })),
    requestNotes
  }
}

export async function captureReceivedSnapshot(
  db: Queryable,
  input: { taskId: string, requestId: string, iterationId: string, stageCode: WorkflowStage, recipientUserId: string, recipientRole: Role }
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM egas_stagereceivedsnapshot WHERE stagetask_id=$1`, [input.taskId]
  )
  if (existing.rows[0]) return existing.rows[0].id
  const snapshot = await buildFormSnapshot(db, input.requestId, input.iterationId, 'RECEIVED', {
    id: input.taskId, stageCode: input.stageCode, recipientUserId: input.recipientUserId, recipientRole: input.recipientRole
  })
  const id = randomUUID()
  await db.query(
    `INSERT INTO egas_stagereceivedsnapshot
      (id,stagetask_id,request_id,iteration_id,recipientuser_id,recipientrolesnapshot,
       snapshotjson,snapshotsha256,templateversion,receivedat)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [id, input.taskId, input.requestId, input.iterationId, input.recipientUserId, input.recipientRole,
      snapshotJson(snapshot), snapshotSha256(snapshot), PDF_TEMPLATE_VERSION, snapshot.capturedAt]
  )
  return id
}

export async function freezeFinalSnapshot(db: Queryable, requestId: string, iterationId: string): Promise<string> {
  const migration = await db.query(`SELECT 1 FROM egas_schemamigration WHERE version='006_pdf_evidence_freeze'`)
  if (!migration.rows[0]) throw new AppError(409, 'PDF evidence migration is required', 'PDF_MIGRATION_REQUIRED')
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM egas_frozenpdfdocument WHERE request_id=$1 AND iteration_id=$2 AND documentstate='FINAL'`,
    [requestId, iterationId]
  )
  if (existing.rows[0]) return existing.rows[0].id
  const snapshot = await buildFormSnapshot(db, requestId, iterationId, 'FINAL', null)
  const id = randomUUID()
  await db.query(
    `INSERT INTO egas_frozenpdfdocument
      (id,request_id,iteration_id,documentstate,stagereceivedsnapshot_id,snapshotjson,
       snapshotsha256,templateversion,frozenat)
     VALUES ($1,$2,$3,'FINAL',NULL,$4::jsonb,$5,$6,$7)`,
    [id, requestId, iterationId, snapshotJson(snapshot), snapshotSha256(snapshot), PDF_TEMPLATE_VERSION, snapshot.capturedAt]
  )
  return id
}
