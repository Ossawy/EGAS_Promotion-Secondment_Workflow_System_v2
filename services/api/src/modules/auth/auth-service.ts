import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import type { Queryable } from '../../db/types.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { AppError } from '../../shared/errors.ts'
import { isRole, type Role } from '../../shared/roles.ts'
import { password as validatePassword } from '../../shared/validation.ts'
import { LocalAuthenticationProvider } from './local-authentication-provider.ts'
import { fingerprintIdentifier } from './security.ts'
import type { IssuedSession, SafeRole, SafeUserContext } from './types.ts'

type AccountRow = {
  id: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  passwordHash: string
  mustChangePassword: boolean
  isActive: boolean
  failedLoginCount: number
  lockedUntil: Date | string | null
  version: number
}

const GENERIC_LOGIN_MESSAGE = 'Invalid username or password'
type LoginFailureReason = 'UNKNOWN_OR_INVALID' | 'ACCOUNT_DISABLED' | 'ACCOUNT_LOCKED' | 'INVALID_CREDENTIAL'

function username(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  return /^[\p{L}\p{N}._@-]{3,120}$/u.test(normalized) ? normalized : ''
}

function accountColumns(): string {
  return `id, username, staffidentifier AS "staffIdentifier", displayname AS "displayName",
    jobtitle AS "jobTitle", passwordhash AS "passwordHash",
    mustchangepassword AS "mustChangePassword", isactive AS "isActive",
    failedlogincount AS "failedLoginCount", lockeduntil AS "lockedUntil", version`
}

function authenticationFailureReason(
  account: AccountRow | undefined,
  locked: boolean,
  passwordMatches: boolean
): LoginFailureReason | null {
  if (!account) return 'UNKNOWN_OR_INVALID'
  if (!account.isActive) return 'ACCOUNT_DISABLED'
  if (locked) return 'ACCOUNT_LOCKED'
  return passwordMatches ? null : 'INVALID_CREDENTIAL'
}

function soleRole(roles: readonly SafeRole[]): Role | null {
  return roles.length === 1 ? roles[0]?.role ?? null : null
}

function roleAfterPasswordChange(previous: string | null, roles: readonly SafeRole[]): Role | null {
  if (previous !== null && isRole(previous) && roles.some(role => role.role === previous)) return previous
  return soleRole(roles)
}

export class AuthService {
  private dummyPasswordHash?: Promise<string>
  private authAttemptQueue: Promise<void> = Promise.resolve()
  readonly provider: LocalAuthenticationProvider

  constructor(private readonly pool: Pool, private readonly config: AppConfig) {
    this.provider = new LocalAuthenticationProvider(pool, config)
  }

  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= this.provider.hashPassword('synthetic-non-account-comparison-value')
    return this.dummyPasswordHash
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.authAttemptQueue
    let release!: () => void
    this.authAttemptQueue = new Promise<void>(resolve => { release = resolve })
    await predecessor
    try { return await operation() } finally { release() }
  }

  private async lockAttempts(db: Queryable): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('egas.auth.attempts'))")
  }

  private async account(db: Queryable, normalizedUsername: string): Promise<AccountRow | undefined> {
    const result = await db.query<AccountRow>(
      `SELECT ${accountColumns()} FROM egas_useraccount WHERE username = $1`,
      [normalizedUsername]
    )
    return result.rows[0]
  }

  private async roles(db: Queryable, userId: string): Promise<SafeRole[]> {
    const result = await db.query<{ role: string, canManageAdmins: boolean }>(
      `SELECT role, canmanageadmins AS "canManageAdmins"
         FROM egas_useraccountrole
        WHERE user_id = $1 AND isactive = TRUE
        ORDER BY role`,
      [userId]
    )
    return result.rows.filter(row => isRole(row.role)) as SafeRole[]
  }

  private async context(db: Queryable, account: AccountRow, activeRole: Role | null): Promise<SafeUserContext> {
    return {
      userId: account.id,
      username: account.username,
      staffIdentifier: account.staffIdentifier,
      displayName: account.displayName,
      jobTitle: account.jobTitle,
      mustChangePassword: account.mustChangePassword,
      isActive: account.isActive,
      activeRole,
      availableRoles: await this.roles(db, account.id)
    }
  }

  private async issueSession(
    db: Queryable,
    account: AccountRow,
    activeRole: Role | null,
    evidence: RequestEvidence,
    rotatedFrom: string | null = null
  ): Promise<IssuedSession> {
    const sessionId = randomUUID()
    const sessionToken = this.provider.generateSessionToken()
    const csrfToken = this.provider.generateSessionToken()
    await db.query(
      `INSERT INTO egas_authsession
        (id, user_id, tokenhash, csrfsecrethash, activerole, activerolesetat,
         rotatedfromsession_id, createdat, lastseenat, idleexpiresat, absoluteexpiresat,
         revokedat, revokedreason, createdip, useragent)
       VALUES ($1,$2,$3,$4,$5,
         CASE WHEN $5::varchar IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
         $6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
         CURRENT_TIMESTAMP + $7::interval,
         CURRENT_TIMESTAMP + $8::interval,
         NULL,NULL,$9,$10)`,
      [
        sessionId, account.id, this.provider.hashSessionToken(sessionToken),
        this.provider.hashSessionToken(csrfToken), activeRole, rotatedFrom,
        `${this.config.auth.idleMinutes} minutes`, `${this.config.auth.absoluteHours} hours`,
        evidence.ipAddress, evidence.userAgent?.slice(0, 1_000) ?? null
      ]
    )
    // The database computes authoritative expiry in its own timezone. Cookie
    // expiry is the same elapsed duration from the API host's current instant.
    const absolute = new Date(Date.now() + this.config.auth.absoluteHours * 3_600_000)
    return {
      sessionId,
      sessionToken,
      csrfToken,
      absoluteExpiresAt: absolute.toISOString(),
      context: await this.context(db, account, activeRole)
    }
  }

  private async recentFailures(
    db: Queryable,
    fingerprint: string,
    ipAddress: string | null,
    reasonPrefix: string | null = null
  ): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT GREATEST(
          COUNT(*) FILTER (WHERE identifierfingerprint = $1),
          COUNT(*) FILTER (WHERE $2::varchar IS NOT NULL AND ipaddress = $2)
        )::integer AS count
       FROM egas_authloginattempt
       WHERE wassuccessful = FALSE
         AND createdat >= CURRENT_TIMESTAMP - $3::interval
         AND ($4::varchar IS NULL OR failurereason LIKE $4 || '%')
         AND (identifierfingerprint = $1 OR ($2::varchar IS NOT NULL AND ipaddress = $2))`,
      [fingerprint, ipAddress, `${this.config.auth.loginWindowMinutes} minutes`, reasonPrefix]
    )
    return result.rows[0]?.count ?? 0
  }

  private async identifierFailures(db: Queryable, fingerprint: string): Promise<number> {
    const result = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM egas_authloginattempt
        WHERE identifierfingerprint = $1 AND wassuccessful = FALSE
          AND createdat >= CURRENT_TIMESTAMP - $2::interval`,
      [fingerprint, `${this.config.auth.loginWindowMinutes} minutes`]
    )
    return result.rows[0]?.count ?? 0
  }

  private async recordAttempt(
    db: Queryable,
    fingerprint: string,
    evidence: RequestEvidence,
    successful: boolean,
    reason: string | null
  ): Promise<void> {
    await db.query(
      `INSERT INTO egas_authloginattempt
        (id, identifierfingerprint, ipaddress, wassuccessful, failurereason, createdat)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)`,
      [randomUUID(), fingerprint, evidence.ipAddress, successful, reason]
    )
  }

  private async recordFailedLogin(
    db: Queryable,
    account: AccountRow | undefined,
    locked: boolean,
    passwordMatches: boolean,
    fingerprint: string,
    evidence: RequestEvidence,
    reason: LoginFailureReason
  ): Promise<void> {
    await this.recordAttempt(db, fingerprint, evidence, false, reason)
    if (account?.isActive && !locked && !passwordMatches) {
      const failures = await this.identifierFailures(db, fingerprint)
      const shouldLock = failures >= this.config.auth.loginFailureLimit
      const updated = await db.query(
        `UPDATE egas_useraccount
            SET failedlogincount = failedlogincount + 1,
                lockeduntil = CASE WHEN $3 THEN CURRENT_TIMESTAMP + $4::interval ELSE lockeduntil END,
                updatedat = CURRENT_TIMESTAMP, version = version + 1
          WHERE id = $1 AND version = $2`,
        [account.id, account.version, shouldLock, `${this.config.auth.lockoutMinutes} minutes`]
      )
      if (shouldLock && updated.rowCount === 1) {
        await recordSecurityEvent(db, {
          actorUserId: account.id, eventType: 'ACCOUNT_LOCKED', ...evidence,
          details: { reason: 'FAILED_LOGIN_THRESHOLD' }
        })
      }
    }
    await recordSecurityEvent(db, {
      eventType: 'LOGIN_FAILED', ...evidence,
      details: { identifierFingerprint: fingerprint, reason }
    })
  }

  private async recordSuccessfulLogin(
    db: Queryable,
    account: AccountRow,
    activeRole: Role | null,
    fingerprint: string,
    evidence: RequestEvidence
  ): Promise<IssuedSession> {
    const updated = await db.query(
      `UPDATE egas_useraccount SET failedlogincount=0, lockeduntil=NULL,
          updatedat=CURRENT_TIMESTAMP, version=version+1 WHERE id=$1 AND version=$2`,
      [account.id, account.version]
    )
    if (updated.rowCount !== 1) throw new AppError(503, 'Authentication temporarily unavailable', 'AUTH_RETRY')
    account.failedLoginCount = 0
    account.lockedUntil = null
    account.version += 1
    await this.recordAttempt(db, fingerprint, evidence, true, null)
    const issued = await this.issueSession(db, account, activeRole, evidence)
    await recordSecurityEvent(db, {
      actorUserId: account.id, eventType: 'LOGIN_SUCCEEDED', ...evidence,
      details: { sessionId: issued.sessionId, activeRole }
    })
    return issued
  }

  private async loginTransaction(
    db: Queryable,
    normalized: string,
    suppliedPassword: string,
    fingerprint: string,
    evidence: RequestEvidence
  ): Promise<IssuedSession | null> {
    await this.lockAttempts(db)
    const recent = await this.recentFailures(db, fingerprint, evidence.ipAddress)
    if (recent >= this.config.auth.loginFailureLimit) {
      throw new AppError(429, 'Authentication temporarily unavailable', 'AUTH_RATE_LIMITED')
    }
    const account = normalized ? await this.account(db, normalized) : undefined
    const locked = Boolean(account?.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now())
    const passwordMatches = await this.provider.verifyPassword(
      account?.passwordHash ?? await this.dummyHash(), suppliedPassword
    )
    const failureReason = authenticationFailureReason(account, locked, passwordMatches)
    if (failureReason) {
      await this.recordFailedLogin(db, account, locked, passwordMatches, fingerprint, evidence, failureReason)
      return null
    }
    if (!account) return null
    const roles = await this.roles(db, account.id)
    if (roles.length === 0) {
      await this.recordAttempt(db, fingerprint, evidence, false, 'NO_ACTIVE_ROLE')
      await recordSecurityEvent(db, {
        actorUserId: account.id, eventType: 'LOGIN_FAILED', ...evidence,
        details: { identifierFingerprint: fingerprint, reason: 'NO_ACTIVE_ROLE' }
      })
      return null
    }
    return await this.recordSuccessfulLogin(db, account, soleRole(roles), fingerprint, evidence)
  }

  async login(usernameValue: unknown, passwordValue: unknown, evidence: RequestEvidence): Promise<IssuedSession> {
    const normalized = username(usernameValue)
    const suppliedPassword = typeof passwordValue === 'string' ? passwordValue : ''
    const fingerprint = fingerprintIdentifier(normalized || 'invalid-identifier', this.config)
    return await this.serialize(async () => {
      const outcome = await withTransaction(this.pool, async db =>
        await this.loginTransaction(db, normalized, suppliedPassword, fingerprint, evidence))
      if (!outcome) throw new AppError(401, GENERIC_LOGIN_MESSAGE, 'AUTHENTICATION_FAILED')
      return outcome
    })
  }

  async getContext(userId: string, sessionId: string): Promise<SafeUserContext> {
    const accountResult = await this.pool.query<AccountRow>(
      `SELECT ${accountColumns()} FROM egas_useraccount WHERE id=$1 AND isactive=TRUE`, [userId]
    )
    const sessionResult = await this.pool.query<{ activeRole: string | null }>(
      `SELECT activerole AS "activeRole" FROM egas_authsession
        WHERE id=$1 AND user_id=$2 AND revokedat IS NULL
          AND idleexpiresat > CURRENT_TIMESTAMP AND absoluteexpiresat > CURRENT_TIMESTAMP`,
      [sessionId, userId]
    )
    const account = accountResult.rows[0]
    const active = sessionResult.rows[0]?.activeRole
    if (!account || active === undefined || (active !== null && !isRole(active))) {
      throw new AppError(401, 'Authentication required')
    }
    return await this.context(this.pool, account, active as Role | null)
  }

  async logout(userId: string, sessionId: string, evidence: RequestEvidence): Promise<void> {
    await withTransaction(this.pool, async db => {
      const updated = await db.query(
        `UPDATE egas_authsession SET revokedat=CURRENT_TIMESTAMP, revokedreason='LOGOUT'
          WHERE id=$1 AND user_id=$2 AND revokedat IS NULL`,
        [sessionId, userId]
      )
      if (updated.rowCount === 1) {
        await recordSecurityEvent(db, {
          actorUserId: userId, eventType: 'LOGOUT', ...evidence, details: { sessionId }
        })
      }
    })
  }

  async changePassword(
    userId: string,
    sessionId: string,
    currentValue: unknown,
    newValue: unknown,
    evidence: RequestEvidence
  ): Promise<IssuedSession> {
    const currentPassword = typeof currentValue === 'string' ? currentValue : ''
    const newPassword = validatePassword(newValue)
    if (currentPassword === newPassword) throw new AppError(400, 'New password must differ from the current password')
    return await this.serialize(async () => {
      const fingerprint = fingerprintIdentifier(`password-change:${userId}`, this.config)
      const accountResult = await this.pool.query<AccountRow>(
        `SELECT ${accountColumns()} FROM egas_useraccount WHERE id=$1 AND isactive=TRUE`, [userId]
      )
      const account = accountResult.rows[0]
      if (!account) throw new AppError(401, 'Authentication required')
      if (!await this.provider.verifyPassword(account.passwordHash, currentPassword)) {
        await withTransaction(this.pool, async db => {
          await this.lockAttempts(db)
          if (await this.recentFailures(db, fingerprint, evidence.ipAddress, 'PASSWORD_CHANGE_') >= this.config.auth.loginFailureLimit) {
            throw new AppError(429, 'Password change temporarily unavailable', 'AUTH_RATE_LIMITED')
          }
          await this.recordAttempt(db, fingerprint, evidence, false, 'PASSWORD_CHANGE_INVALID_CURRENT')
          await recordSecurityEvent(db, {
            actorUserId: userId, eventType: 'PASSWORD_CHANGE_FAILED', ...evidence,
            details: { reason: 'INVALID_CURRENT_PASSWORD' }
          })
        })
        throw new AppError(401, 'Current password is incorrect')
      }
      const passwordHash = await this.provider.hashPassword(newPassword)
      return await withTransaction(this.pool, async db => {
        await this.lockAttempts(db)
        if (await this.recentFailures(db, fingerprint, evidence.ipAddress, 'PASSWORD_CHANGE_') >= this.config.auth.loginFailureLimit) {
          throw new AppError(429, 'Password change temporarily unavailable', 'AUTH_RATE_LIMITED')
        }
        const session = await db.query<{ activeRole: string | null }>(
          `SELECT activerole AS "activeRole" FROM egas_authsession
            WHERE id=$1 AND user_id=$2 AND revokedat IS NULL`, [sessionId, userId]
        )
        if (!session.rows[0]) throw new AppError(401, 'Authentication required')
        const updated = await db.query(
          `UPDATE egas_useraccount SET passwordhash=$3, mustchangepassword=FALSE,
              passwordchangedat=CURRENT_TIMESTAMP, failedlogincount=0, lockeduntil=NULL,
              updatedat=CURRENT_TIMESTAMP, version=version+1
            WHERE id=$1 AND version=$2`,
          [userId, account.version, passwordHash]
        )
        if (updated.rowCount !== 1) throw new AppError(409, 'Account changed; retry the request')
        account.passwordHash = passwordHash
        account.mustChangePassword = false
        account.version += 1
        await db.query(
          `UPDATE egas_authsession SET revokedat=CURRENT_TIMESTAMP, revokedreason='PASSWORD_CHANGED'
            WHERE user_id=$1 AND revokedat IS NULL`, [userId]
        )
        const roles = await this.roles(db, userId)
        const previous = session.rows[0].activeRole
        const activeRole = roleAfterPasswordChange(previous, roles)
        const issued = await this.issueSession(db, account, activeRole, evidence, sessionId)
        await this.recordAttempt(db, fingerprint, evidence, true, null)
        await recordSecurityEvent(db, {
          actorUserId: userId, eventType: 'PASSWORD_CHANGED', ...evidence,
          details: { revokedSessions: true, newSessionId: issued.sessionId }
        })
        return issued
      })
    })
  }

  async selectActiveRole(
    userId: string,
    sessionId: string,
    desired: unknown,
    evidence: RequestEvidence
  ): Promise<IssuedSession> {
    if (!isRole(desired)) throw new AppError(400, 'Unsupported active role')
    return await withTransaction(this.pool, async db => {
      const accountResult = await db.query<AccountRow>(
        `SELECT ${accountColumns()} FROM egas_useraccount WHERE id=$1 AND isactive=TRUE`, [userId]
      )
      const account = accountResult.rows[0]
      if (!account) throw new AppError(401, 'Authentication required')
      if (account.mustChangePassword) throw new AppError(403, 'Password change is required before selecting a role')
      const assignment = await db.query(
        `SELECT id FROM egas_useraccountrole WHERE user_id=$1 AND role=$2 AND isactive=TRUE`,
        [userId, desired]
      )
      if (!assignment.rows[0]) throw new AppError(403, 'Role is not assigned or active')
      const revoked = await db.query(
        `UPDATE egas_authsession SET revokedat=CURRENT_TIMESTAMP, revokedreason='ACTIVE_ROLE_CHANGED'
          WHERE id=$1 AND user_id=$2 AND revokedat IS NULL`, [sessionId, userId]
      )
      if (revoked.rowCount !== 1) throw new AppError(401, 'Authentication required')
      const issued = await this.issueSession(db, account, desired, evidence, sessionId)
      await recordSecurityEvent(db, {
        actorUserId: userId, eventType: 'ACTIVE_ROLE_CHANGED', ...evidence,
        details: { activeRole: desired, newSessionId: issued.sessionId }
      })
      return issued
    })
  }
}
