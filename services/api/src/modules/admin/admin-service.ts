import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { LocalAuthenticationProvider } from '../auth/local-authentication-provider.ts'
import type { AppConfig } from '../../config/env.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { requireRole, type Role } from '../../shared/roles.ts'
import { bool, optionalText, password, text, uuid, version } from '../../shared/validation.ts'

export type AdminActor = { userId: string, canManageAdmins: boolean }

type AccountRow = {
  id: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  failedLoginCount: number
  lockedUntil: Date | string | null
  createdAt: Date | string
  updatedAt: Date | string
  version: number
}

export type UserView = Omit<AccountRow, 'failedLoginCount' | 'lockedUntil'> & {
  isLocked: boolean
  roles: Array<{ role: Role, canManageAdmins: boolean, isActive: boolean }>
}

function accountProjection(): string {
  return `id, username, staffidentifier AS "staffIdentifier", displayname AS "displayName",
    jobtitle AS "jobTitle", mustchangepassword AS "mustChangePassword", isactive AS "isActive",
    failedlogincount AS "failedLoginCount", lockeduntil AS "lockedUntil",
    createdat AS "createdAt", updatedat AS "updatedAt", version`
}

export class AdminService {
  private readonly passwords: LocalAuthenticationProvider

  constructor(private readonly pool: Pool, config: AppConfig) {
    this.passwords = new LocalAuthenticationProvider(pool, config)
  }

  private requireManageAdmins(actor: AdminActor): void {
    if (!actor.canManageAdmins) throw new AppError(403, 'Manage-Admins privilege required')
  }

  private async account(db: Queryable, id: string): Promise<AccountRow> {
    const result = await db.query<AccountRow>(
      `SELECT ${accountProjection()} FROM egas_useraccount WHERE id=$1`, [id]
    )
    if (!result.rows[0]) throw new AppError(404, 'User account not found')
    return result.rows[0]
  }

  private async view(db: Queryable, account: AccountRow): Promise<UserView> {
    const roles = await db.query<{ role: Role, canManageAdmins: boolean, isActive: boolean }>(
      `SELECT role, canmanageadmins AS "canManageAdmins", isactive AS "isActive"
         FROM egas_useraccountrole WHERE user_id=$1 ORDER BY role`, [account.id]
    )
    const { failedLoginCount: _failed, lockedUntil, ...safe } = account
    return {
      ...safe,
      isLocked: Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now()),
      roles: roles.rows
    }
  }

  private async targetHasAdminRole(db: Queryable, userId: string): Promise<boolean> {
    const result = await db.query(
      `SELECT 1 FROM egas_useraccountrole WHERE user_id=$1 AND role='ADMIN' AND isactive=TRUE`, [userId]
    )
    return Boolean(result.rows[0])
  }

  private async revokeSessions(db: Queryable, userId: string, reason: string): Promise<void> {
    await db.query(
      `UPDATE egas_authsession SET revokedat=CURRENT_TIMESTAMP, revokedreason=$2
        WHERE user_id=$1 AND revokedat IS NULL`, [userId, reason]
    )
  }

  private async lockPrivilegedInvariant(db: Queryable): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('egas.manage-admins.invariant'))")
  }

  private async ensureAnotherPrivilegedAdmin(db: Queryable, excludedUserId: string): Promise<void> {
    const result = await db.query(
      `SELECT 1 FROM egas_useraccount a
       JOIN egas_useraccountrole r ON r.user_id=a.id
       WHERE a.isactive=TRUE AND r.isactive=TRUE AND r.role='ADMIN'
         AND r.canmanageadmins=TRUE AND a.id<>$1 LIMIT 1`, [excludedUserId]
    )
    if (!result.rows[0]) throw new AppError(409, 'At least one active Manage-Admins account must remain')
  }

  async listUsers(searchValue: unknown, skipValue: unknown, topValue: unknown): Promise<UserView[]> {
    const search = typeof searchValue === 'string' ? searchValue.trim().slice(0, 120) : ''
    const skip = Number.isSafeInteger(skipValue) ? Math.max(0, skipValue as number) : 0
    const top = Number.isSafeInteger(topValue) ? Math.max(1, Math.min(100, topValue as number)) : 50
    const result = await this.pool.query<AccountRow>(
      `SELECT ${accountProjection()} FROM egas_useraccount
        WHERE $1='' OR username ILIKE '%' || $1 || '%'
           OR displayname ILIKE '%' || $1 || '%'
           OR COALESCE(staffidentifier,'') ILIKE '%' || $1 || '%'
        ORDER BY username LIMIT $2 OFFSET $3`, [search, top, skip]
    )
    return await Promise.all(result.rows.map(async row => await this.view(this.pool, row)))
  }

  async getUser(idValue: unknown): Promise<UserView> {
    const id = uuid(idValue, 'userId')
    return await this.view(this.pool, await this.account(this.pool, id))
  }

  async createUser(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const normalizedUsername = text(input.username, 'username', 120, 3)
    if (!/^[\p{L}\p{N}._@-]+$/u.test(normalizedUsername)) throw new AppError(400, 'username contains unsupported characters')
    const displayName = text(input.displayName, 'displayName', 300)
    const staffIdentifier = optionalText(input.staffIdentifier, 'staffIdentifier', 120)
    const jobTitle = optionalText(input.jobTitle, 'jobTitle', 300)
    const temporaryPassword = password(input.temporaryPassword, 'temporaryPassword')
    const isActive = input.isActive === undefined ? true : bool(input.isActive, 'isActive')
    if (!Array.isArray(input.roles) || input.roles.length === 0) throw new AppError(400, 'At least one role is required')
    const seen = new Set<Role>()
    const roles = input.roles.map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, `roles[${index}] is invalid`)
      const record = value as Record<string, unknown>
      const role = requireRole(record.role)
      if (seen.has(role)) throw new AppError(400, 'Duplicate roles are not allowed')
      seen.add(role)
      const canManageAdmins = record.canManageAdmins === undefined ? false : bool(record.canManageAdmins, 'canManageAdmins')
      if (canManageAdmins && role !== 'ADMIN') throw new AppError(400, 'canManageAdmins is valid only for ADMIN')
      if (role === 'ADMIN') this.requireManageAdmins(actor)
      return { role, canManageAdmins }
    })
    const hash = await this.passwords.hashPassword(temporaryPassword)
    try {
      return await withTransaction(this.pool, async db => {
        const id = randomUUID()
        await db.query(
          `INSERT INTO egas_useraccount
            (id,username,staffidentifier,displayname,jobtitle,passwordhash,mustchangepassword,
             isactive,failedlogincount,lockeduntil,createdat,createdby_id,updatedat,version)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,0,NULL,CURRENT_TIMESTAMP,$8,CURRENT_TIMESTAMP,1)`,
          [id, normalizedUsername, staffIdentifier, displayName, jobTitle, hash, isActive, actor.userId]
        )
        for (const role of roles) {
          await db.query(
            `INSERT INTO egas_useraccountrole
              (id,user_id,role,canmanageadmins,isactive,grantedby_id,grantedat)
             VALUES ($1,$2,$3,$4,TRUE,$5,CURRENT_TIMESTAMP)`,
            [randomUUID(), id, role.role, role.canManageAdmins, actor.userId]
          )
        }
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'ADMIN_USER_CREATED', ...evidence,
          details: { targetUserId: id, roles: roles.map(role => role.role), isActive }
        })
        return await this.view(db, await this.account(db, id))
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Username or staff identifier is already in use')
      throw error
    }
  }

  async updateUser(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const expected = version(input.expectedVersion)
    const displayName = text(input.displayName, 'displayName', 300)
    const staffIdentifier = optionalText(input.staffIdentifier, 'staffIdentifier', 120)
    const jobTitle = optionalText(input.jobTitle, 'jobTitle', 300)
    try {
      return await withTransaction(this.pool, async db => {
        const current = await this.account(db, id)
        if (current.version !== expected) throw new AppError(409, 'User was modified by another request')
        if (await this.targetHasAdminRole(db, id)) this.requireManageAdmins(actor)
        const updated = await db.query(
          `UPDATE egas_useraccount SET staffidentifier=$3, displayname=$4, jobtitle=$5,
              updatedat=CURRENT_TIMESTAMP, version=version+1 WHERE id=$1 AND version=$2`,
          [id, expected, staffIdentifier, displayName, jobTitle]
        )
        if (updated.rowCount !== 1) throw new AppError(409, 'User was modified by another request')
        await recordSecurityEvent(db, {
          actorUserId: actor.userId, eventType: 'ADMIN_USER_UPDATED', ...evidence,
          details: { targetUserId: id }
        })
        return await this.view(db, await this.account(db, id))
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'Staff identifier is already in use')
      throw error
    }
  }

  async assignRole(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const role = requireRole(input.role)
    const canManageAdmins = input.canManageAdmins === undefined ? false : bool(input.canManageAdmins, 'canManageAdmins')
    if (canManageAdmins && role !== 'ADMIN') throw new AppError(400, 'canManageAdmins is valid only for ADMIN')
    if (id === actor.userId) throw new AppError(403, 'Self role changes are prohibited')
    if (role === 'ADMIN') this.requireManageAdmins(actor)
    return await withTransaction(this.pool, async db => {
      const account = await this.account(db, id)
      const existing = await db.query<{ id: string, canManageAdmins: boolean, isActive: boolean }>(
        `SELECT id, canmanageadmins AS "canManageAdmins", isactive AS "isActive"
           FROM egas_useraccountrole WHERE user_id=$1 AND role=$2`, [id, role]
      )
      const assignment = existing.rows[0]
      if (role === 'ADMIN' && assignment?.isActive && assignment.canManageAdmins && !canManageAdmins && account.isActive) {
        await this.lockPrivilegedInvariant(db)
        await this.ensureAnotherPrivilegedAdmin(db, id)
      }
      if (assignment) {
        await db.query(
          `UPDATE egas_useraccountrole SET canmanageadmins=$2,isactive=TRUE,grantedby_id=$3,
              grantedat=CURRENT_TIMESTAMP,revokedby_id=NULL,revokedat=NULL WHERE id=$1`,
          [assignment.id, canManageAdmins, actor.userId]
        )
      } else {
        await db.query(
          `INSERT INTO egas_useraccountrole
            (id,user_id,role,canmanageadmins,isactive,grantedby_id,grantedat)
           VALUES ($1,$2,$3,$4,TRUE,$5,CURRENT_TIMESTAMP)`,
          [randomUUID(), id, role, canManageAdmins, actor.userId]
        )
      }
      await this.revokeSessions(db, id, 'ROLE_CHANGED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'ADMIN_ROLE_ASSIGNED', ...evidence,
        details: { targetUserId: id, role, canManageAdmins }
      })
      return await this.view(db, await this.account(db, id))
    })
  }

  async revokeRole(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const role = requireRole(input.role)
    if (id === actor.userId) throw new AppError(403, 'Self role changes are prohibited')
    if (role === 'ADMIN') this.requireManageAdmins(actor)
    return await withTransaction(this.pool, async db => {
      const account = await this.account(db, id)
      const result = await db.query<{ id: string, canManageAdmins: boolean, isActive: boolean }>(
        `SELECT id,canmanageadmins AS "canManageAdmins",isactive AS "isActive"
           FROM egas_useraccountrole WHERE user_id=$1 AND role=$2`, [id, role]
      )
      const assignment = result.rows[0]
      if (!assignment?.isActive) return await this.view(db, account)
      if (role === 'ADMIN' && assignment.canManageAdmins && account.isActive) {
        await this.lockPrivilegedInvariant(db)
        await this.ensureAnotherPrivilegedAdmin(db, id)
      }
      await db.query(
        `UPDATE egas_useraccountrole SET isactive=FALSE,canmanageadmins=FALSE,
            revokedby_id=$2,revokedat=CURRENT_TIMESTAMP WHERE id=$1`, [assignment.id, actor.userId]
      )
      await this.revokeSessions(db, id, 'ROLE_REVOKED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'ADMIN_ROLE_REVOKED', ...evidence,
        details: { targetUserId: id, role, canManageAdmins: assignment.canManageAdmins }
      })
      return await this.view(db, await this.account(db, id))
    })
  }

  async setActive(actor: AdminActor, input: Record<string, unknown>, active: boolean, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const expected = version(input.expectedVersion)
    if (!active && id === actor.userId) throw new AppError(403, 'Self-deactivation is prohibited')
    return await withTransaction(this.pool, async db => {
      const account = await this.account(db, id)
      if (account.version !== expected) throw new AppError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(db, id)) this.requireManageAdmins(actor)
      if (!active && account.isActive) {
        const privileged = await db.query(
          `SELECT 1 FROM egas_useraccountrole
            WHERE user_id=$1 AND role='ADMIN' AND canmanageadmins=TRUE AND isactive=TRUE`, [id]
        )
        if (privileged.rows[0]) {
          await this.lockPrivilegedInvariant(db)
          await this.ensureAnotherPrivilegedAdmin(db, id)
        }
      }
      if (account.isActive !== active) {
        const changed = await db.query(
          `UPDATE egas_useraccount SET isactive=$3,
              deactivatedat=CASE WHEN $3 THEN NULL ELSE CURRENT_TIMESTAMP END,
              deactivatedby_id=CASE WHEN $3 THEN NULL ELSE $4 END,
              updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND version=$2`,
          [id, expected, active, actor.userId]
        )
        if (changed.rowCount !== 1) throw new AppError(409, 'User was modified by another request')
      }
      if (!active) await this.revokeSessions(db, id, 'ACCOUNT_DISABLED')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId,
        eventType: active ? 'ADMIN_ACCOUNT_ENABLED' : 'ADMIN_ACCOUNT_DISABLED', ...evidence,
        details: { targetUserId: id }
      })
      return await this.view(db, await this.account(db, id))
    })
  }

  async unlock(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const expected = version(input.expectedVersion)
    return await withTransaction(this.pool, async db => {
      const account = await this.account(db, id)
      if (account.version !== expected) throw new AppError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(db, id)) this.requireManageAdmins(actor)
      const changed = await db.query(
        `UPDATE egas_useraccount SET failedlogincount=0,lockeduntil=NULL,
            updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND version=$2`, [id, expected]
      )
      if (changed.rowCount !== 1) throw new AppError(409, 'User was modified by another request')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'ADMIN_ACCOUNT_UNLOCKED', ...evidence,
        details: { targetUserId: id }
      })
      return await this.view(db, await this.account(db, id))
    })
  }

  async resetPassword(actor: AdminActor, input: Record<string, unknown>, evidence: RequestEvidence): Promise<UserView> {
    const id = uuid(input.userId, 'userId')
    const expected = version(input.expectedVersion)
    if (id === actor.userId) throw new AppError(403, 'Use change-password for your own account')
    const temporary = password(input.temporaryPassword, 'temporaryPassword')
    const hash = await this.passwords.hashPassword(temporary)
    return await withTransaction(this.pool, async db => {
      const account = await this.account(db, id)
      if (account.version !== expected) throw new AppError(409, 'User was modified by another request')
      if (await this.targetHasAdminRole(db, id)) this.requireManageAdmins(actor)
      const changed = await db.query(
        `UPDATE egas_useraccount SET passwordhash=$3,mustchangepassword=TRUE,
            passwordchangedat=CURRENT_TIMESTAMP,failedlogincount=0,lockeduntil=NULL,
            updatedat=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1 AND version=$2`,
        [id, expected, hash]
      )
      if (changed.rowCount !== 1) throw new AppError(409, 'User was modified by another request')
      await this.revokeSessions(db, id, 'PASSWORD_RESET')
      await recordSecurityEvent(db, {
        actorUserId: actor.userId, eventType: 'ADMIN_PASSWORD_RESET', ...evidence,
        details: { targetUserId: id, sessionsRevoked: true }
      })
      return await this.view(db, await this.account(db, id))
    })
  }
}
