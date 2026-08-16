import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import { HistoryService, type HistoryFilters } from '../src/modules/workflow/history-service.ts'
import { WorkflowService } from '../src/modules/workflow/workflow-service.ts'
import { isolatedPool } from './helpers/database.ts'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'history' }
const defaults: HistoryFilters = { skip: 0, top: 50, requestType: null, status: null, routingUnitId: null,
  personnelNumber: null, query: null, from: null, to: null }
let pool: Pool; let workflow: WorkflowService; let history: HistoryService

async function account(username: string, role: NonNullable<AuthContext['activeRole']>): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$2,'synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [userId, username]
  )
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId, role]
  )
  return { userId, username, sessionId: randomUUID(), activeRole: role, roleAssignmentId: roleId,
    canManageAdmins: false, mustChangePassword: false }
}

beforeEach(async () => { pool = await isolatedPool(); workflow = new WorkflowService(pool); history = new HistoryService(pool) })
afterEach(async () => { await pool.end() })

describe('role-scoped workflow history', () => {
  it('searches only requests owned or participated in under the exact active role', async () => {
    const ea = await account('history-ea', 'EMPLOYEE_AFFAIRS'); const otherEa = await account('history-other', 'EMPLOYEE_AFFAIRS')
    const org = await account('history-org', 'ORGANIZATION'); const authority = await account('history-authority', 'APPROVING_AUTHORITY')
    const own = await workflow.create({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }, ea, evidence)
    await workflow.create({ requestType: 'SECONDMENT', cycleYear: 2026, formMonth: 8, formYear: 2026 }, otherEa, evidence)
    const iteration = (await pool.query<{ id: string }>(`SELECT id FROM egas_workflowiteration WHERE request_id=$1`, [own.id])).rows[0]!
    await pool.query(
      `INSERT INTO egas_stagetask (id,iteration_id,request_id,stagecode,taskstatus,assigneduser_id,openedat,version)
       VALUES ($1,$2,$3,'P2','COMPLETED',$4,CURRENT_TIMESTAMP,1),
              ($5,$2,$3,'P4','COMPLETED',$6,CURRENT_TIMESTAMP,1)`,
      [randomUUID(), iteration.id, own.id, org.userId, randomUUID(), authority.userId]
    )
    await pool.query(
      `INSERT INTO egas_requestcandidate
        (id,request_id,employeesnapshot_id,displayorder,personnelnumbersnapshot,employeenamesnapshot,createdat,version)
       VALUES ($1,$2,$3,0,'99881','عامل بحث',CURRENT_TIMESTAMP,1)`, [randomUUID(), own.id, randomUUID()]
    )

    expect(await history.search(ea, defaults)).toEqual([expect.objectContaining({ id: own.id, candidateCount: 1 })])
    expect(await history.search(org, defaults)).toEqual([expect.objectContaining({ id: own.id })])
    expect(await history.search(authority, defaults)).toEqual([expect.objectContaining({ id: own.id })])
    expect(await history.search(otherEa, { ...defaults, requestType: 'PROMOTION' })).toEqual([])
    expect(await history.search(ea, { ...defaults, personnelNumber: '99881' })).toHaveLength(1)
    expect(await history.search(ea, { ...defaults, personnelNumber: 'no-match' })).toEqual([])
    expect(await history.search(ea, { ...defaults, query: String(own.requestNumber).slice(0, 8) })).toHaveLength(1)
  })
})
