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
let otherOrganization: AuthContext
let activeRoutingUnits: Array<{ id: string, name: string }>

async function user(username: string, role: NonNullable<AuthContext['activeRole']>): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,staffidentifier,displayname,jobtitle,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$3,$2,'وظيفة','synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [userId, username, `S-${username}`])
  await pool.query(`INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat) VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId, role])
  return { userId, username, sessionId: randomUUID(), activeRole: role, roleAssignmentId: roleId, canManageAdmins: false, mustChangePassword: false }
}

  async function prepare(candidatePersonnelNumbers: string[] = ['200']): Promise<{ requestId: string, candidateIds: string[], routingUnitId: string }> {
    const unit = activeRoutingUnits[0]!
    const batchId = randomUUID()
    await pool.query(
      `INSERT INTO egas_importbatch
       (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,importedat,status,totalrows,validrows,warningrows,blockedrows)
      VALUES ($1,2026,'promotion.xlsx',$2,TRUE,'[]'::jsonb,CURRENT_TIMESTAMP,'ACTIVATED',$3,$3,0,0)`, [batchId, 'e'.repeat(64), candidatePersonnelNumbers.length])
    for (const [index, personnelNumber] of candidatePersonnelNumbers.entries()) {
      const currentEmployeeId = randomUUID()
      // Use a unique personnel number per candidate to avoid pkey/unique violations if the test setup is reused or overlapping
      const uniquePersonnelNumber = `${personnelNumber}_${index}_${randomUUID().substring(0, 8)}`
      await pool.query(`INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,$2,CURRENT_TIMESTAMP)`, [currentEmployeeId, uniquePersonnelNumber])
      await pool.query(
        `INSERT INTO egas_employeeannualsnapshot
          (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,subgroup,sourceroutingunit,routingunit_id,currentjobtitle,performancerating,sourcerownumber,createdat)
         VALUES ($1,$2,$3,2026,$4,$5,'مجموعة',$6,$7,'وظيفة حالية','ممتاز',$8,CURRENT_TIMESTAMP)`,
        [randomUUID(), currentEmployeeId, batchId, uniquePersonnelNumber, `مرشح ${uniquePersonnelNumber}`, unit.name, unit.id, index + 2])
    }
    const assignmentId = randomUUID()
    await pool.query(
      `INSERT INTO egas_approvingauthorityassignment
       (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,validfrom,isactive,configuredby_id,createdat,updatedat,version)
      VALUES ($1,$2,$3,'DEPUTY','نائب',TRUE,CURRENT_DATE,TRUE,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      [assignmentId, unit.id, authority.userId, ea.userId])
    const request = await workflow.create({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }, ea, evidence)
    // Since we modified personnel numbers above, we need to use the modified ones here
    const results = await pool.query<{ personnelnumber: string }>(`SELECT personnelnumber FROM egas_employeeannualsnapshot WHERE importbatch_id=$1`, [batchId])
    for (const row of results.rows) {
      await workflow.addCandidate(request.id, row.personnelnumber, ea, evidence)
    }
    const detail = await workflow.detail(request.id, ea)
    await workflow.selectAuthority(request.id, assignmentId, ea, evidence)
    return {
      requestId: request.id as string,
      candidateIds: (detail.candidates as Array<{ id: string }>).map(candidate => candidate.id),
      routingUnitId: unit.id
    }
  }

async function toP4(prepared: { requestId: string, candidateIds: string[] }): Promise<void> {
  await sign(prepared.requestId, 'P1', ea, 'f')
  await promotion.submitP1(prepared.requestId, ea, evidence)
  const queue = (await tasks.organizationQueue(organization, 0, 20)).find(item => item.requestId === prepared.requestId)!
  await tasks.claim(queue.taskId, organization, evidence)
  for (const candidateId of prepared.candidateIds) {
    await promotion.prepareCandidate(prepared.requestId, candidateId, {
      jobCategoryCode: 'SECTION_HEAD',
      lastPromotionReport: 'تقرير يدوي'
    }, organization, evidence)
  }
  await sign(prepared.requestId, 'P2', organization, '1')
  await promotion.submitP2(prepared.requestId, organization, evidence)
  await promotion.approveP3(prepared.requestId, ea, evidence)
}

async function sign(requestId: string, stage: 'P1'|'P2', signer: AuthContext, char: string): Promise<void> {
  const current = (await pool.query<{ iterationId: string, taskId: string }>(
    `SELECT i.id AS "iterationId",t.id AS "taskId" FROM egas_workflowiteration i JOIN egas_stagetask t ON t.iteration_id=i.id
     WHERE i.request_id=$1 AND t.stagecode=$2`, [requestId, stage])).rows[0]!
  const assetId = randomUUID(); const hash = char.repeat(64)
  await pool.query(
    `INSERT INTO egas_usersignatureasset
     (id,user_id,storagekey,mimetype,filesizebytes,widthpx,heightpx,filesha256,isactive,uploadedat)
    VALUES ($1,$2,$3,'image/png',100,20,10,$4,TRUE,CURRENT_TIMESTAMP)
     ON CONFLICT (filesha256) DO NOTHING`, [assetId, signer.userId, `test/${assetId}.png`, hash])
  // Ensure the asset is present (either just inserted or already existed)
  const asset = (await pool.query<{ id: string }>(`SELECT id FROM egas_usersignatureasset WHERE filesha256=$1`, [hash])).rows[0]!
  await pool.query(
    `INSERT INTO egas_workflowsignoff
     (id,request_id,iteration_id,stagetask_id,stagecode,signeruser_id,signerrolesnapshot,signernamesnapshot,
      signerjobtitlesnapshot,jobtitlewasoverridden,signatureasset_id,signaturesha256snapshot,signedat,createdat)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'وظيفة',FALSE,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), requestId, current.iterationId, current.taskId, stage, signer.userId, signer.activeRole, signer.username, asset.id, hash])
}

beforeEach(async () => {
  pool = await isolatedPool(); workflow = new WorkflowService(pool); promotion = new PromotionService(pool); tasks = new TaskService(pool); controls = new WorkflowControlService(pool)
  ea = await user('promotion-ea', 'EMPLOYEE_AFFAIRS'); organization = await user('promotion-org', 'ORGANIZATION'); authority = await user('promotion-authority', 'APPROVING_AUTHORITY')
  otherOrganization = await user('promotion-org-2', 'ORGANIZATION')
  activeRoutingUnits = (await pool.query<{ id: string, name: string }>(
    `SELECT id,namear AS name FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 2`
  )).rows
})
afterEach(async () => { await pool.end() })

describe('Promotion P1-P5 workflow', () => {
  it('routes SAME_POSITION from P4 directly to P5', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'SAME_POSITION', targetJobTitle: 'يجب تجاهلها', targetRoutingUnitId: activeRoutingUnits[1]?.id, notes: 'قرار'
    }, authority, evidence)
    await expect(promotion.approveP4(prepared.requestId, authority, evidence)).resolves.toMatchObject({ currentStage: 'P5' })
  })

  it('routes OTHER_POSITION with same routing unit from P4 directly to P5', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION',
      targetJobTitle: 'وظيفة مستهدفة',
      targetRoutingUnitId: prepared.routingUnitId,
      notes: 'نفس وحدة المسار'
    }, authority, evidence)
    await expect(promotion.approveP4(prepared.requestId, authority, evidence)).resolves.toMatchObject({ currentStage: 'P5' })
  })

  it('routes OTHER_POSITION with different routing unit from P4 to P4O', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION',
      targetJobTitle: 'وظيفة خارج الوحدة',
      targetRoutingUnitId: activeRoutingUnits[1]!.id,
      notes: 'تحويل للتنظيم'
    }, authority, evidence)
    const advanced = await promotion.approveP4(prepared.requestId, authority, evidence)
    expect(advanced).toMatchObject({ currentStage: 'P4O' })
    const queue = await tasks.organizationQueue(organization, 0, 20)
    expect(queue.find(item => item.requestId === prepared.requestId)).toMatchObject({ stageCode: 'P4O' })
  })

  it('sends whole request to P4O when any candidate is cross-routing-unit', async () => {
    const prepared = await prepare(['200', '201'])
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'نفس الوحدة', targetRoutingUnitId: prepared.routingUnitId, notes: null
    }, authority, evidence)
    await promotion.decide(prepared.requestId, prepared.candidateIds[1], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وحدة أخرى', targetRoutingUnitId: activeRoutingUnits[1]!.id, notes: null
    }, authority, evidence)
    await expect(promotion.approveP4(prepared.requestId, authority, evidence)).resolves.toMatchObject({ currentStage: 'P4O' })
  })

  it('rejects invalid OTHER_POSITION routing targets', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await expect(promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة', notes: null
    }, authority, evidence)).rejects.toMatchObject({ status: 400 })
    await expect(promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة', targetRoutingUnitId: randomUUID(), notes: null
    }, authority, evidence)).rejects.toMatchObject({ status: 400, code: 'WORKFLOW_TARGET_ROUTING_INVALID' })

    const inactiveUnitId = randomUUID()
    await pool.query(
      `INSERT INTO egas_routingunit (id,namear,code,isactive,createdat,updatedat)
       VALUES ($1,'وحدة غير نشطة','INACTIVE_PROMO',FALSE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [inactiveUnitId]
    )
    await expect(promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة', targetRoutingUnitId: inactiveUnitId, notes: null
    }, authority, evidence)).rejects.toMatchObject({ status: 400, code: 'WORKFLOW_TARGET_ROUTING_INVALID' })
  })

  it('supports P4O queue/claim/confirm and captures received snapshot on claim', async () => {
  const prepared = await prepare()
  await toP4(prepared)

  const targetRoutingUnitId = activeRoutingUnits[1]!.id

  expect(targetRoutingUnitId).not.toBe(prepared.routingUnitId)

  await promotion.decide(
    prepared.requestId,
    prepared.candidateIds[0],
    {
      decisionType: 'OTHER_POSITION',
      targetJobTitle: 'وظيفة خارج الوحدة',
      targetRoutingUnitId,
      notes: 'اختبار'
    },
    authority,
    evidence
  )

  await promotion.approveP4(prepared.requestId, authority, evidence)

  const queue = await tasks.organizationQueue(organization, 0, 20)
  const task = queue.find(item => item.requestId === prepared.requestId)!

  expect(task).toMatchObject({
    stageCode: 'P4O',
    claimable: true
  })

  const claimOutcomes = await Promise.allSettled([
    tasks.claim(task.taskId, organization, evidence),
    tasks.claim(task.taskId, otherOrganization, evidence)
  ])

  expect(
    claimOutcomes.filter(outcome => outcome.status === 'fulfilled')
  ).toHaveLength(1)

  expect(
    claimOutcomes.filter(outcome => outcome.status === 'rejected')
  ).toHaveLength(1)

  const snapshot = (
    await pool.query<{ snapshotJson: Record<string, unknown> }>(
      `SELECT snapshotjson AS "snapshotJson"
         FROM egas_stagereceivedsnapshot
        WHERE stagetask_id=$1`,
      [task.taskId]
    )
  ).rows[0]

  expect(snapshot).toBeDefined()

  const firstCandidate = (
    snapshot!.snapshotJson.candidates as Array<{
      promotionDecision: Record<string, unknown>
    }>
  )[0]!

  expect(firstCandidate.promotionDecision).toMatchObject({
    targetRoutingUnitId,
    targetRoutingUnitName: activeRoutingUnits[1]!.name
  })

  await expect(
    promotion.confirmP4O(prepared.requestId, organization, evidence)
  ).resolves.toMatchObject({
    currentStage: 'P5'
  })

  await expect(
    promotion.approveP5(prepared.requestId, ea, evidence)
  ).resolves.toMatchObject({
    status: 'COMPLETED'
  })

  expect(
    (
      await pool.query(
        `SELECT documentstate
           FROM egas_frozenpdfdocument
          WHERE request_id=$1`,
        [prepared.requestId]
      )
    ).rows
  ).toEqual([{ documentstate: 'FINAL' }])
})


  it('blocks unclaimed P4O confirmation and blocks Organization from editing authority decision', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة خارج الوحدة', targetRoutingUnitId: activeRoutingUnits[1]!.id, notes: null
    }, authority, evidence)
    await promotion.approveP4(prepared.requestId, authority, evidence)
    await expect(promotion.confirmP4O(prepared.requestId, organization, evidence)).rejects.toMatchObject({ status: 404 })

    const queue = (await tasks.organizationQueue(organization, 0, 20)).find(item => item.requestId === prepared.requestId)!
    await tasks.claim(queue.taskId, organization, evidence)
    await expect(promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'SAME_POSITION', targetJobTitle: null, targetRoutingUnitId: null, notes: 'محاولة تعديل'
    }, organization, evidence)).rejects.toMatchObject({ status: 404 })
  })

  it('allows return from P4O and forbids reject at P4O', async () => {
    const prepared = await prepare()
    await toP4(prepared)
    await promotion.decide(prepared.requestId, prepared.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة خارج الوحدة', targetRoutingUnitId: activeRoutingUnits[1]!.id, notes: null
    }, authority, evidence)
    await promotion.approveP4(prepared.requestId, authority, evidence)
    const queue = (await tasks.organizationQueue(organization, 0, 20)).find(item => item.requestId === prepared.requestId)!
    await tasks.claim(queue.taskId, organization, evidence)

    await expect(controls.returnOrReject(prepared.requestId, 'RETURN', 'تصحيح تنظيمي', organization, evidence)).resolves.toMatchObject({
      status: 'RETURNED',
      currentStage: 'P1'
    })

    const prepared2 = await prepare()
    await toP4(prepared2)
    await promotion.decide(prepared2.requestId, prepared2.candidateIds[0], {
      decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة خارج الوحدة', targetRoutingUnitId: activeRoutingUnits[1]!.id, notes: null
    }, authority, evidence)
    await promotion.approveP4(prepared2.requestId, authority, evidence)
    const queue2 = (await tasks.organizationQueue(organization, 0, 20)).find(item => item.requestId === prepared2.requestId)!
    await tasks.claim(queue2.taskId, organization, evidence)
    await expect(controls.returnOrReject(prepared2.requestId, 'REJECT', 'رفض غير مسموح هنا', organization, evidence)).rejects.toMatchObject({
      status: 409,
      code: 'WORKFLOW_ACTION_NOT_ALLOWED'
    })
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
