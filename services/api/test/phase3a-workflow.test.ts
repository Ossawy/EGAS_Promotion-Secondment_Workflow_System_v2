import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { RequestEvidence } from '../src/middleware/request-context.js'
import type { AuthContext } from '../src/modules/auth/types.js'
import { NotificationService, createNotification } from '../src/modules/notifications/notification-service.js'
import { TaskService } from '../src/modules/workflow/task-service.js'
import { WorkflowService } from '../src/modules/workflow/workflow-service.js'
import { isolatedPool } from './helpers/database.js'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'phase3a' }
let pool: Pool
let service: WorkflowService
let taskService: TaskService
let unitIds: string[]
let ea: AuthContext
let otherEa: AuthContext
let org: AuthContext
let otherOrg: AuthContext
let authority: AuthContext

async function user(username: string, role: NonNullable<AuthContext['activeRole']>): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,staffidentifier,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$3,$2,'synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [userId, username, `S-${username}`]
  )
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId, role]
  )
  return { userId, username, sessionId: randomUUID(), activeRole: role, roleAssignmentId: roleId,
    canManageAdmins: false, mustChangePassword: false }
}

async function activateSnapshot(rows: Array<{ personnel: string, unitId?: string, rating?: string | null }>): Promise<void> {
  const batchId = randomUUID()
  await pool.query(
    `INSERT INTO egas_importbatch
      (id,snapshotyear,sourcefilename,sourcesha256,headerschemavalidated,detectedheadersjson,
       importedat,status,totalrows,validrows,warningrows,blockedrows)
     VALUES ($1,2026,'phase3a.xlsx',$2,TRUE,'[]'::jsonb,CURRENT_TIMESTAMP,'ACTIVATED',$3,$3,0,0)`,
    [batchId, 'a'.repeat(64), rows.length]
  )
  for (const [index, row] of rows.entries()) {
    const employeeId = randomUUID(); const unitId = row.unitId ?? unitIds[0]!
    const unit = await pool.query<{ name: string }>('SELECT namear AS name FROM egas_routingunit WHERE id=$1', [unitId])
    await pool.query('INSERT INTO egas_employee (id,personnelnumber,createdat) VALUES ($1,$2,CURRENT_TIMESTAMP)', [employeeId, row.personnel])
    await pool.query(
      `INSERT INTO egas_employeeannualsnapshot
        (id,employee_id,importbatch_id,snapshotyear,personnelnumber,employeename,subgroup,
         sourceroutingunit,routingunit_id,currentjobtitle,performancerating,sourceRowNumber,createdat)
       VALUES ($1,$2,$3,2026,$4,$5,'مجموعة',$6,$7,'وظيفة',$8,$9,CURRENT_TIMESTAMP)`,
      [randomUUID(), employeeId, batchId, row.personnel, `موظف ${row.personnel}`, unit.rows[0]!.name,
        unitId, row.rating === undefined ? 'ممتاز' : row.rating, index + 2]
    )
  }
}

async function create(type: 'PROMOTION'|'SECONDMENT' = 'PROMOTION', actor = ea) {
  return await service.create({ requestType: type, cycleYear: 2026, formMonth: 8, formYear: 2026 }, actor, evidence)
}

beforeEach(async () => {
  pool = await isolatedPool(); service = new WorkflowService(pool); taskService = new TaskService(pool)
  unitIds = (await pool.query<{ id: string }>('SELECT id FROM egas_routingunit WHERE isactive=TRUE ORDER BY id LIMIT 2')).rows.map(row => row.id)
  ea = await user('phase3-ea', 'EMPLOYEE_AFFAIRS'); otherEa = await user('phase3-other-ea', 'EMPLOYEE_AFFAIRS')
  org = await user('phase3-org', 'ORGANIZATION'); otherOrg = await user('phase3-other-org', 'ORGANIZATION')
  authority = await user('phase3-authority', 'APPROVING_AUTHORITY')
})
afterEach(async () => { await pool.end() })

describe('Phase 3A request aggregate', () => {
  it('creates Promotion and Secondment roots atomically with P1/S1 task, action, and chained audit', async () => {
    const promotion = await create(); const secondment = await create('SECONDMENT')
    expect(promotion).toMatchObject({ requestType: 'PROMOTION', status: 'DRAFT', currentStage: 'P1', candidateCount: 0, routingUnit: null })
    expect(secondment).toMatchObject({ requestType: 'SECONDMENT', currentStage: 'S1' })
    expect((await pool.query('SELECT id FROM egas_workflowiteration')).rows).toHaveLength(2)
    expect((await pool.query("SELECT stagecode FROM egas_stagetask ORDER BY stagecode")).rows.map(row => row.stagecode)).toEqual(['P1','S1'])
    expect((await pool.query("SELECT id FROM egas_stageaction WHERE actioncode='REQUEST_CREATED'")).rows).toHaveLength(2)
    const audits = await pool.query<{ previoushash: string | null, eventhash: string }>('SELECT previoushash,eventhash FROM egas_auditevent ORDER BY createdat,id')
    expect(audits.rows).toHaveLength(2); expect(audits.rows[0]!.previoushash).toBeNull(); expect(audits.rows[1]!.previoushash).toBe(audits.rows[0]!.eventhash)
  })

  it('fails closed when migration 003 is absent and rolls back the whole aggregate', async () => {
    await pool.query("DELETE FROM egas_schemamigration WHERE version='003_phase3a_workflow_draft_foundation'")
    await expect(create()).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_MIGRATION_REQUIRED' })
    expect((await pool.query('SELECT id FROM egas_workflowrequest')).rows).toHaveLength(0)
  })

  it('limits Employee Affairs to its own requests and validates type/calendar input before persistence', async () => {
    const request = await create(); const id = request.id as string
    await expect(service.detail(id, otherEa)).rejects.toMatchObject({ status: 404 })
    expect(await service.list(ea, 0, 10, 'PROMOTION', 'DRAFT', 2026)).toHaveLength(1)
    expect(await service.list(otherEa, 0, 10, null, null, null)).toHaveLength(0)
  })

  it('refuses candidate selection without an activated annual snapshot', async () => {
    const request = await create()
    await expect(service.addCandidate(request.id, '100', ea, evidence)).rejects.toMatchObject({ status: 409, code: 'ACTIVE_SNAPSHOT_UNAVAILABLE' })
    expect((await pool.query('SELECT id FROM egas_requestcandidate')).rows).toHaveLength(0)
  })

  it('rejects an active-snapshot employee whose routing is unresolved', async () => {
    await activateSnapshot([{ personnel: '100' }])
    await pool.query("UPDATE egas_employeeannualsnapshot SET routingunit_id=NULL WHERE personnelnumber='100'")
    const request = await create()
    await expect(service.addCandidate(request.id, '100', ea, evidence)).rejects.toMatchObject({
      status: 409, code: 'EMPLOYEE_ROUTING_UNRESOLVED'
    })
  })

  it('adds only active-snapshot candidates, freezes employee data, establishes routing, and exposes warnings', async () => {
    await activateSnapshot([{ personnel: '100', rating: 'جيد' }, { personnel: '101', rating: null }])
    const request = await create(); const detail = await service.addCandidate(request.id, '100', ea, evidence)
    expect(detail).toMatchObject({ candidateCount: 1, routingUnit: { id: unitIds[0] } })
    expect((detail.candidates as Array<Record<string, unknown>>)[0]).toMatchObject({
      personnelNumber: '100', snapshotYear: 2026,
      warnings: { performanceRequiresAttention: true, performanceMissing: false }
    })
    await service.addCandidate(request.id, '101', ea, evidence)
    const refreshed = await service.detail(request.id, ea)
    expect((refreshed.candidates as Array<{ warnings: Record<string, boolean> }>)[1]!.warnings).toMatchObject({
      performanceRequiresAttention: false, performanceMissing: true
    })
    const stored = await pool.query('SELECT personnelnumbersnapshot,employeenamesnapshot FROM egas_requestcandidate ORDER BY displayorder')
    expect(stored.rows).toHaveLength(2); expect(stored.rows[0]).toMatchObject({ personnelnumbersnapshot: '100' })
  })

  it('blocks duplicates, employees outside the active snapshot, and mixed routing units', async () => {
    await activateSnapshot([{ personnel: '100' }, { personnel: '200', unitId: unitIds[1]! }])
    const request = await create(); await service.addCandidate(request.id, '100', ea, evidence)
    await expect(service.addCandidate(request.id, '100', ea, evidence)).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_CANDIDATE_DUPLICATE' })
    await expect(service.addCandidate(request.id, '999', ea, evidence)).rejects.toMatchObject({ status: 404, code: 'EMPLOYEE_NOT_IN_ACTIVE_SNAPSHOT' })
    await expect(service.addCandidate(request.id, '200', ea, evidence)).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_ROUTING_MISMATCH' })
    expect((await service.detail(request.id, ea)).candidateCount).toBe(1)
  })

  it('keeps concurrent first-candidate routing establishment consistent', async () => {
    await activateSnapshot([{ personnel: '100' }, { personnel: '200', unitId: unitIds[1]! }])
    const request = await create()
    const outcomes = await Promise.allSettled([
      service.addCandidate(request.id, '100', ea, evidence),
      service.addCandidate(request.id, '200', ea, evidence)
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const final = await service.detail(request.id, ea)
    expect(final.candidateCount).toBe(1)
    const candidates = final.candidates as Array<{ personnelNumber: string }>
    const expectedUnit = candidates[0]!.personnelNumber === '100' ? unitIds[0] : unitIds[1]
    expect((final.routingUnit as { id: string }).id).toBe(expectedUnit)
  })

  it('soft-removes candidates, keeps audit subjects, clears last-candidate routing/authority, and permits re-add', async () => {
    await activateSnapshot([{ personnel: '100' }]); const request = await create(); const added = await service.addCandidate(request.id, '100', ea, evidence)
    const candidate = (added.candidates as Array<{ id: string }>)[0]!
    await service.removeCandidate(request.id, candidate.id, ea, evidence)
    const detail = await service.detail(request.id, ea)
    expect(detail).toMatchObject({ candidateCount: 0, routingUnit: null, approvingAuthority: null })
    expect((await pool.query('SELECT removedat,removedby_id FROM egas_requestcandidate WHERE id=$1', [candidate.id])).rows[0]).toMatchObject({ removedby_id: ea.userId })
    expect((await pool.query("SELECT requestcandidate_id FROM egas_auditevent WHERE actioncode='CANDIDATE_REMOVED'")).rows[0]).toMatchObject({ requestcandidate_id: candidate.id })
    expect((await service.addCandidate(request.id, '100', ea, evidence)).candidateCount).toBe(1)
  })

  it('denies candidate removal to another EA and after the request stops being editable', async () => {
    await activateSnapshot([{ personnel: '100' }]); const request = await create(); const added = await service.addCandidate(request.id, '100', ea, evidence)
    const candidateId = (added.candidates as Array<{ id: string }>)[0]!.id
    await expect(service.removeCandidate(request.id, candidateId, otherEa, evidence)).rejects.toMatchObject({ status: 404 })
    await pool.query("UPDATE egas_workflowrequest SET status='IN_PROGRESS',currentstage='P2' WHERE id=$1", [request.id])
    await expect(service.removeCandidate(request.id, candidateId, ea, evidence)).rejects.toMatchObject({
      status: 409, code: 'WORKFLOW_REQUEST_NOT_EDITABLE'
    })
  })

  it('returns only current active authority-role assignments for the request routing unit and snapshots a valid selection', async () => {
    await activateSnapshot([{ personnel: '100' }]); const request = await create(); await service.addCandidate(request.id, '100', ea, evidence)
    const activeId = randomUUID(); const inactiveId = randomUUID(); const crossRoutingId = randomUUID()
    for (const [id, active] of [[activeId, true], [inactiveId, false]] as const) {
      await pool.query(
        `INSERT INTO egas_approvingauthorityassignment
          (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,validfrom,isactive,createdat,updatedat)
         VALUES ($1,$2,$3,'PRIMARY','رئيس',TRUE,'2020-01-01',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        [id, unitIds[0], authority.userId, active]
      )
    }
    await pool.query(
      `INSERT INTO egas_approvingauthorityassignment
        (id,routingunit_id,useraccount_id,authoritykind,authorityjobtitle,isprimary,validfrom,isactive,createdat,updatedat)
       VALUES ($1,$2,$3,'PRIMARY','رئيس',TRUE,'2020-01-01',TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [crossRoutingId, unitIds[1], authority.userId]
    )
    expect(await service.authorityOptions(request.id, ea)).toEqual([expect.objectContaining({ id: activeId, preferred: true })])
    await expect(service.selectAuthority(request.id, inactiveId, ea, evidence)).rejects.toMatchObject({ status: 404 })
    await expect(service.selectAuthority(request.id, crossRoutingId, ea, evidence)).rejects.toMatchObject({ status: 404 })
    const selected = await service.selectAuthority(request.id, activeId, ea, evidence)
    expect(selected.approvingAuthority).toMatchObject({ assignmentId: activeId, displayName: authority.username, jobTitle: 'رئيس' })
  })

  it('adds append-only request/candidate notes with role, task, iteration, server time and safe timeline entries', async () => {
    await activateSnapshot([{ personnel: '100' }]); const request = await create(); const detail = await service.addCandidate(request.id, '100', ea, evidence)
    const candidateId = (detail.candidates as Array<{ id: string }>)[0]!.id
    await service.addNote(request.id, null, 'ملاحظة على الطلب', ea, evidence)
    const notes = await service.addNote(request.id, candidateId, 'ملاحظة على المرشح', ea, evidence)
    expect(notes).toHaveLength(2); expect(notes[1]).toMatchObject({ candidateId, authorRole: 'EMPLOYEE_AFFAIRS', stageCode: 'P1' })
    const timeline = await service.timeline(request.id, ea, 100)
    expect(timeline.map(item => item.kind)).toEqual(expect.arrayContaining(['ACTION','NOTE']))
    const times = timeline.map(item => Date.parse(item.createdAt as string))
    expect(times).toEqual([...times].sort((left, right) => left - right))
    expect(JSON.stringify(timeline)).not.toMatch(/payloadjson|metadatajson|eventhash/i)
    expect((await pool.query("SELECT id FROM egas_auditevent WHERE actioncode='WORKFLOW_NOTE_ADDED'")).rows).toHaveLength(2)
  })

  it('rejects cross-request candidate note scope and unauthorized notes', async () => {
    await activateSnapshot([{ personnel: '100' }]); const first = await create(); const second = await create()
    const added = await service.addCandidate(first.id, '100', ea, evidence)
    const candidateId = (added.candidates as Array<{ id: string }>)[0]!.id
    await expect(service.addNote(second.id, candidateId, 'cross request', ea, evidence)).rejects.toMatchObject({
      status: 404, code: 'WORKFLOW_CANDIDATE_NOT_FOUND'
    })
    await expect(service.addNote(first.id, null, 'unauthorized', otherEa, evidence)).rejects.toMatchObject({ status: 404 })
  })

  it('binds Organization access to an atomically claimed organization task and blocks other Organization users', async () => {
    const request = await create(); const row = await pool.query<{ id: string }>('SELECT id FROM egas_stagetask WHERE request_id=$1', [request.id])
    await pool.query("UPDATE egas_workflowrequest SET currentstage='P2' WHERE id=$1", [request.id])
    await pool.query("UPDATE egas_stagetask SET stagecode='P2',assigneduser_id=NULL,taskstatus='OPEN' WHERE id=$1", [row.rows[0]!.id])
    const queue = await taskService.organizationQueue(org, 0, 50)
    expect(queue[0]).toMatchObject({ taskId: row.rows[0]!.id, claimable: true, claimedByMe: false })
    await expect(service.detail(request.id, org)).rejects.toMatchObject({ status: 404 })
    const claimed = await taskService.claim(row.rows[0]!.id, org, evidence)
    expect(claimed).toMatchObject({ taskStatus: 'CLAIMED', assignedUserId: org.userId })
    await expect(taskService.claim(row.rows[0]!.id, otherOrg, evidence)).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_TASK_ALREADY_CLAIMED' })
    expect((await taskService.organizationQueue(otherOrg, 0, 50))[0]).toMatchObject({
      taskId: row.rows[0]!.id, claimantName: org.username, claimedByMe: false, claimable: false
    })
    await expect(service.detail(request.id, otherOrg)).rejects.toMatchObject({ status: 404 })
    await expect(service.detail(request.id, org)).resolves.toMatchObject({ id: request.id })
  })

  it('allows exactly one of two concurrent Organization claims', async () => {
    const request = await create(); const task = await pool.query<{ id: string }>('SELECT id FROM egas_stagetask WHERE request_id=$1', [request.id])
    await pool.query("UPDATE egas_workflowrequest SET currentstage='S2' WHERE id=$1", [request.id])
    await pool.query("UPDATE egas_stagetask SET stagecode='S2',assigneduser_id=NULL,taskstatus='OPEN' WHERE id=$1", [task.rows[0]!.id])
    const outcomes = await Promise.allSettled([
      taskService.claim(task.rows[0]!.id, org, evidence), taskService.claim(task.rows[0]!.id, otherOrg, evidence)
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ status: 409, code: 'WORKFLOW_TASK_ALREADY_CLAIMED' })
    const stored = await pool.query('SELECT assigneduser_id,claimedrolesnapshot FROM egas_stagetask WHERE id=$1', [task.rows[0]!.id])
    expect([org.userId, otherOrg.userId]).toContain(stored.rows[0].assigneduser_id)
    expect(stored.rows[0].claimedrolesnapshot).toBe('ORGANIZATION')
  })

  it('lists only actionable tasks assigned to the active Approving Authority account', async () => {
    const request = await create(); const task = await pool.query<{ id: string }>('SELECT id FROM egas_stagetask WHERE request_id=$1', [request.id])
    await pool.query("UPDATE egas_workflowrequest SET currentstage='P4' WHERE id=$1", [request.id])
    await pool.query("UPDATE egas_stagetask SET stagecode='P4',assigneduser_id=$2,taskstatus='OPEN' WHERE id=$1", [task.rows[0]!.id, authority.userId])
    expect(await taskService.authorityQueue(authority, 0, 50)).toEqual([
      expect.objectContaining({ taskId: task.rows[0]!.id, requestId: request.id, stageCode: 'P4', actionable: true })
    ])
    const otherAuthority = await user('phase3-other-authority', 'APPROVING_AUTHORITY')
    expect(await taskService.authorityQueue(otherAuthority, 0, 50)).toHaveLength(0)
    await expect(taskService.authorityQueue(org, 0, 50)).rejects.toMatchObject({ status: 403, code: 'ACTIVE_ROLE_REQUIRED' })
  })

  it('isolates notifications by recipient and marks only the owner notification read', async () => {
    const own = await createNotification(pool, { recipientUserId: ea.userId, type: 'TEST', titleAr: 'اختبار' })
    const foreign = await createNotification(pool, { recipientUserId: otherEa.userId, type: 'TEST', titleAr: 'آخر' })
    const notifications = new NotificationService(pool)
    expect(await notifications.list(ea.userId, 0, 50, true)).toEqual([expect.objectContaining({ id: own, isRead: false })])
    expect(await notifications.unreadCount(ea.userId)).toBe(1)
    await expect(notifications.markRead(ea.userId, foreign)).rejects.toMatchObject({ status: 404 })
    expect(await notifications.markRead(ea.userId, own)).toMatchObject({ id: own, isRead: true })
    expect(await notifications.unreadCount(ea.userId)).toBe(0)
    expect(await notifications.list(ea.userId, 0, 50, true)).toHaveLength(0)
  })
})
