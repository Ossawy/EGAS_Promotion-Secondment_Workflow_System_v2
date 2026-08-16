import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { AuthorityService } from '../src/modules/authorities/authority-service.js'
import { isolatedPool } from './helpers/database.js'

const ids = { admin: randomUUID(), authority: randomUUID(), delegate: randomUUID(), ineligible: randomUUID(), routing: randomUUID() }
const actor = { userId: ids.admin, canManageAdmins: true }
const evidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'authority-test' }
let pool: Pool
let service: AuthorityService

async function user(id: string, eligible: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO egas_useraccount (id,username,displayname,passwordhash,isactive,createdat,updatedat)
     VALUES ($1,$2,$2,'synthetic',TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [id, `user-${id}`]
  )
  if (eligible) await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,isactive,grantedat)
     VALUES ($1,$2,'APPROVING_AUTHORITY',TRUE,CURRENT_TIMESTAMP)`, [randomUUID(), id]
  )
}

beforeEach(async () => {
  pool = await isolatedPool()
  service = new AuthorityService(pool)
  await user(ids.admin, false)
  await user(ids.authority, true)
  await user(ids.delegate, true)
  await user(ids.ineligible, false)
  await pool.query(
    `INSERT INTO egas_routingunit (id,namear,code,isactive,createdat,updatedat)
     VALUES ($1,'Synthetic Routing','AUTH_TEST',TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [ids.routing]
  )
})
afterEach(async () => { await pool.end() })

describe('authority assignment and delegation rules', () => {
  it('requires an eligible active authority and one active primary per routing unit', async () => {
    const assignment = await service.createAssignment(actor, {
      routingUnitId: ids.routing, userAccountId: ids.authority, authorityKind: 'DEPUTY',
      authorityJobTitle: 'Synthetic Deputy', isPrimary: true
    }, evidence)
    expect(assignment).toMatchObject({ routingUnitId: ids.routing, userAccountId: ids.authority, isPrimary: true })
    expect((await pool.query("SELECT eventtype FROM egas_securityevent WHERE eventtype='AUTHORITY_ASSIGNMENT_CREATED'")).rows).toHaveLength(1)
    await expect(service.createAssignment(actor, {
      routingUnitId: ids.routing, userAccountId: ids.delegate, authorityKind: 'ASSISTANT',
      authorityJobTitle: 'Synthetic Assistant', isPrimary: true
    }, evidence)).rejects.toMatchObject({ status: 409 })
    await expect(service.createAssignment(actor, {
      routingUnitId: ids.routing, userAccountId: ids.ineligible, authorityKind: 'OTHER',
      authorityJobTitle: 'Ineligible', isPrimary: false
    }, evidence)).rejects.toMatchObject({ status: 400 })
  })

  it('validates delegation parties/dates and supports explicit deactivation', async () => {
    const assignment = await service.createAssignment(actor, {
      routingUnitId: ids.routing, userAccountId: ids.authority, authorityKind: 'DEPUTY',
      authorityJobTitle: 'Synthetic Deputy', isPrimary: true
    }, evidence)
    await expect(service.createDelegation(actor, {
      assignmentId: assignment.id, delegatedUserId: ids.authority
    }, evidence)).rejects.toMatchObject({ status: 400 })
    await expect(service.createDelegation(actor, {
      assignmentId: assignment.id, delegatedUserId: ids.delegate,
      validFrom: '2026-02-02T00:00:00Z', validTo: '2026-02-01T00:00:00Z'
    }, evidence)).rejects.toMatchObject({ status: 400 })
    const delegation = await service.createDelegation(actor, {
      assignmentId: assignment.id, delegatedUserId: ids.delegate,
      validFrom: '2026-02-01T00:00:00Z', validTo: '2026-02-02T00:00:00Z', reason: 'Synthetic'
    }, evidence)
    expect((await pool.query("SELECT eventtype FROM egas_securityevent WHERE eventtype='AUTHORITY_DELEGATION_CREATED'")).rows).toHaveLength(1)
    const deactivated = await service.deactivateDelegation(actor, {
      delegationId: delegation.id, expectedVersion: delegation.version
    }, evidence)
    expect(deactivated.isActive).toBe(false)
    const assignmentOff = await service.deactivateAssignment(actor, {
      assignmentId: assignment.id, expectedVersion: assignment.version
    }, evidence)
    expect(assignmentOff.isActive).toBe(false)
  })
})
