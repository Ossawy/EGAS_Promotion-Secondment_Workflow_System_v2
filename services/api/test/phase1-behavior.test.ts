import { randomUUID } from 'node:crypto'
import { DataType, newDb } from 'pg-mem'
import type { Pool } from 'pg'
import { beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { V5AdminService } from '../src/modules/admin/v5-admin-service.js'
import { AuthService } from '../src/modules/auth/auth-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { HierarchyService } from '../src/modules/hierarchy/hierarchy-service.js'
import { AppError } from '../src/shared/errors.js'
import { testConfig } from './helpers/database.js'

const evidence = { ipAddress:'127.0.0.1', userAgent:'phase1-behavior-test', correlationId:'phase1-behavior-correlation' }
const actor = { userId:'00000000-0000-4000-8000-000000000001' }
let pool: Pool, admin: V5AdminService, auth: AuthService, hierarchy: HierarchyService

async function account(username:string, type:'ADMIN'|'OPERATIONAL', unitId?:string) {
  return await admin.createAccount(actor, { username, displayName:username, accountType:type, temporaryPassword:'A-secure-temporary-password-1234', ...(unitId ? {unitId} : {}) }, evidence)
}

beforeEach(async () => {
  const db = newDb({ autoCreateForeignKeyIndices:true })
  db.public.registerFunction({ name:'hashtext', args:[DataType.text], returns:DataType.integer, implementation:()=>1 })
  db.public.registerFunction({ name:'pg_advisory_xact_lock', args:[DataType.integer], returns:DataType.integer, implementation:()=>1 })
  db.public.none(await readFile(new URL('../src/db/migrations/001_initial_v5_schema.sql', import.meta.url), 'utf8'))
  const adapter = db.adapters.createPg(); pool = new adapter.Pool() as unknown as Pool
  admin = new V5AdminService(pool, testConfig); auth = new AuthService(pool, testConfig); hierarchy = new HierarchyService(pool)
  const provider = new LocalAuthenticationProvider(pool, testConfig)
  await pool.query(`INSERT INTO user_account(id,username,display_name,account_type,password_hash,must_change_password) VALUES($1,'phase-admin','Phase Admin','ADMIN',$2,FALSE)`, [actor.userId, await provider.hashPassword('Admin-current-password-1234')])
})

describe('Phase 1 Critical Behavior Gaps', () => {
  it('prevents double managers during concurrent replacement', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const m1 = await account('mgr_one', 'OPERATIONAL', unit.id)
    const m2 = await account('mgr_two', 'OPERATIONAL', unit.id)
    
    const results = await Promise.allSettled([
      admin.replaceManager(actor, unit.id, {managerUserId: m1.id}, evidence),
      admin.replaceManager(actor, unit.id, {managerUserId: m2.id}, evidence)
    ])
    
    const activeManagers = (await pool.query(`SELECT count(*)::int AS count FROM unit_manager_assignment WHERE unit_id=$1 AND effective_to IS NULL`, [unit.id])).rows[0].count

    expect(activeManagers).toBe(1)
    expect(results.filter(r => r.status === 'rejected').length).toBeGreaterThanOrEqual(1)
  })


  it('prevents double active memberships during concurrent creation', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const op = await account('op1', 'OPERATIONAL', unit.id)
    await pool.query(`UPDATE user_unit_membership SET effective_to=NOW() WHERE user_id=$1`, [op.id])
    
    const insert = () => pool.query(`INSERT INTO user_unit_membership(id,user_id,unit_id,created_by_user_id) VALUES($1,$2,$3,$4)`, [randomUUID(), op.id, unit.id, actor.userId])
    const results = await Promise.allSettled([insert(), insert()])
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
  })

  it('updates manager authority immediately (lose/gain)', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const m1 = await account('mgr_one', 'OPERATIONAL', unit.id)
    const m2 = await account('mgr_two', 'OPERATIONAL', unit.id)
    
    await admin.replaceManager(actor, unit.id, {managerUserId: m1.id}, evidence)
    expect(await hierarchy.isCurrentManager(m1.id, unit.id)).toBe(true)
    
    await admin.replaceManager(actor, unit.id, {managerUserId: m2.id}, evidence)
    expect(await hierarchy.isCurrentManager(m1.id, unit.id)).toBe(false)
    expect(await hierarchy.isCurrentManager(m2.id, unit.id)).toBe(true)
  })

  it('blocks sessions immediately when account is disabled', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const op = await account('op_user', 'OPERATIONAL', unit.id)
    const session = await auth.login('op_user', 'A-secure-temporary-password-1234', evidence)
    
    await admin.setAccountActive(actor, op.id, false, evidence)
    
    const validated = await auth.validateSession(session.sessionId, evidence).catch(e => e)
    expect(validated).toMatchObject({code: 'AUTHENTICATION_FAILED'})
  })


  it('revokes sessions on admin password reset', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const op = await account('op_user', 'OPERATIONAL', unit.id)
    const session = await auth.login('op_user', 'A-secure-temporary-password-1234', evidence)
    
    await admin.resetPassword(actor, op.id, 'New-Password-1234', evidence)
    
    const validated = await auth.validateSession(session.sessionId, evidence).catch(e => e)
    expect(validated).toMatchObject({code: 'AUTHENTICATION_FAILED'})
  })


  it('denies direct-ID hierarchy modification for non-admins', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const op = await account('op1', 'OPERATIONAL', unit.id)
    const opContext = { userId: op.id }
    
    await expect(admin.replaceManager(opContext, unit.id, {managerUserId: op.id}, evidence)).rejects.toMatchObject({status: 403})
  })

  it('rejects forged authorization in API requests', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const op = await account('op1', 'OPERATIONAL', unit.id)
    
    // Attempting to use a forged actor context that claims ADMIN status
    const forgedActor = { userId: op.id, accountType: 'ADMIN' } as any
    await expect(admin.createUnit(forgedActor, {kind:'HR', name:'Forbidden'}, evidence)).rejects.toBeInstanceOf(AppError)
  })

  it('rejects multiple active HR or ORG units', async () => {
    const hr1 = await admin.createUnit(actor, {kind:'HR', name:'HR1'}, evidence)
    const op = await account('op_user', 'OPERATIONAL', hr1.id)
    
    // Deactivate HR1 before creating HR2 to avoid unique constraint on (kind='HR' AND is_active)
    await pool.query(`UPDATE operational_unit SET is_active=FALSE WHERE id=$1`, [hr1.id])
    const hr2 = await admin.createUnit(actor, {kind:'HR', name:'HR2'}, evidence)
    await admin.transfer(actor, hr2.id, {userId: op.id}, evidence)
    
    const activeMemberships = (await pool.query(`SELECT count(*)::int AS count FROM user_unit_membership WHERE user_id=$1 AND effective_to IS NULL`, [op.id])).rows[0].count
    expect(activeMemberships).toBe(1)
  })




  it('enforces AUTH unit routing requirements', async () => {
    await expect(admin.createUnit(actor, {kind:'AUTH', name:'No-Routing'}, evidence)).rejects.toMatchObject({status: 400})
    
    const routingId = randomUUID()
    await pool.query(`INSERT INTO routing_unit(id,code,name_ar) VALUES($1,'R1','R1')`, [routingId])
    await admin.createUnit(actor, {kind:'AUTH', name:'Auth1', routingUnitId: routingId}, evidence)
    await expect(admin.createUnit(actor, {kind:'AUTH', name:'Auth2', routingUnitId: routingId}, evidence)).rejects.toMatchObject({code: 'CONFLICT'})
  })

  it('rejects manager from other unit', async () => {
    const u1 = await admin.createUnit(actor, {kind:'HR', name:'U1'}, evidence)
    const u2 = await admin.createUnit(actor, {kind:'ORG', name:'U2'}, evidence)
    const m2 = await account('mgr_two', 'OPERATIONAL', u2.id)
    
    await expect(admin.replaceManager(actor, u1.id, {managerUserId: m2.id}, evidence)).rejects.toMatchObject({status: 400})
  })



  it('prevents inactive users from being managers', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    const m1 = await account('mgr_one', 'OPERATIONAL', unit.id)
    await admin.setAccountActive(actor, m1.id, false, evidence)
    
    await expect(admin.replaceManager(actor, unit.id, {managerUserId: m1.id}, evidence)).rejects.toMatchObject({status: 400})
  })


  it('prevents ADMIN from being operational manager', async () => {
    const unit = await admin.createUnit(actor, {kind:'HR', name:'Unit'}, evidence)
    await expect(admin.replaceManager(actor, unit.id, {managerUserId: actor.userId}, evidence)).rejects.toMatchObject({status: 400})
  })
})
