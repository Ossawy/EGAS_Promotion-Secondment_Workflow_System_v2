import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import { SecondmentService } from '../src/modules/workflow/secondment-service.ts'
import { TaskService } from '../src/modules/workflow/task-service.ts'
import { WorkflowService } from '../src/modules/workflow/workflow-service.ts'
import { isolatedPool } from './helpers/database.ts'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'secondment' }
let pool: Pool
let workflow: WorkflowService
let secondment: SecondmentService
let tasks: TaskService
let ea: AuthContext
let organization: AuthContext
let authority: AuthContext

async function user(username: string, role: NonNullable<AuthContext['activeRole']>): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,staffidentifier,displayname,jobtitle,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$3,$2,$4,'synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [userId, username, `S-${username}`, `وظيفة ${username}`])
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId, role])
  return { userId, username, sessionId: randomUUID(), activeRole: role, roleAssignmentId: roleId, canManageAdmins: false, mustChangePassword: false }
}

async function prepare(): Promise<{ requestId: string, candidateId: string }> {
  const unit = (await pool.query<{ id: string, name: string }>(
    `SELECT id,namear AS name FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 1`)).rows[0]!
  const batchId = randomUUID(); const employeeId = randomUUID(); const snapshotId = randomUUID()
  await pool.query(
    `INSERT INTO egas_importbatch
      (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,importedat,status,totalrows,validrows,warningrows,blockedrows)
     VALUES ($1,2026,'secondment.xlsx',$2,TRUE,'[]'::jsonb,CURRENT_TIMESTAMP,'ACTIVATED',1,1,0,0)`, [batchId, 'd'.repeat(64)])
  await pool.query(`INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,'100',CURRENT_TIMESTAMP)`, [employeeId])
  await pool.query(
    `INSERT INTO egas_employeeannualsnapshot
      (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,subgroup,sourceroutingunit,routingunit_id,currentjobtitle,performancerating,sourcerownumber,createdat)
     VALUES ($1,$2,$3,2026,'100','عامل اختبار','مجموعة',$4,$5,'وظيفة حالية','ممتاز',2,CURRENT_TIMESTAMP)`,
    [snapshotId, employeeId, batchId, unit.name, unit.id])
  const assignmentId = randomUUID()
  await pool.query(
    `INSERT INTO egas_approvingauthorityassignment
      (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,validfrom,isactive,configuredby_id,createdat,updatedat,version)
     VALUES ($1,$2,$3,'DEPUTY','نائب',TRUE,CURRENT_DATE,TRUE,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
    [assignmentId, unit.id, authority.userId, ea.userId])
  const request = await workflow.create({ requestType: 'SECONDMENT', cycleYear: 2026, formMonth: 8, formYear: 2026 }, ea, evidence)
  const withCandidate = await workflow.addCandidate(request.id, '100', ea, evidence)
  await workflow.selectAuthority(request.id, assignmentId, ea, evidence)
  return { requestId: request.id as string, candidateId: (withCandidate.candidates as Array<{ id: string }>)[0]!.id }
}

async function sign(requestId: string, stage: 'S1'|'S2', signer: AuthContext, hashCharacter: string): Promise<void> {
  const current = (await pool.query<{ iterationId: string, taskId: string }>(
    `SELECT i.id AS "iterationId",t.id AS "taskId" FROM egas_workflowiteration i
     JOIN egas_stagetask t ON t.iteration_id=i.id WHERE i.request_id=$1 AND t.stagecode=$2`, [requestId, stage])).rows[0]!
  const assetId = randomUUID(); const hash = hashCharacter.repeat(64)
  await pool.query(
    `INSERT INTO egas_usersignatureasset
      (id,user_id,storagekey,mimetype,filesizebytes,widthpx,heightpx,filesha256,isactive,uploadedat)
     VALUES ($1,$2,$3,'image/png',100,20,10,$4,TRUE,CURRENT_TIMESTAMP)`,
    [assetId, signer.userId, `test/${assetId}.png`, hash])
  await pool.query(
    `INSERT INTO egas_workflowsignoff
      (id,request_id,iteration_id,stagetask_id,stagecode,signeruser_id,signerrolesnapshot,
       signernamesnapshot,signerjobtitlesnapshot,jobtitlewasoverridden,signatureasset_id,
       signaturesha256snapshot,signedat,createdat)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'اختبار',FALSE,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [randomUUID(), requestId, current.iterationId, current.taskId, stage, signer.userId, signer.activeRole,
      signer.username, assetId, hash])
}

beforeEach(async () => {
  pool = await isolatedPool(); workflow = new WorkflowService(pool); secondment = new SecondmentService(pool); tasks = new TaskService(pool)
  ea = await user('secondment-ea', 'EMPLOYEE_AFFAIRS')
  organization = await user('secondment-org', 'ORGANIZATION')
  authority = await user('secondment-authority', 'APPROVING_AUTHORITY')
})
afterEach(async () => { await pool.end() })

describe('Secondment S1-S5 workflow', () => {
  it('requires signoffs and carries one selected Organization position per candidate through S5', async () => {
    const prepared = await prepare()
    await expect(secondment.submitS1(prepared.requestId, ea, evidence)).rejects.toMatchObject({ code: 'WORKFLOW_SIGNOFF_REQUIRED' })
    await sign(prepared.requestId, 'S1', ea, 'a')
    await expect(secondment.submitS1(prepared.requestId, ea, evidence)).resolves.toMatchObject({ currentStage: 'S2' })

    const queue = await tasks.organizationQueue(organization, 0, 10)
    expect(queue).toHaveLength(1)
    await tasks.claim(queue[0]!.taskId, organization, evidence)
    await secondment.setCandidateCategory(prepared.requestId, prepared.candidateId, 'MANAGER_DEPARTMENT', organization, evidence)
    await secondment.addPosition(prepared.requestId, prepared.candidateId, {
      positionTitle: 'وظيفة مقترحة', organizationalDependency: 'التبعية التنظيمية', qualificationStatus: 'QUALIFIED'
    }, organization, evidence)
    await expect(secondment.submitS2(prepared.requestId, organization, evidence)).rejects.toMatchObject({ code: 'WORKFLOW_SIGNOFF_REQUIRED' })
    await sign(prepared.requestId, 'S2', organization, 'b')
    await expect(secondment.submitS2(prepared.requestId, organization, evidence)).resolves.toMatchObject({ currentStage: 'S3' })

    expect(await tasks.authorityQueue(authority, 0, 10)).toHaveLength(1)
    const positions = await secondment.positions(prepared.requestId, authority)
    await expect(secondment.approveS3(prepared.requestId, authority, evidence)).rejects.toMatchObject({ code: 'WORKFLOW_SELECTION_INCOMPLETE' })
    await secondment.selectPosition(prepared.requestId, prepared.candidateId, positions[0]!.id, authority, evidence)
    await expect(secondment.approveS3(prepared.requestId, authority, evidence)).resolves.toMatchObject({ currentStage: 'S4' })
    await expect(secondment.confirmS4(prepared.requestId, organization, evidence)).resolves.toMatchObject({ currentStage: 'S5' })
    await expect(secondment.approveS5(prepared.requestId, ea, evidence)).resolves.toMatchObject({ status: 'COMPLETED' })

    expect((await workflow.detail(prepared.requestId, ea)).status).toBe('COMPLETED')
    expect((await pool.query(`SELECT documentstate,snapshotsha256 FROM egas_frozenpdfdocument WHERE request_id=$1`, [prepared.requestId])).rows)
      .toEqual([{ documentstate: 'FINAL', snapshotsha256: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect((await pool.query(`SELECT stagecode,taskstatus FROM egas_stagetask ORDER BY openedat`)).rows).toEqual([
      { stagecode: 'S1', taskstatus: 'COMPLETED' }, { stagecode: 'S2', taskstatus: 'COMPLETED' },
      { stagecode: 'S3', taskstatus: 'COMPLETED' }, { stagecode: 'S4', taskstatus: 'COMPLETED' },
      { stagecode: 'S5', taskstatus: 'COMPLETED' }
    ])
  })

  it('serializes duplicate S1 submission so only one S2 task is created', async () => {
    const prepared = await prepare(); await sign(prepared.requestId, 'S1', ea, 'c')
    const outcomes = await Promise.allSettled([
      secondment.submitS1(prepared.requestId, ea, evidence), secondment.submitS1(prepared.requestId, ea, evidence)
    ])
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect((await pool.query(`SELECT id FROM egas_stagetask WHERE request_id=$1 AND stagecode='S2'`, [prepared.requestId])).rows).toHaveLength(1)
  })
})
