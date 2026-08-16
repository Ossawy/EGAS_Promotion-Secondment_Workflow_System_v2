import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { AuthService } from '../src/modules/auth/auth-service.js'
import { LocalAuthenticationProvider } from '../src/modules/auth/local-authentication-provider.js'
import { AdminService } from '../src/modules/admin/admin-service.js'
import { isolatedPool, testConfig } from './helpers/database.js'

const evidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'isolated-test' }
const password = 'synthetic-current-password'
let pool: Pool
let provider: LocalAuthenticationProvider
let auth: AuthService
const ids = { admin: randomUUID(), second: randomUUID(), multi: randomUUID(), disabled: randomUUID(), locked: randomUUID() }

async function seedAccount(id: string, username: string, active = true, locked = false): Promise<void> {
  const passwordHash = await provider.hashPassword(password)
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,passwordhash,mustchangepassword,isactive,failedlogincount,lockeduntil,createdat,updatedat,version)
     VALUES ($1,$2,$2,$3,FALSE,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
    [id, username, passwordHash, active, locked ? 2 : 0, locked ? new Date(Date.now() + 60_000) : null]
  )
}

async function role(userId: string, value: string, manage = false, active = true): Promise<void> {
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`, [randomUUID(), userId, value, manage, active]
  )
}

beforeEach(async () => {
  pool = await isolatedPool()
  provider = new LocalAuthenticationProvider(pool, testConfig)
  auth = new AuthService(pool, testConfig)
  await seedAccount(ids.admin, 'plain-admin')
  await seedAccount(ids.second, 'plain-second')
  await seedAccount(ids.multi, 'plain-multi')
  await seedAccount(ids.disabled, 'plain-disabled', false)
  await seedAccount(ids.locked, 'plain-locked', true, true)
  await role(ids.admin, 'ADMIN', true)
  await role(ids.second, 'ADMIN', true)
  await role(ids.multi, 'ADMIN')
  await role(ids.multi, 'ORGANIZATION')
  await role(ids.disabled, 'ADMIN', true)
  await role(ids.locked, 'ADMIN', false)
})
afterEach(async () => { await pool.end() })

describe('authentication and exact active-role isolation', () => {
  it('uses Argon2id for password hashes', async () => {
    const encoded = await provider.hashPassword('synthetic-temporary-password')
    expect(encoded).toMatch(/^\$argon2id\$/)
    expect(encoded).not.toContain('synthetic-temporary-password')
    await expect(provider.verifyPassword(encoded, 'synthetic-temporary-password')).resolves.toBe(true)
  })
  it('stores only session/CSRF hashes and selects no role for a multi-role account', async () => {
    const issued = await auth.login('plain-multi', password, evidence)
    expect(issued.context.activeRole).toBeNull()
    const stored = await pool.query('SELECT tokenhash,csrfsecrethash FROM egas_authsession WHERE id=$1', [issued.sessionId])
    expect(stored.rows[0].tokenhash).toBe(provider.hashSessionToken(issued.sessionToken))
    expect(stored.rows[0].tokenhash).not.toBe(issued.sessionToken)
    expect(stored.rows[0].csrfsecrethash).toBe(provider.hashSessionToken(issued.csrfToken))
    expect((await pool.query("SELECT eventtype FROM egas_securityevent WHERE eventtype='LOGIN_SUCCEEDED'")).rows).toHaveLength(1)
    const selected = await auth.selectActiveRole(ids.multi, issued.sessionId, 'ORGANIZATION', evidence)
    expect(selected.context.activeRole).toBe('ORGANIZATION')
    await expect(provider.resolveSessionToken(issued.sessionToken)).resolves.toBeNull()
    await expect(provider.resolveSessionToken(selected.sessionToken)).resolves.toMatchObject({ activeRole: 'ORGANIZATION', canManageAdmins: false })
  })

  it('uses one generic error for unknown, disabled, locked, and wrong-password accounts', async () => {
    const cases: Array<[string, string, string]> = [
      ['missing-user', password, '127.0.0.2'], ['plain-disabled', password, '127.0.0.3'],
      ['plain-locked', password, '127.0.0.4'], ['plain-admin', 'wrong-password-value', '127.0.0.5']
    ]
    for (const [username, candidate, ip] of cases) {
      await expect(auth.login(username, candidate, { ...evidence, ipAddress: ip }))
        .rejects.toMatchObject({ status: 401, message: 'Invalid username or password' })
    }
    const internalReasons = await pool.query<{ failureReason: string }>(
      `SELECT failurereason AS "failureReason" FROM egas_authloginattempt
        WHERE ipaddress IN ($1,$2,$3,$4) ORDER BY ipaddress`, cases.map(([, , ip]) => ip)
    )
    expect(internalReasons.rows.map(row => row.failureReason)).toEqual([
      'UNKNOWN_OR_INVALID', 'ACCOUNT_DISABLED', 'ACCOUNT_LOCKED', 'INVALID_CREDENTIAL'
    ])
  })

  it('changes passwords transactionally and rotates all sessions', async () => {
    const issued = await auth.login('plain-admin', password, evidence)
    const changed = await auth.changePassword(ids.admin, issued.sessionId, password, 'synthetic-updated-password', evidence)
    expect(changed.context.mustChangePassword).toBe(false)
    expect((await pool.query("SELECT eventtype FROM egas_securityevent WHERE eventtype='PASSWORD_CHANGED'")).rows).toHaveLength(1)
    await expect(provider.resolveSessionToken(issued.sessionToken)).resolves.toBeNull()
    await expect(provider.resolveSessionToken(changed.sessionToken)).resolves.toMatchObject({ userId: ids.admin })
  })

  it('expires, revokes, and invalidates sessions when their account is disabled', async () => {
    const expired = await auth.login('plain-admin', password, { ...evidence, ipAddress: '127.0.0.6' })
    await pool.query("UPDATE egas_authsession SET idleexpiresat=CURRENT_TIMESTAMP-'1 minute'::interval WHERE id=$1", [expired.sessionId])
    await expect(provider.resolveSessionToken(expired.sessionToken)).resolves.toBeNull()
    const absoluteExpired = await auth.login('plain-admin', password, { ...evidence, ipAddress: '127.0.0.61' })
    await pool.query("UPDATE egas_authsession SET absoluteexpiresat=CURRENT_TIMESTAMP-'1 minute'::interval WHERE id=$1", [absoluteExpired.sessionId])
    await expect(provider.resolveSessionToken(absoluteExpired.sessionToken)).resolves.toBeNull()
    const revoked = await auth.login('plain-admin', password, { ...evidence, ipAddress: '127.0.0.7' })
    await auth.logout(ids.admin, revoked.sessionId, evidence)
    await expect(provider.resolveSessionToken(revoked.sessionToken)).resolves.toBeNull()
    const disabled = await auth.login('plain-admin', password, { ...evidence, ipAddress: '127.0.0.8' })
    await pool.query('UPDATE egas_useraccount SET isactive=FALSE WHERE id=$1', [ids.admin])
    await expect(provider.resolveSessionToken(disabled.sessionToken)).resolves.toBeNull()
  })

  it('serializes concurrent failures and enforces the durable attempt limit', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () =>
      auth.login('concurrent-unknown', 'wrong-password-value', { ...evidence, ipAddress: '127.0.0.20' })
    ))
    const statuses = outcomes.map(outcome => outcome.status === 'rejected'
      ? (outcome.reason as { status: number }).status : 200)
    expect(statuses.filter(status => status === 401)).toHaveLength(2)
    expect(statuses.filter(status => status === 429)).toHaveLength(2)
    expect((await pool.query(
      "SELECT id FROM egas_authloginattempt WHERE ipaddress='127.0.0.20' AND wassuccessful=FALSE"
    )).rows).toHaveLength(2)
  })
})

describe('Admin safety rules', () => {
  it('creates safe multi-role users and never returns password hashes', async () => {
    const service = new AdminService(pool, testConfig)
    const created = await service.createUser({ userId: ids.admin, canManageAdmins: true }, {
      username: 'created-user', displayName: 'Created User', temporaryPassword: 'synthetic-temporary-password',
      roles: [{ role: 'EMPLOYEE_AFFAIRS' }, { role: 'ORGANIZATION' }]
    }, evidence)
    expect(created.roles).toHaveLength(2)
    expect(JSON.stringify(created)).not.toContain('passwordHash')
    expect((await pool.query(
      "SELECT eventtype FROM egas_securityevent WHERE correlationid='isolated-test' AND eventtype='ADMIN_USER_CREATED'"
    )).rows).toHaveLength(1)
    await expect(service.createUser({ userId: ids.admin, canManageAdmins: true }, {
      username: 'created-user', displayName: 'Duplicate', temporaryPassword: 'synthetic-temporary-password',
      roles: [{ role: 'ORGANIZATION' }]
    }, evidence)).rejects.toMatchObject({ status: 409 })
  })

  it('enforces Manage-Admins and optimistic concurrency', async () => {
    const service = new AdminService(pool, testConfig)
    await expect(service.assignRole(
      { userId: ids.multi, canManageAdmins: false },
      { userId: ids.disabled, role: 'ADMIN', canManageAdmins: true }, evidence
    )).rejects.toMatchObject({ status: 403 })
    const current = await service.getUser(ids.multi)
    await expect(service.updateUser(
      { userId: ids.admin, canManageAdmins: true },
      { userId: ids.multi, expectedVersion: current.version + 1, displayName: 'Stale', staffIdentifier: null, jobTitle: null },
      evidence
    )).rejects.toMatchObject({ status: 409 })
  })

  it('manages roles, locks, password resets, and account state with session invalidation', async () => {
    const service = new AdminService(pool, testConfig)
    const actor = { userId: ids.admin, canManageAdmins: true }
    const login = await auth.login('plain-multi', password, { ...evidence, ipAddress: '127.0.0.30' })
    await service.assignRole(actor, { userId: ids.multi, role: 'APPROVING_AUTHORITY', canManageAdmins: false }, evidence)
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
    const revoked = await service.revokeRole(actor, { userId: ids.multi, role: 'APPROVING_AUTHORITY' }, evidence)
    expect(revoked.roles.find(value => value.role === 'APPROVING_AUTHORITY')).toMatchObject({ isActive: false })

    const locked = await service.unlock(actor, { userId: ids.locked, expectedVersion: 1 }, evidence)
    expect(locked.isLocked).toBe(false)
    const multi = await service.getUser(ids.multi)
    const reset = await service.resetPassword(actor, {
      userId: ids.multi, expectedVersion: multi.version, temporaryPassword: 'synthetic-reset-password'
    }, evidence)
    expect(reset.mustChangePassword).toBe(true)
    const enabled = await service.setActive(actor, { userId: ids.disabled, expectedVersion: 1 }, true, evidence)
    expect(enabled.isActive).toBe(true)
    const disabled = await service.setActive(actor, { userId: ids.disabled, expectedVersion: enabled.version }, false, evidence)
    expect(disabled.isActive).toBe(false)
  })

  it('blocks self-management and protects the last active Manage-Admins account', async () => {
    const service = new AdminService(pool, testConfig)
    await expect(service.revokeRole(
      { userId: ids.admin, canManageAdmins: true }, { userId: ids.admin, role: 'ADMIN' }, evidence
    )).rejects.toMatchObject({ status: 403 })
    const second = await service.getUser(ids.second)
    await service.setActive({ userId: ids.admin, canManageAdmins: true }, { userId: ids.second, expectedVersion: second.version }, false, evidence)
    const admin = await service.getUser(ids.admin)
    await expect(service.setActive(
      { userId: ids.second, canManageAdmins: true }, { userId: ids.admin, expectedVersion: admin.version }, false, evidence
    )).rejects.toMatchObject({ status: 409 })
  })
})
