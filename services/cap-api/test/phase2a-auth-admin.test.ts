import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cds, { type Service } from '@sap/cds'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AdminAccountOperations } from '../lib/admin/admin-account-operations.ts'
import { AuthorityOperations } from '../lib/admin/authority-operations.ts'
import { AuthOperations } from '../lib/auth/auth-operations.ts'
import { LocalAuthenticationProvider } from '../lib/auth/local-authentication-provider.ts'
import {
  loadSecurityPolicy, type SecurityPolicy, SafeRequestError
} from '../lib/auth/security-policy.ts'
import {
  issueSessionCookies, requireAdmin, requireCsrf
} from '../srv/auth/request-security.ts'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ids = {
  admin: '31000000-0000-4000-8000-000000000001',
  secondAdmin: '31000000-0000-4000-8000-000000000002',
  multi: '31000000-0000-4000-8000-000000000003',
  disabled: '31000000-0000-4000-8000-000000000004',
  locked: '31000000-0000-4000-8000-000000000005',
  authority: '31000000-0000-4000-8000-000000000006',
  delegate: '31000000-0000-4000-8000-000000000007',
  routing: '32000000-0000-4000-8000-000000000001'
}
const password = 'synthetic-current-password'
const newPassword = 'synthetic-updated-password'
const evidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'phase2a-test' }
let db: Service
let provider: LocalAuthenticationProvider
let policy: SecurityPolicy
let auth: AuthOperations
let createdUserId: string | null = null
let deployed = false

beforeAll(async () => {
  db = await cds.connect.to('db')
  if (db.kind !== 'sqlite') throw new Error(`Phase 2A tests require SQLite, got ${String(db.kind)}`)
  const model = await cds.load('*')
  const deploy = (cds as typeof cds & {
    deploy: (modelToDeploy: typeof model) => { to: (target: typeof db) => Promise<unknown> }
  }).deploy
  await deploy(model).to(db)
  deployed = true
  provider = new LocalAuthenticationProvider(db)
  policy = { ...loadSecurityPolicy(), loginFailureLimit: 2 }
  auth = new AuthOperations(db, policy, provider)
  const hash = await provider.hashPassword(password)
  const now = new Date().toISOString()
  await db.run(INSERT.into('egas.UserAccount').entries([
    { ID: ids.admin, username: 'phase2-admin', displayName: 'Phase 2 Admin', passwordHash: hash, mustChangePassword: true, isActive: true, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.secondAdmin, username: 'phase2-admin-2', displayName: 'Second Admin', passwordHash: hash, mustChangePassword: false, isActive: true, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.multi, username: 'phase2-multi', displayName: 'Multi Role', passwordHash: hash, mustChangePassword: false, isActive: true, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.disabled, username: 'phase2-disabled', displayName: 'Disabled', passwordHash: hash, mustChangePassword: false, isActive: false, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.locked, username: 'phase2-locked', displayName: 'Locked', passwordHash: hash, mustChangePassword: false, isActive: true, failedLoginCount: 2, lockedUntil: new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.authority, username: 'phase2-authority', displayName: 'Authority', passwordHash: hash, mustChangePassword: false, isActive: true, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 },
    { ID: ids.delegate, username: 'phase2-delegate', displayName: 'Delegate', passwordHash: hash, mustChangePassword: false, isActive: true, failedLoginCount: 0, createdAt: now, updatedAt: now, version: 1 }
  ]))
  await db.run(INSERT.into('egas.UserAccountRole').entries([
    { ID: '33000000-0000-4000-8000-000000000001', user_ID: ids.admin, role: 'ADMIN', canManageAdmins: true, isActive: true, grantedAt: now },
    { ID: '33000000-0000-4000-8000-000000000002', user_ID: ids.secondAdmin, role: 'ADMIN', canManageAdmins: true, isActive: true, grantedAt: now },
    { ID: '33000000-0000-4000-8000-000000000003', user_ID: ids.multi, role: 'ADMIN', canManageAdmins: false, isActive: true, grantedAt: now },
    { ID: '33000000-0000-4000-8000-000000000004', user_ID: ids.multi, role: 'ORGANIZATION', canManageAdmins: false, isActive: true, grantedAt: now },
    { ID: '33000000-0000-4000-8000-000000000005', user_ID: ids.authority, role: 'APPROVING_AUTHORITY', canManageAdmins: false, isActive: true, grantedAt: now },
    { ID: '33000000-0000-4000-8000-000000000006', user_ID: ids.delegate, role: 'APPROVING_AUTHORITY', canManageAdmins: false, isActive: true, grantedAt: now }
  ]))
  await db.run(INSERT.into('egas.RoutingUnit').entries({
    ID: ids.routing, nameAr: 'وحدة اختبار المرحلة الثانية', code: 'PHASE2A_TEST', isActive: true,
    createdAt: now, updatedAt: now
  }))
})

afterAll(async () => {
  if (!deployed) return
  await db.run(DELETE.from('egas.SecurityEvent').where({ correlationId: 'phase2a-test' }))
  await db.run(DELETE.from('egas.AuthorityDelegation'))
  await db.run(DELETE.from('egas.ApprovingAuthorityAssignment').where({ routingUnit_ID: ids.routing }))
  await db.run(DELETE.from('egas.AuthSession').where({ user_ID: { in: Object.values(ids) } }))
  await db.run(DELETE.from('egas.AuthLoginAttempt'))
  if (createdUserId) {
    await db.run(DELETE.from('egas.AuthSession').where({ user_ID: createdUserId }))
    await db.run(DELETE.from('egas.UserAccountRole').where({ user_ID: createdUserId }))
    await db.run(DELETE.from('egas.UserAccount').where({ ID: createdUserId }))
  }
  await db.run(DELETE.from('egas.UserAccountRole').where({ user_ID: { in: Object.values(ids) } }))
  await db.run(DELETE.from('egas.UserAccount').where({ ID: { in: Object.values(ids) } }))
  await db.run(DELETE.from('egas.RoutingUnit').where({ ID: ids.routing }))
})

describe('Phase 2A authentication and sessions', () => {
  it('creates an opaque session, stores only hashes, and enforces mandatory password change', async () => {
    const issued = await auth.login('phase2-admin', password, evidence)
    expect(issued.context).toMatchObject({
      userId: ids.admin, mustChangePassword: true, activeRole: 'ADMIN'
    })
    const stored = await db.run(
      SELECT.one.from('egas.AuthSession').where({ ID: issued.sessionId })
    ) as { tokenHash: string, csrfSecretHash: string }
    expect(stored.tokenHash).toBe(provider.hashSessionToken(issued.sessionToken))
    expect(stored.tokenHash).not.toBe(issued.sessionToken)
    expect(stored.csrfSecretHash).toBe(provider.hashSessionToken(issued.csrfToken))

    const response = { cookie: vi.fn(), setHeader: vi.fn() }
    issueSessionCookies(
      { http: { res: response } } as never,
      policy,
      issued.sessionToken,
      issued.csrfToken,
      issued.absoluteExpiresAt
    )
    expect(response.cookie).toHaveBeenCalledWith(
      policy.sessionCookieName, issued.sessionToken, expect.objectContaining({ httpOnly: true, sameSite: 'strict' })
    )
  })

  it('uses the same safe error for wrong and nonexistent usernames and rate-limits repeated failures', async () => {
    const first = auth.login('phase2-multi', 'wrong-password-value', evidence)
    await expect(first).rejects.toMatchObject({ status: 401, message: 'Invalid username or password' })
    await expect(auth.login('does-not-exist', 'wrong-password-value', evidence))
      .rejects.toMatchObject({ status: 401, message: 'Invalid username or password' })
    await expect(auth.login('phase2-multi', 'wrong-password-value', evidence))
      .rejects.toMatchObject({ status: 429 })
  })

  it('serializes simultaneous failures so the durable rate limit cannot be raced', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      auth.login('phase2-concurrent-unknown', 'wrong-password-value', {
        ...evidence, ipAddress: '127.0.0.20'
      })
    ))
    const statuses = attempts.map(result => result.status === 'rejected'
      ? (result.reason as SafeRequestError).status
      : 200)
    expect(statuses.filter(status => status === 401)).toHaveLength(2)
    expect(statuses.filter(status => status === 429)).toHaveLength(2)
  })

  it('rejects disabled and locked accounts without revealing their state', async () => {
    await expect(auth.login('phase2-disabled', password, { ...evidence, ipAddress: '127.0.0.2' }))
      .rejects.toMatchObject({ status: 401, message: 'Invalid username or password' })
    await expect(auth.login('phase2-locked', password, { ...evidence, ipAddress: '127.0.0.3' }))
      .rejects.toMatchObject({ status: 401, message: 'Invalid username or password' })
  })

  it('changes the temporary password transactionally, revokes the old session, and rotates credentials', async () => {
    const login = await auth.login('phase2-admin', password, { ...evidence, ipAddress: '127.0.0.4' })
    await expect(auth.changePassword(
      ids.admin, login.sessionId, password, 'short', evidence
    )).rejects.toMatchObject({ status: 400 })
    const changed = await auth.changePassword(
      ids.admin, login.sessionId, password, newPassword, evidence
    )
    expect(changed.context.mustChangePassword).toBe(false)
    expect(changed.sessionId).not.toBe(login.sessionId)
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
    await expect(provider.resolveSessionToken(changed.sessionToken)).resolves.toMatchObject({
      userId: ids.admin, activeRole: 'ADMIN', mustChangePassword: false
    })
  })

  it('selects exactly one assigned active role and revokes the previous session', async () => {
    const login = await auth.login('phase2-multi', password, { ...evidence, ipAddress: '127.0.0.5' })
    expect(login.context.activeRole).toBeNull()
    const selected = await auth.selectActiveRole(
      ids.multi, login.sessionId, 'ORGANIZATION', evidence
    )
    expect(selected.context.activeRole).toBe('ORGANIZATION')
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
    await expect(auth.selectActiveRole(ids.multi, selected.sessionId, 'APPROVING_AUTHORITY', evidence))
      .rejects.toMatchObject({ status: 403 })
    await db.run(UPDATE('egas.UserAccountRole').set({ isActive: false }).where({
      user_ID: ids.multi, role: 'ORGANIZATION'
    }))
    await expect(auth.selectActiveRole(ids.multi, selected.sessionId, 'ORGANIZATION', evidence))
      .rejects.toMatchObject({ status: 403 })
    await db.run(UPDATE('egas.UserAccountRole').set({ isActive: true }).where({
      user_ID: ids.multi, role: 'ORGANIZATION'
    }))
  })

  it('validates CSRF header, browser cookie, and per-session hash', async () => {
    const login = await auth.login('phase2-admin', newPassword, { ...evidence, ipAddress: '127.0.0.6' })
    const base = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    await expect(requireCsrf({ http: { req: base } } as never, db, policy, login.sessionId))
      .rejects.toMatchObject({ status: 403 })
    const invalid = {
      ...base,
      headers: {
        'x-csrf-token': 'invalid-token',
        cookie: `${policy.csrfCookieName}=invalid-token`
      }
    }
    await expect(requireCsrf({ http: { req: invalid } } as never, db, policy, login.sessionId))
      .rejects.toMatchObject({ status: 403 })
    const valid = {
      ...base,
      headers: {
        'x-csrf-token': login.csrfToken,
        cookie: `${policy.csrfCookieName}=${login.csrfToken}`
      }
    }
    await expect(requireCsrf({ http: { req: valid } } as never, db, policy, login.sessionId))
      .resolves.toBeUndefined()
    await auth.logout(ids.admin, login.sessionId, evidence)
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
  })

  it('rejects expired/revoked sessions and sessions for disabled accounts', async () => {
    const login = await auth.login('phase2-admin', newPassword, { ...evidence, ipAddress: '127.0.0.7' })
    await db.run(UPDATE('egas.AuthSession').set({ idleExpiresAt: new Date(0).toISOString() }).where({ ID: login.sessionId }))
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
    const second = await auth.login('phase2-admin', newPassword, { ...evidence, ipAddress: '127.0.0.8' })
    await db.run(UPDATE('egas.UserAccount').set({ isActive: false }).where({ ID: ids.admin }))
    await expect(provider.resolveSessionToken(second.sessionToken)).resolves.toBeNull()
    await db.run(UPDATE('egas.UserAccount').set({ isActive: true }).where({ ID: ids.admin }))
  })
})

describe('Phase 2A active-role authorization and Admin operations', () => {
  it('requires selected ADMIN and does not union an unselected Admin assignment', () => {
    expect(() => requireAdmin({
      user: { id: ids.multi, attr: { sessionId: 's', activeRole: 'ORGANIZATION', mustChangePassword: 'false' } }
    })).toThrowError(SafeRequestError)
    expect(() => requireAdmin({
      user: { id: ids.admin, attr: { sessionId: 's', activeRole: 'ADMIN', mustChangePassword: 'true', canManageAdmins: 'true' } }
    })).toThrowError(SafeRequestError)
    expect(requireAdmin({
      user: { id: ids.secondAdmin, attr: { sessionId: 's', activeRole: 'ADMIN', mustChangePassword: 'false', canManageAdmins: 'true' } }
    })).toMatchObject({ activeRole: 'ADMIN', canManageAdmins: true })
  })

  it('creates a multi-role user, prevents duplicates, revokes roles, and invalidates sessions', async () => {
    const operations = new AdminAccountOperations(db)
    const actor = { userId: ids.secondAdmin, canManageAdmins: true }
    const created = await operations.createUser(actor, {
      username: 'phase2-created',
      staffIdentifier: 'SYNTH-PHASE2A',
      displayName: 'Created User',
      temporaryPassword: 'synthetic-temporary-password',
      roles: [
        { role: 'EMPLOYEE_AFFAIRS', canManageAdmins: false },
        { role: 'ORGANIZATION', canManageAdmins: false }
      ]
    }, evidence)
    createdUserId = created.ID
    expect(created.roles).toHaveLength(2)
    const page = await operations.listUsers('phase2', 0, 5)
    expect(page.length).toBeLessThanOrEqual(5)
    expect(JSON.stringify(page)).not.toContain('passwordHash')
    const updated = await operations.updateUser(actor, {
      userId: created.ID,
      expectedVersion: created.version,
      staffIdentifier: 'SYNTH-PHASE2A',
      displayName: 'Updated Created User',
      jobTitle: 'Synthetic Role'
    }, evidence)
    expect(updated.displayName).toBe('Updated Created User')
    await expect(operations.createUser(actor, {
      username: 'phase2-created', displayName: 'Duplicate',
      temporaryPassword: 'synthetic-temporary-password', roles: [{ role: 'ORGANIZATION' }]
    }, evidence)).rejects.toMatchObject({ status: 409 })
    await operations.assignRole(actor, {
      userId: created.ID, role: 'APPROVING_AUTHORITY', canManageAdmins: false
    }, evidence)
    const login = await auth.login('phase2-created', 'synthetic-temporary-password', {
      ...evidence, ipAddress: '127.0.0.9'
    })
    await operations.revokeRole(actor, { userId: created.ID, role: 'ORGANIZATION' }, evidence)
    await expect(provider.resolveSessionToken(login.sessionToken)).resolves.toBeNull()
    const current = await operations.getUser(created.ID)
    const disabled = await operations.setAccountActive(
      actor, { userId: created.ID, expectedVersion: current.version }, false, evidence
    )
    await expect(auth.login('phase2-created', 'synthetic-temporary-password', {
      ...evidence, ipAddress: '127.0.0.10'
    })).rejects.toMatchObject({ status: 401 })
    await operations.setAccountActive(
      actor, { userId: created.ID, expectedVersion: disabled.version }, true, evidence
    )
  })

  it('enforces Manage-Admins, self-management, unlock, reset, and last-privileged-Admin protections', async () => {
    const operations = new AdminAccountOperations(db)
    const unprivileged = { userId: ids.multi, canManageAdmins: false }
    await expect(operations.setAccountActive(
      unprivileged, { userId: ids.secondAdmin, expectedVersion: 1 }, false, evidence
    )).rejects.toMatchObject({ status: 403 })
    await expect(operations.revokeRole(
      { userId: ids.secondAdmin, canManageAdmins: true },
      { userId: ids.secondAdmin, role: 'ADMIN' }, evidence
    )).rejects.toMatchObject({ status: 403 })
    await operations.unlockUser(
      { userId: ids.secondAdmin, canManageAdmins: true },
      { userId: ids.locked, expectedVersion: 1 }, evidence
    )
    const unlocked = await db.run(
      SELECT.one.from('egas.UserAccount').columns('failedLoginCount', 'lockedUntil').where({ ID: ids.locked })
    ) as { failedLoginCount: number, lockedUntil: string | null }
    expect(unlocked).toMatchObject({ failedLoginCount: 0, lockedUntil: null })
    const multi = await operations.getUser(ids.multi)
    await operations.resetPassword(
      { userId: ids.secondAdmin, canManageAdmins: true },
      {
        userId: ids.multi, expectedVersion: multi.version,
        temporaryPassword: 'synthetic-reset-password'
      }, evidence
    )
    const reset = await db.run(
      SELECT.one.from('egas.UserAccount').columns('mustChangePassword').where({ ID: ids.multi })
    ) as { mustChangePassword: boolean }
    expect(reset.mustChangePassword).toBe(true)

    const privileged = { userId: ids.admin, canManageAdmins: true }
    const disabled = await operations.setAccountActive(
      privileged, { userId: ids.secondAdmin, expectedVersion: 1 }, false, evidence
    )
    await expect(operations.setAccountActive(
      { userId: ids.secondAdmin, canManageAdmins: true },
      { userId: ids.admin, expectedVersion: 1 }, false, evidence
    )).rejects.toMatchObject({ status: 409 })
    await operations.setAccountActive(
      privileged, { userId: ids.secondAdmin, expectedVersion: disabled.version }, true, evidence
    )
  })
})

describe('Phase 2A authority assignments and delegation', () => {
  it('validates eligibility and one active primary authority per routing unit', async () => {
    const operations = new AuthorityOperations(db)
    const actor = { userId: ids.secondAdmin, canManageAdmins: true }
    const assignment = await operations.createAssignment(actor, {
      routingUnitId: ids.routing,
      userAccountId: ids.authority,
      authorityKind: 'DEPUTY',
      authorityJobTitle: 'Synthetic Deputy',
      isPrimary: true
    }, evidence)
    expect(assignment).toMatchObject({ routingUnit_ID: ids.routing, userAccount_ID: ids.authority })
    await expect(operations.createAssignment(actor, {
      routingUnitId: ids.routing,
      userAccountId: ids.delegate,
      authorityKind: 'ASSISTANT',
      authorityJobTitle: 'Synthetic Assistant',
      isPrimary: true
    }, evidence)).rejects.toMatchObject({ status: 409 })
    await expect(operations.createAssignment(actor, {
      routingUnitId: ids.routing,
      userAccountId: ids.disabled,
      authorityKind: 'OTHER',
      authorityJobTitle: 'Ineligible',
      isPrimary: false
    }, evidence)).rejects.toMatchObject({ status: 400 })
  })

  it('creates valid delegation and rejects self-delegation and invalid dates', async () => {
    const operations = new AuthorityOperations(db)
    const actor = { userId: ids.secondAdmin, canManageAdmins: true }
    const assignments = await operations.listAssignments(ids.routing, true)
    const assignment = assignments[0]
    expect(assignment).toBeDefined()
    const delegation = await operations.createDelegation(actor, {
      assignmentId: assignment?.ID,
      delegatedUserId: ids.delegate,
      validFrom: new Date().toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'Synthetic temporary coverage'
    }, evidence)
    expect(delegation.delegatedUser_ID).toBe(ids.delegate)
    const updatedDelegation = await operations.updateDelegation(actor, {
      delegationId: delegation.ID,
      expectedVersion: delegation.version,
      validFrom: delegation.validFrom,
      validTo: new Date(Date.now() + 172_800_000).toISOString(),
      reason: 'Updated synthetic coverage'
    }, evidence)
    expect(updatedDelegation.version).toBe(delegation.version + 1)
    await expect(operations.createDelegation(actor, {
      assignmentId: assignment?.ID,
      delegatedUserId: ids.authority
    }, evidence)).rejects.toMatchObject({ status: 400 })
    await expect(operations.createDelegation(actor, {
      assignmentId: assignment?.ID,
      delegatedUserId: ids.delegate,
      validFrom: '2026-08-20T00:00:00.000Z',
      validTo: '2026-08-19T00:00:00.000Z'
    }, evidence)).rejects.toMatchObject({ status: 400 })
    const deactivated = await operations.deactivateDelegation(actor, {
      delegationId: updatedDelegation.ID,
      expectedVersion: updatedDelegation.version
    }, evidence)
    expect(deactivated.isActive).toBe(false)

    const updatedAssignment = await operations.updateAssignment(actor, {
      assignmentId: assignment?.ID,
      expectedVersion: assignment?.version,
      authorityKind: 'ACTING_DEPUTY',
      authorityJobTitle: 'Synthetic Acting Deputy',
      isPrimary: true,
      validFrom: assignment?.validFrom,
      validTo: null,
      notes: 'Updated in test'
    }, evidence)
    expect(updatedAssignment.version).toBe((assignment?.version ?? 0) + 1)
    const deactivatedAssignment = await operations.deactivateAssignment(actor, {
      assignmentId: updatedAssignment.ID,
      expectedVersion: updatedAssignment.version
    }, evidence)
    expect(deactivatedAssignment.isActive).toBe(false)
  })
})

describe('Phase 2A production authentication configuration', () => {
  it('uses local auth in development/production and confines mocked auth to tests', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: { start: string }
      cds: { requires: { auth: Record<string, { impl?: string, kind?: string }> } }
    }
    const authConfig = packageJson.cds.requires.auth
    expect(authConfig['[development]']?.impl).toBe('srv/auth/local-auth-middleware.ts')
    expect(authConfig['[production]']?.impl).toBe('srv/auth/local-auth-middleware.ts')
    expect(authConfig['[test]']?.kind).toBe('mocked')
    expect(packageJson.scripts.start).toBe('cds serve')
  })

  it('fails closed when production cookie or fingerprint configuration is insecure', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('EGAS_AUTH_FINGERPRINT_SECRET', '')
    vi.stubEnv('EGAS_REQUIRE_SECURE_COOKIE', 'true')
    expect(() => loadSecurityPolicy()).toThrow('EGAS_AUTH_FINGERPRINT_SECRET')
    vi.stubEnv('EGAS_AUTH_FINGERPRINT_SECRET', 'synthetic-production-fingerprint-secret')
    vi.stubEnv('EGAS_REQUIRE_SECURE_COOKIE', 'false')
    expect(() => loadSecurityPolicy()).toThrow('Production requires')
    vi.unstubAllEnvs()
  })
})
