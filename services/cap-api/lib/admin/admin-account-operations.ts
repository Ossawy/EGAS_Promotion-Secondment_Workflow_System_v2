import { randomUUID } from 'node:crypto'
import type { Service } from '@sap/cds'
import { recordSecurityEvent } from '../audit/security-events.ts'
import type { RequestEvidence } from '../auth/auth-operations.ts'
import { LocalAuthenticationProvider } from '../auth/local-authentication-provider.ts'
import { type ActiveRole, SafeRequestError, validatePassword } from '../auth/security-policy.ts'
import {
  expectedVersion, optionalText, requiredBoolean, requiredRole, requiredText, requiredUuid
} from './validation.ts'

export type AdminActor = {
  userId: string
  canManageAdmins: boolean
}

type AccountRow = {
  ID: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  failedLoginCount: number
  lockedUntil: string | null
  createdAt: string
  updatedAt: string
  version: number
}

type RoleRow = {
  ID: string
  user_ID: string
  role: ActiveRole
  canManageAdmins: boolean
  isActive: boolean
  grantedAt: string
  revokedAt: string | null
}

export type UserView = Omit<AccountRow, 'failedLoginCount' | 'lockedUntil'> & {
  isLocked: boolean
  roles: Array<{ role: ActiveRole, canManageAdmins: boolean, isActive: boolean }>
}

export type RoleInput = { role: unknown, canManageAdmins?: unknown }

function timestamp(): string {
  return new Date().toISOString()
}

function username(value: unknown): string {
  const result = requiredText(value, 'username', 120, 3)
  if (!/^[\p{L}\p{N}._@-]+$/u.test(result)) {
    throw new SafeRequestError(400, 'username contains unsupported characters')
  }
  return result
}

export class AdminAccountOperations {
  private readonly db: Service
  private readonly passwords: LocalAuthenticationProvider

  constructor(db: Service) {
    this.db = db
    this.passwords = new LocalAuthenticationProvider(db)
  }

  private async account(db: Service, userId: string): Promise<AccountRow> {
    const row = await db.run(
      SELECT.one.from('egas.UserAccount')
        .columns(
          'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle',
          'mustChangePassword', 'isActive', 'failedLoginCount', 'lockedUntil',
          'createdAt', 'updatedAt', 'version'
        )
        .where({ ID: userId })
    ) as AccountRow | undefined
    if (!row) throw new SafeRequestError(404, 'User account not found')
    return row
  }

  private async roles(db: Service, userId: string): Promise<RoleRow[]> {
    return await db.run(
      SELECT.from('egas.UserAccountRole')
        .columns('ID', 'user_ID', 'role', 'canManageAdmins', 'isActive', 'grantedAt', 'revokedAt')
        .where({ user_ID: userId })
        .orderBy('role')
    ) as RoleRow[]
  }

  private async view(db: Service, account: AccountRow): Promise<UserView> {
    const roles = await this.roles(db, account.ID)
    const { failedLoginCount: _failed, lockedUntil, ...safe } = account
    return {
      ...safe,
      isLocked: Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now()),
      roles: roles.map(({ role, canManageAdmins, isActive }) => ({ role, canManageAdmins, isActive }))
    }
  }

  private async targetHasAdminRole(db: Service, userId: string): Promise<boolean> {
    const row = await db.run(
      SELECT.one.from('egas.UserAccountRole').columns('ID')
        .where({ user_ID: userId, role: 'ADMIN', isActive: true })
    ) as { ID: string } | undefined
    return Boolean(row)
  }

  private requireManageAdmins(actor: AdminActor): void {
    if (!actor.canManageAdmins) {
      throw new SafeRequestError(403, 'Manage Admins privilege required', 'MANAGE_ADMINS_REQUIRED')
    }
  }

  private async lockPrivilegedAdminInvariant(db: Service): Promise<void> {
    if ((db as Service & { kind?: string }).kind === 'postgres') {
      await db.run("SELECT pg_advisory_xact_lock(hashtext('egas.manage-admins.invariant'))")
    }
  }

  private async ensureAnotherPrivilegedAdmin(db: Service, excludedUserId: string): Promise<void> {
    const roles = await db.run(
      SELECT.from('egas.UserAccountRole').columns('user_ID')
        .where({ role: 'ADMIN', canManageAdmins: true, isActive: true })
    ) as Array<{ user_ID: string }>
    for (const role of roles) {
      if (role.user_ID === excludedUserId) continue
      const account = await db.run(
        SELECT.one.from('egas.UserAccount').columns('ID').where({ ID: role.user_ID, isActive: true })
      ) as { ID: string } | undefined
      if (account) return
    }
    throw new SafeRequestError(409, 'Operation would leave no active Manage-Admins account')
  }

  private async revokeSessions(db: Service, userId: string, reason: string): Promise<void> {
    await db.run(UPDATE('egas.AuthSession').set({
      revokedAt: timestamp(), revokedReason: reason
    }).where({ user_ID: userId, revokedAt: null }))
  }

  async listUsers(searchValue: unknown, skipValue: unknown, topValue: unknown): Promise<UserView[]> {
    const search = optionalText(searchValue, 'search', 120)
    const skip = Number.isSafeInteger(skipValue) && (skipValue as number) >= 0
      ? Math.min(skipValue as number, 100_000) : 0
    const top = Number.isSafeInteger(topValue) && (topValue as number) > 0
      ? Math.min(topValue as number, 100) : 25
    let query = SELECT.from('egas.UserAccount')
      .columns(
        'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle',
        'mustChangePassword', 'isActive', 'failedLoginCount', 'lockedUntil',
        'createdAt', 'updatedAt', 'version'
      )
    if (search) {
      const pattern = `%${search.toLocaleLowerCase('en-US')}%`
      query = query.where`lower(username) like ${pattern} or lower(displayName) like ${pattern} or lower(staffIdentifier) like ${pattern}`
    }
    const accounts = await this.db.run(query.orderBy('username').limit(top, skip)) as AccountRow[]
    return await Promise.all(accounts.map(async account => await this.view(this.db, account)))
  }

  async getUser(userIdValue: unknown): Promise<UserView> {
    const userId = requiredUuid(userIdValue, 'userId')
    return await this.view(this.db, await this.account(this.db, userId))
  }

  async createUser(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const normalizedUsername = username(input.username)
    const displayName = requiredText(input.displayName, 'displayName', 300)
    const staffIdentifier = optionalText(input.staffIdentifier, 'staffIdentifier', 120)
    const jobTitle = optionalText(input.jobTitle, 'jobTitle', 300)
    const temporaryPassword = validatePassword(input.temporaryPassword, 'temporaryPassword')
    const isActive = input.isActive === undefined ? true : requiredBoolean(input.isActive, 'isActive')
    if (!Array.isArray(input.roles) || input.roles.length === 0 || input.roles.length > 4) {
      throw new SafeRequestError(400, 'roles must contain 1-4 assignments')
    }
    const roleInputs = input.roles.map(value => {
      if (!value || typeof value !== 'object') throw new SafeRequestError(400, 'Invalid role assignment')
      const item = value as RoleInput
      const role = requiredRole(item.role)
      const canManageAdmins = item.canManageAdmins === undefined
        ? false : requiredBoolean(item.canManageAdmins, 'canManageAdmins')
      if (canManageAdmins && role !== 'ADMIN') {
        throw new SafeRequestError(400, 'canManageAdmins is valid only for ADMIN')
      }
      return { role, canManageAdmins }
    })
    if (new Set(roleInputs.map(role => role.role)).size !== roleInputs.length) {
      throw new SafeRequestError(400, 'Duplicate roles are not allowed')
    }
    if (roleInputs.some(role => role.role === 'ADMIN')) this.requireManageAdmins(actor)
    const passwordHash = await this.passwords.hashPassword(temporaryPassword)

    return await this.db.tx(async tx => {
      const duplicate = await tx.run(
        SELECT.one.from('egas.UserAccount').columns('ID').where({ username: normalizedUsername })
      ) as { ID: string } | undefined
      if (duplicate) throw new SafeRequestError(409, 'Username is already in use')
      if (staffIdentifier) {
        const staffDuplicate = await tx.run(
          SELECT.one.from('egas.UserAccount').columns('ID').where({ staffIdentifier })
        ) as { ID: string } | undefined
        if (staffDuplicate) throw new SafeRequestError(409, 'Staff identifier is already in use')
      }
      const userId = randomUUID()
      const now = timestamp()
      await tx.run(INSERT.into('egas.UserAccount').entries({
        ID: userId,
        username: normalizedUsername,
        staffIdentifier,
        displayName,
        jobTitle,
        passwordHash,
        mustChangePassword: true,
        isActive,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: now,
        createdBy_ID: actor.userId,
        updatedAt: now,
        version: 1
      }))
      await tx.run(INSERT.into('egas.UserAccountRole').entries(roleInputs.map(role => ({
        ID: randomUUID(),
        user_ID: userId,
        role: role.role,
        canManageAdmins: role.canManageAdmins,
        isActive: true,
        grantedBy_ID: actor.userId,
        grantedAt: now
      }))))
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_USER_CREATED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId, roles: roleInputs.map(role => role.role), isActive }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async updateUser(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const version = expectedVersion(input.expectedVersion)
    const displayName = requiredText(input.displayName, 'displayName', 300)
    const staffIdentifier = optionalText(input.staffIdentifier, 'staffIdentifier', 120)
    const jobTitle = optionalText(input.jobTitle, 'jobTitle', 300)
    return await this.db.tx(async tx => {
      const account = await this.account(tx, userId)
      if (account.version !== version) throw new SafeRequestError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(tx, userId)) this.requireManageAdmins(actor)
      if (staffIdentifier) {
        const duplicate = await tx.run(
          SELECT.one.from('egas.UserAccount').columns('ID').where({ staffIdentifier })
        ) as { ID: string } | undefined
        if (duplicate && duplicate.ID !== userId) {
          throw new SafeRequestError(409, 'Staff identifier is already in use')
        }
      }
      const affected = await tx.run(UPDATE('egas.UserAccount').set({
        displayName, staffIdentifier, jobTitle, updatedAt: timestamp(), version: account.version + 1
      }).where({ ID: userId, version: account.version }))
      if (affected !== 1) throw new SafeRequestError(409, 'User was modified by another request')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_USER_UPDATED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async assignRole(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const role = requiredRole(input.role)
    const canManageAdmins = input.canManageAdmins === undefined
      ? false : requiredBoolean(input.canManageAdmins, 'canManageAdmins')
    if (canManageAdmins && role !== 'ADMIN') {
      throw new SafeRequestError(400, 'canManageAdmins is valid only for ADMIN')
    }
    if (userId === actor.userId) throw new SafeRequestError(403, 'Self role changes are prohibited')
    if (role === 'ADMIN') this.requireManageAdmins(actor)
    return await this.db.tx(async tx => {
      await this.account(tx, userId)
      const existing = await tx.run(
        SELECT.one.from('egas.UserAccountRole').columns('ID', 'canManageAdmins', 'isActive')
          .where({ user_ID: userId, role })
      ) as { ID: string, canManageAdmins: boolean, isActive: boolean } | undefined
      const now = timestamp()
      if (
        role === 'ADMIN' && existing?.isActive && existing.canManageAdmins
        && !canManageAdmins && (await this.account(tx, userId)).isActive
      ) {
        await this.lockPrivilegedAdminInvariant(tx)
        await this.ensureAnotherPrivilegedAdmin(tx, userId)
      }
      if (existing) {
        await tx.run(UPDATE('egas.UserAccountRole').set({
          canManageAdmins,
          isActive: true,
          grantedBy_ID: actor.userId,
          grantedAt: now,
          revokedBy_ID: null,
          revokedAt: null
        }).where({ ID: existing.ID }))
      } else {
        await tx.run(INSERT.into('egas.UserAccountRole').entries({
          ID: randomUUID(), user_ID: userId, role, canManageAdmins, isActive: true,
          grantedBy_ID: actor.userId, grantedAt: now
        }))
      }
      await this.revokeSessions(tx, userId, 'ROLE_CHANGED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_ROLE_ASSIGNED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId, role, canManageAdmins }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async revokeRole(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const role = requiredRole(input.role)
    if (userId === actor.userId) throw new SafeRequestError(403, 'Self role changes are prohibited')
    if (role === 'ADMIN') this.requireManageAdmins(actor)
    return await this.db.tx(async tx => {
      const account = await this.account(tx, userId)
      const assignment = await tx.run(
        SELECT.one.from('egas.UserAccountRole').columns('ID', 'canManageAdmins', 'isActive')
          .where({ user_ID: userId, role })
      ) as { ID: string, canManageAdmins: boolean, isActive: boolean } | undefined
      if (!assignment?.isActive) return await this.view(tx, account)
      if (role === 'ADMIN' && assignment.canManageAdmins && account.isActive) {
        await this.lockPrivilegedAdminInvariant(tx)
        await this.ensureAnotherPrivilegedAdmin(tx, userId)
      }
      await tx.run(UPDATE('egas.UserAccountRole').set({
        isActive: false,
        canManageAdmins: false,
        revokedBy_ID: actor.userId,
        revokedAt: timestamp()
      }).where({ ID: assignment.ID }))
      await this.revokeSessions(tx, userId, 'ROLE_REVOKED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_ROLE_REVOKED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId, role, canManageAdmins: assignment.canManageAdmins }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async setAccountActive(
    actor: AdminActor,
    input: Record<string, unknown>,
    active: boolean,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const version = expectedVersion(input.expectedVersion)
    if (!active && userId === actor.userId) {
      throw new SafeRequestError(403, 'Self-deactivation is prohibited')
    }
    return await this.db.tx(async tx => {
      const account = await this.account(tx, userId)
      if (account.version !== version) throw new SafeRequestError(409, 'User was modified by another request')
      const targetAdmin = await this.targetHasAdminRole(tx, userId)
      if (targetAdmin) this.requireManageAdmins(actor)
      if (!active && account.isActive) {
        const privileged = await tx.run(
          SELECT.one.from('egas.UserAccountRole').columns('ID')
            .where({ user_ID: userId, role: 'ADMIN', canManageAdmins: true, isActive: true })
        ) as { ID: string } | undefined
        if (privileged) {
          await this.lockPrivilegedAdminInvariant(tx)
          await this.ensureAnotherPrivilegedAdmin(tx, userId)
        }
      }
      if (account.isActive !== active) {
        const affected = await tx.run(UPDATE('egas.UserAccount').set({
          isActive: active,
          deactivatedAt: active ? null : timestamp(),
          deactivatedBy_ID: active ? null : actor.userId,
          updatedAt: timestamp(),
          version: account.version + 1
        }).where({ ID: userId, version: account.version }))
        if (affected !== 1) throw new SafeRequestError(409, 'User was modified by another request')
      }
      if (!active) await this.revokeSessions(tx, userId, 'ACCOUNT_DISABLED')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: active ? 'ADMIN_ACCOUNT_ENABLED' : 'ADMIN_ACCOUNT_DISABLED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async unlockUser(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const version = expectedVersion(input.expectedVersion)
    return await this.db.tx(async tx => {
      const account = await this.account(tx, userId)
      if (account.version !== version) throw new SafeRequestError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(tx, userId)) this.requireManageAdmins(actor)
      const affected = await tx.run(UPDATE('egas.UserAccount').set({
        failedLoginCount: 0, lockedUntil: null, updatedAt: timestamp(), version: account.version + 1
      }).where({ ID: userId, version: account.version }))
      if (affected !== 1) throw new SafeRequestError(409, 'User was modified by another request')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_ACCOUNT_UNLOCKED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }

  async resetPassword(
    actor: AdminActor,
    input: Record<string, unknown>,
    evidence: RequestEvidence
  ): Promise<UserView> {
    const userId = requiredUuid(input.userId, 'userId')
    const version = expectedVersion(input.expectedVersion)
    if (userId === actor.userId) {
      throw new SafeRequestError(403, 'Use changePassword for your own account')
    }
    const temporaryPassword = validatePassword(input.temporaryPassword, 'temporaryPassword')
    const passwordHash = await this.passwords.hashPassword(temporaryPassword)
    return await this.db.tx(async tx => {
      const account = await this.account(tx, userId)
      if (account.version !== version) throw new SafeRequestError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(tx, userId)) this.requireManageAdmins(actor)
      const affected = await tx.run(UPDATE('egas.UserAccount').set({
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: timestamp(),
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: timestamp(),
        version: account.version + 1
      }).where({ ID: userId, version: account.version }))
      if (affected !== 1) throw new SafeRequestError(409, 'User was modified by another request')
      await this.revokeSessions(tx, userId, 'PASSWORD_RESET')
      await recordSecurityEvent(tx, {
        actorUserId: actor.userId,
        eventType: 'ADMIN_PASSWORD_RESET',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { targetUserId: userId, sessionsRevoked: true }
      })
      return await this.view(tx, await this.account(tx, userId))
    })
  }
}
