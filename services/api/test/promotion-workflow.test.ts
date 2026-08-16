import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import { PromotionService } from '../src/modules/workflow/promotion-service.ts'
import { TaskService } from '../src/modules/workflow/task-service.ts'
import { WorkflowService } from '../src/modules/workflow/workflow-service.ts'
import { WorkflowControlService } from '../src/modules/workflow/workflow-control-service.ts'
import { isolatedPool } from './helpers/database.ts'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'promotion' }
let pool: Pool; let workflow: WorkflowService; let promotion: PromotionService; let tasks: TaskService
let controls: WorkflowControlService
let ea: AuthContext; let organization: AuthContext; let authority: AuthContext

async function user(username: string, role: NonNullable<AuthContext['activeRole']>): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,staffidentifier,displayname,jobtitle,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$3,$2,'وظيفة','synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [userId, username, `S-${username}`])
  await pool.query(`INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat) VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId, role])
  return { userId, username, sessionId: randomUUID(), activeRole: role, roleAssignmentId: roleId, canManageAdmins: false, mustChangePassword: false }
}

async function prepare(): Promise<{ requestId: string, candidateId: string }> {
  const unit = (await pool.query<{ id: string, name: string }>(`SELECT id,namear AS name FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 1`)).rows[0]!
  const batchId = randomUUID(); const employeeId = randomUUID()
  await pool.query(
    `INSERT INTO egas_importbatch
      (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,importedat,status,totalrows,validrows,warningrows,blockedrows)
     VALUES ($1,2026,'promotion.xlsx',$2,TRUE,'[]'::jsonb,CURRENT_TIMESTAMP,'ACTIVATED',1,1,0,0)`, [batchId, 'e'.repeat(64)])
  await pool.query(`INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,'200',CURRENT_TIMESTAMP)`, [employeeId])
  await pool.query(
    `INSERT INTO egas_employeeannualsnapshot
      (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,subgroup,sourceroutingunit,routingunit_id,currentjobtitle,performancerating,sourcerownumber,createdat)
     VALUES ($1,$2,$3,2026,'200','مرشح ترقية','مجموعة',$4,$5,'وظيفة حالية','ممتاز',2,CURRENT_TIMESTAMP)`,
    [randomUUID(), employeeId, batchId, unit.name, unit.id])
  const assignmentId = randomUUID()
  await pool.query(
    `INSERT INTO egas_approvingauthorityassignment
      (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,validfrom,isactive,configuredby_id,createdat,updatedat,version)
     VALUES ($1,$2,$3,'DEPUTY','نائب',TRUE,CURRENT_DATE,TRUE,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
    [assignmentId, unit.id, authority.userId, ea.userId])
  const request = await workflow.create({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }, ea, evidence)
  const detail = await workflow.addCandidate(request.id, '200', ea, evidence)
  await workflow.selectAuthority(request.id, assignmentId, ea, evidence)
  return { requestId: request.id as string, candidateId: (detail.candidates as Array<{ id: string }>)[0]!.id }
}

async function sign(requestId: string, stage: 'P1'|'P2', signer: AuthContext, char: string): Promise<void> {
  const current = (await pool.query<{ iterationId: string, taskId: string }>(
    `SELECT i.id AS "iterationId",t.id AS "taskId" FROM egas_workflowiteration i JOIN egas_stagetask t ON t.iteration_id=i.id
     WHERE i.request_id=$1 AND t.stagecode=$2`, [requestId, stage])).rows[0]!
  const assetId = randomUUID(); const hash = char.repeat(64)
  await pool.query(
    `INSERT INTO egas_usersignatureasset
      (id,user_id,storagekey,mimetype,filesizebytes,widthpx,heightpx,filesha256,isactive,uploadedat)
     VALUES ($1,$2,$3,'image/png',100,20,10,$4,TRUE,CURRENT_TIMESTAMP)`, [assetId, signer.userId, `test/${assetId}.png`, hash])
  await pool.query(
    `INSERT INTO egas_workflowsignoff
      (id,request_id,iteration_id,stagetask_id,stagecode,signeruser_id,signerrolesnapshot,signernamesnapshot,
       signerjobtitlesnapshot,jobtitlewasoverridden,signatureasset_id,signaturesha256snapshot,signedat,createdat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'وظيفة',FALSE,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), requestId, current.iterationId, current.taskId, stage, signer.userId, signer.activeRole, signer.username, assetId, hash])
}

beforeEach(async () => {
  pool = await isolatedPool(); workflow = new WorkflowService(pool); promotion = new PromotionService(pool); tasks = new TaskService(pool); controls = new WorkflowControlService(pool)
  ea = await user('promotion-ea', 'EMPLOYEE_AFFAIRS'); organization = await user('promotion-org', 'ORGANIZATION'); authority = await user('promotion-authority', 'APPROVING_AUTHORITY')
})
afterEach(async () => { await pool.end() })

describe('Promotion P1-P5 workflow', () => {
  it('keeps preparation with Organization and the same/other decision with the authority', async () => {
    const prepared = await prepare(); await sign(prepared.requestId, 'P1', ea, 'f')
    await promotion.submitP1(prepared.requestId, ea, evidence)
    const queue = await tasks.organizationQueue(organization, 0, 10); await tasks.claim(queue[0]!.taskId, organization, evidence)
    await promotion.prepareCandidate(prepared.requestId, prepared.candidateId, { jobCategoryCode: 'SECTION_HEAD', lastPromotionReport: 'تقرير يدوي' }, organization, evidence)
    expect(await promotion.decisions(prepared.requestId, organization)).toHaveLength(0)
    await sign(prepared.requestId, 'P2', organization, '1'); await promotion.submitP2(prepared.requestId, organization, evidence)
    await promotion.approveP3(prepared.requestId, ea, evidence)

    await expect(promotion.decide(prepared.requestId, prepared.candidateId, { decisionType: 'OTHER_POSITION', targetJobTitle: '', notes: null }, authority, evidence)).rejects.toMatchObject({ status: 400 })
    await promotion.decide(prepared.requestId, prepared.candidateId, { decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة مستهدفة', notes: 'قرار الاختبار' }, authority, evidence)
    await promotion.approveP4(prepared.requestId, authority, evidence)
    await expect(promotion.approveP5(prepared.requestId, ea, evidence)).resolves.toMatchObject({ status: 'COMPLETED' })

    const stored = (await promotion.decisions(prepared.requestId, ea))[0]
    expect(stored).toMatchObject({ decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة مستهدفة' })
    expect((await pool.query(`SELECT currentstage,status FROM egas_workflowrequest WHERE id=$1`, [prepared.requestId])).rows[0]).toEqual({ currentstage: 'P5', status: 'COMPLETED' })
    expect((await pool.query(`SELECT documentstate FROM egas_frozenpdfdocument WHERE request_id=$1`, [prepared.requestId])).rows)
      .toEqual([{ documentstate: 'FINAL' }])
  })

  it('returns to the originating EA and restarts as iteration 2 without deleting iteration 1', async () => {
    const prepared = await prepare(); await sign(prepared.requestId, 'P1', ea, '2'); await promotion.submitP1(prepared.requestId, ea, evidence)
    const queue = await tasks.organizationQueue(organization, 0, 10); await tasks.claim(queue[0]!.taskId, organization, evidence)
    await expect(controls.returnOrReject(prepared.requestId, 'RETURN', '', organization, evidence)).rejects.toMatchObject({ status: 400 })
    await controls.returnOrReject(prepared.requestId, 'RETURN', 'تحتاج البيانات إلى تصحيح', organization, evidence)
    expect(await workflow.detail(prepared.requestId, ea)).toMatchObject({ status: 'RETURNED', currentStage: 'P1', currentIterationNo: 1 })

    await controls.restart(prepared.requestId, 'تم التصحيح', ea, evidence)
    expect(await workflow.detail(prepared.requestId, ea)).toMatchObject({ status: 'DRAFT', currentStage: 'P1', currentIterationNo: 2, candidateCount: 1 })
    const iterations = await pool.query(`SELECT iterationno,status,parentiteration_id FROM egas_workflowiteration WHERE request_id=$1 ORDER BY iterationno`, [prepared.requestId])
    expect(iterations.rows).toHaveLength(2)
    expect(iterations.rows[0]).toMatchObject({ iterationno: 1, status: 'RETURNED' })
    expect(iterations.rows[1]).toMatchObject({ iterationno: 2, status: 'ACTIVE', parentiteration_id: expect.any(String) })
    expect((await pool.query(`SELECT reason FROM egas_stageaction WHERE request_id=$1 AND actioncode='WORKFLOW_RETURNED_FOR_CORRECTION'`, [prepared.requestId])).rows[0]).toEqual({ reason: 'تحتاج البيانات إلى تصحيح' })
  })

  it('recalls a non-final request into a new iteration', async () => {
    const recalled = await prepare(); await sign(recalled.requestId, 'P1', ea, '3'); await promotion.submitP1(recalled.requestId, ea, evidence)
    await controls.recall(recalled.requestId, 'استدعاء للتصحيح', ea, evidence)
    expect(await workflow.detail(recalled.requestId, ea)).toMatchObject({ status: 'DRAFT', currentStage: 'P1', currentIterationNo: 2 })
    expect((await pool.query(`SELECT taskstatus FROM egas_stagetask t JOIN egas_workflowiteration i ON i.id=t.iteration_id WHERE i.request_id=$1 AND i.iterationno=1 AND t.stagecode='P2'`, [recalled.requestId])).rows[0]).toEqual({ taskstatus: 'CANCELLED' })

  })

  it('allows the originating EA to cancel a rejected request without reopening it', async () => {
    const rejected = await prepare(); await sign(rejected.requestId, 'P1', ea, '4'); await promotion.submitP1(rejected.requestId, ea, evidence)
    const queue = (await tasks.organizationQueue(organization, 0, 10)).find(item => item.requestId === rejected.requestId)!
    await tasks.claim(queue.taskId, organization, evidence)
    await controls.returnOrReject(rejected.requestId, 'REJECT', 'سبب الرفض', organization, evidence)
    await controls.cancelReturned(rejected.requestId, 'إلغاء بواسطة المنشئ', ea, evidence)
    expect(await workflow.detail(rejected.requestId, ea)).toMatchObject({ status: 'CANCELLED' })
    await expect(controls.recall(rejected.requestId, 'محاولة فتح', ea, evidence)).rejects.toMatchObject({ code: 'WORKFLOW_ACTION_NOT_ALLOWED' })
  })
})
