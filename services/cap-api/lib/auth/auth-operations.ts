import { randomUUID } from 'node:crypto'
import type { Service } from '@sap/cds'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { LocalAuthenticationProvider } from './local-authentication-provider.ts'
import {
  fingerprintIdentifier,
  isActiveRole,
  type ActiveRole,
  type SecurityPolicy,
  SafeRequestError,
  validatePassword
} from './security-policy.ts'

type RequestEvidence = {
  ipAddress: string | null
  userAgent: string | null
  correlationId: string | null
}

type AccountRow = {
  ID: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  passwordHash: string
  mustChangePassword: boolean
  isActive: boolean
  failedLoginCount: number
  lockedUntil: string | null
  version: number
}

type RoleRow = {
  ID: string
  role: ActiveRole
  canManageAdmins: boolean
  isActive: boolean
}

export type SafeRole = {
  role: ActiveRole
  canManageAdmins: boolean
}

export type SafeAuthContext = {
  userId: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  activeRole: ActiveRole | null
  availableRoles: SafeRole[]
}

export type IssuedSession = {
  sessionId: string
  sessionToken: string
  csrfToken: string
  absoluteExpiresAt: string
  context: SafeAuthContext
}

const GENERIC_LOGIN_MESSAGE = 'Invalid username or password'

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') return ''
  const username = value.trim()
  return /^[\p{L}\p{N}._@-]{3,120}$/u.test(username) ? username : ''
}

function safeUserAgent(value: string | null): string | null {
  if (!value) return null
  return value.slice(0, 1_000)
}

export class AuthOperations {
  private dummyPasswordHash?: Promise<string>
  private authAttemptQueue: Promise<void> = Promise.resolve()
  private readonly db: Service
  private readonly policy: SecurityPolicy
  private readonly provider: LocalAuthenticationProvider

  constructor(
    db: Service,
    policy: SecurityPolicy,
    provider = new LocalAuthenticationProvider(db)
  ) {
    this.db = db
    this.policy = policy
    this.provider = provider
  }

  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= this.provider.hashPassword('synthetic-non-account-comparison-value')
    return this.dummyPasswordHash
  }

  private async serializeAuthAttempt<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.authAttemptQueue
    let release!: () => void
    this.authAttemptQueue = new Promise<void>(resolve => { release = resolve })
    await predecessor
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async lockAuthAttempts(db: Service): Promise<void> {
    if ((this.db as Service & { kind?: string }).kind === 'postgres') {
      await db.run("SELECT pg_advisory_xact_lock(hashtext('egas.auth.attempts'))")
    }
  }

  private async rolesFor(db: Service, userId: string): Promise<RoleRow[]> {
    const rows = await db.run(
      SELECT.from('egas.UserAccountRole')
        .columns('ID', 'role', 'canManageAdmins', 'isActive')
        .where({ user_ID: userId, isActive: true })
        .orderBy('role')
    ) as RoleRow[]
    return rows.filter(row => isActiveRole(row.role))
  }

  private async safeContext(
    db: Service,
    account: AccountRow,
    activeRole: ActiveRole | null
  ): Promise<SafeAuthContext> {
    const roles = await this.rolesFor(db, account.ID)
    return {
      userId: account.ID,
      username: account.username,
      staffIdentifier: account.staffIdentifier,
      displayName: account.displayName,
      jobTitle: account.jobTitle,
      mustChangePassword: account.mustChangePassword,
      isActive: account.isActive,
      activeRole,
      availableRoles: roles.map(({ role, canManageAdmins }) => ({ role, canManageAdmins }))
    }
  }

  private async issueSession(
    db: Service,
    account: AccountRow,
    activeRole: ActiveRole | null,
    evidence: RequestEvidence,
    rotatedFromSessionId: string | null = null
  ): Promise<IssuedSession> {
    const createdAt = new Date()
    const absoluteExpiresAt = new Date(
      createdAt.getTime() + this.policy.absoluteHours * 60 * 60 * 1_000
    )
    const idleExpiresAt = new Date(Math.min(
      createdAt.getTime() + this.policy.idleMinutes * 60 * 1_000,
      absoluteExpiresAt.getTime()
    ))
    const sessionToken = this.provider.generateSessionToken()
    const csrfToken = this.provider.generateSessionToken()
    const sessionId = randomUUID()

    await db.run(INSERT.into('egas.AuthSession').entries({
      ID: sessionId,
      user_ID: account.ID,
      tokenHash: this.provider.hashSessionToken(sessionToken),
      csrfSecretHash: this.provider.hashSessionToken(csrfToken),
      activeRole,
      activeRoleSetAt: activeRole ? createdAt.toISOString() : null,
      rotatedFromSession_ID: rotatedFromSessionId,
      createdAt: createdAt.toISOString(),
      lastSeenAt: createdAt.toISOString(),
      idleExpiresAt: idleExpiresAt.toISOString(),
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      revokedAt: null,
      revokedReason: null,
      createdIp: evidence.ipAddress,
      userAgent: safeUserAgent(evidence.userAgent)
    }))

    return {
      sessionId,
      sessionToken,
      csrfToken,
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      context: await this.safeContext(db, account, activeRole)
    }
  }

  private async recentFailureCount(
    db: Service,
    fingerprint: string,
    ipAddress: string | null,
    reasonPrefix?: string
  ): Promise<number> {
    const since = new Date(
      Date.now() - this.policy.loginWindowMinutes * 60 * 1_000
    ).toISOString()
    const identifierRows = await db.run(
      SELECT.from('egas.AuthLoginAttempt')
        .columns('ID', 'failureReason')
        .where({
          identifierFingerprint: fingerprint,
          wasSuccessful: false,
          createdAt: { '>=': since }
        })
    ) as Array<{ ID: string, failureReason: string | null }>
    const identifierCount = reasonPrefix
      ? identifierRows.filter(row => row.failureReason?.startsWith(reasonPrefix)).length
      : identifierRows.length
    if (!ipAddress) return identifierCount

    const ipRows = await db.run(
      SELECT.from('egas.AuthLoginAttempt')
        .columns('ID', 'failureReason')
        .where({ ipAddress, wasSuccessful: false, createdAt: { '>=': since } })
    ) as Array<{ ID: string, failureReason: string | null }>
    const ipCount = reasonPrefix
      ? ipRows.filter(row => row.failureReason?.startsWith(reasonPrefix)).length
      : ipRows.length
    return Math.max(identifierCount, ipCount)
  }

  private async recordAttempt(
    db: Service,
    fingerprint: string,
    evidence: RequestEvidence,
    successful: boolean,
    failureReason: string | null
  ): Promise<void> {
    await db.run(INSERT.into('egas.AuthLoginAttempt').entries({
      ID: randomUUID(),
      identifierFingerprint: fingerprint,
      ipAddress: evidence.ipAddress,
      wasSuccessful: successful,
      failureReason,
      createdAt: nowIso()
    }))
  }

  async login(usernameValue: unknown, passwordValue: unknown, evidence: RequestEvidence): Promise<IssuedSession> {
    const username = normalizeUsername(usernameValue)
    const password = typeof passwordValue === 'string' ? passwordValue : ''
    const fingerprint = fingerprintIdentifier(username || 'invalid-identifier', this.policy)
    return await this.serializeAuthAttempt(async () => {
      const outcome = await this.db.tx(async tx => {
        await this.lockAuthAttempts(tx)
        const recentFailures = await this.recentFailureCount(tx, fingerprint, evidence.ipAddress)
        if (recentFailures >= this.policy.loginFailureLimit) {
          throw new SafeRequestError(429, 'Authentication temporarily unavailable', 'AUTH_RATE_LIMITED')
        }
      const account = username
        ? await tx.run(
          SELECT.one.from('egas.UserAccount')
            .columns(
              'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle',
              'passwordHash', 'mustChangePassword', 'isActive', 'failedLoginCount',
              'lockedUntil', 'version'
            )
            .where({ username })
        ) as AccountRow | undefined
        : undefined
      const locked = Boolean(account?.lockedUntil && new Date(account.lockedUntil).getTime() > Date.now())
      // Always perform an Argon2 verification so unknown/disabled/locked account
      // paths do not expose account state through an obvious timing difference.
      const passwordMatches = await this.provider.verifyPassword(
        account?.passwordHash ?? await this.dummyHash(), password
      )
      const validPassword = Boolean(account?.isActive && !locked && passwordMatches)

      if (!account || !account.isActive || locked || !validPassword) {
        const failureReason = !account
          ? 'UNKNOWN_OR_INVALID'
          : !account.isActive
            ? 'ACCOUNT_DISABLED'
            : locked
              ? 'ACCOUNT_LOCKED'
              : 'INVALID_CREDENTIAL'
        await this.recordAttempt(tx, fingerprint, evidence, false, failureReason)

        if (account && account.isActive && !locked && !validPassword) {
          const failureCount = account.failedLoginCount + 1
          const identifierFailures = await this.recentFailureCount(tx, fingerprint, null)
          const shouldLock = identifierFailures >= this.policy.loginFailureLimit
          const accountUpdated = await tx.run(UPDATE('egas.UserAccount').set({
            failedLoginCount: failureCount,
            lockedUntil: shouldLock
              ? new Date(Date.now() + this.policy.lockoutMinutes * 60 * 1_000).toISOString()
              : account.lockedUntil,
            updatedAt: nowIso(),
            version: account.version + 1
          }).where({ ID: account.ID, version: account.version }))
          if (shouldLock && accountUpdated === 1) {
            await recordSecurityEvent(tx, {
              actorUserId: account.ID,
              eventType: 'ACCOUNT_LOCKED',
              ipAddress: evidence.ipAddress,
              correlationId: evidence.correlationId,
              details: { reason: 'FAILED_LOGIN_THRESHOLD' }
            })
          }
        }
        await recordSecurityEvent(tx, {
          eventType: 'LOGIN_FAILED',
          ipAddress: evidence.ipAddress,
          correlationId: evidence.correlationId,
          details: { identifierFingerprint: fingerprint, reason: failureReason }
        })
        return { failed: true as const }
      }

      const roles = await this.rolesFor(tx, account.ID)
      if (roles.length === 0) {
        await this.recordAttempt(tx, fingerprint, evidence, false, 'NO_ACTIVE_ROLE')
        await recordSecurityEvent(tx, {
          actorUserId: account.ID,
          eventType: 'LOGIN_FAILED',
          ipAddress: evidence.ipAddress,
          correlationId: evidence.correlationId,
          details: { identifierFingerprint: fingerprint, reason: 'NO_ACTIVE_ROLE' }
        })
        return { failed: true as const }
      }

      const activeRole = roles.length === 1 ? roles[0]?.role ?? null : null
      const updated = await tx.run(UPDATE('egas.UserAccount').set({
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: nowIso(),
        version: account.version + 1
      }).where({ ID: account.ID, version: account.version }))
      if (updated !== 1) {
        throw new SafeRequestError(503, 'Authentication temporarily unavailable', 'AUTH_RETRY')
      }
      account.failedLoginCount = 0
      account.lockedUntil = null
      account.version += 1
      await this.recordAttempt(tx, fingerprint, evidence, true, null)
      const issued = await this.issueSession(tx, account, activeRole, evidence)
      await recordSecurityEvent(tx, {
        actorUserId: account.ID,
        eventType: 'LOGIN_SUCCEEDED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { sessionId: issued.sessionId, activeRole }
      })
      return { failed: false as const, issued }
      })
      if (outcome.failed) {
        throw new SafeRequestError(401, GENERIC_LOGIN_MESSAGE, 'AUTHENTICATION_FAILED')
      }
      return outcome.issued
    })
  }

  async getContext(userId: string, sessionId: string): Promise<SafeAuthContext> {
    const session = await this.db.run(
      SELECT.one.from('egas.AuthSession').columns('activeRole')
        .where({ ID: sessionId, user_ID: userId, revokedAt: null })
    ) as { activeRole: ActiveRole | null } | undefined
    const account = await this.db.run(
      SELECT.one.from('egas.UserAccount')
        .columns(
          'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle', 'passwordHash',
          'mustChangePassword', 'isActive', 'failedLoginCount', 'lockedUntil', 'version'
        )
        .where({ ID: userId })
    ) as AccountRow | undefined
    if (!session || !account?.isActive) throw new SafeRequestError(401, 'Authentication required')
    return await this.safeContext(this.db, account, session.activeRole)
  }

  async logout(userId: string, sessionId: string, evidence: RequestEvidence): Promise<void> {
    await this.db.tx(async tx => {
      const session = await tx.run(
        SELECT.one.from('egas.AuthSession').columns('revokedAt').where({ ID: sessionId, user_ID: userId })
      ) as { revokedAt: string | null } | undefined
      if (session && !session.revokedAt) {
        await tx.run(UPDATE('egas.AuthSession').set({
          revokedAt: nowIso(),
          revokedReason: 'LOGOUT'
        }).where({ ID: sessionId }))
        await recordSecurityEvent(tx, {
          actorUserId: userId,
          eventType: 'LOGOUT',
          ipAddress: evidence.ipAddress,
          correlationId: evidence.correlationId,
          details: { sessionId }
        })
      }
    })
  }

  async changePassword(
    userId: string,
    sessionId: string,
    currentPasswordValue: unknown,
    newPasswordValue: unknown,
    evidence: RequestEvidence
  ): Promise<IssuedSession> {
    const currentPassword = typeof currentPasswordValue === 'string' ? currentPasswordValue : ''
    const newPassword = validatePassword(newPasswordValue)
    if (newPassword === currentPassword) {
      throw new SafeRequestError(400, 'New password must differ from the current password')
    }
    return await this.serializeAuthAttempt(async () => {
      const fingerprint = fingerprintIdentifier(`password-change:${userId}`, this.policy)
      const account = await this.db.run(
      SELECT.one.from('egas.UserAccount')
        .columns(
          'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle', 'passwordHash',
          'mustChangePassword', 'isActive', 'failedLoginCount', 'lockedUntil', 'version'
        )
        .where({ ID: userId })
    ) as AccountRow | undefined
      if (!account?.isActive) throw new SafeRequestError(401, 'Authentication required')
      if (!await this.provider.verifyPassword(account.passwordHash, currentPassword)) {
        await this.db.tx(async tx => {
          await this.lockAuthAttempts(tx)
          const recentFailures = await this.recentFailureCount(
            tx, fingerprint, evidence.ipAddress, 'PASSWORD_CHANGE_'
          )
          if (recentFailures >= this.policy.loginFailureLimit) {
            throw new SafeRequestError(429, 'Password change temporarily unavailable', 'AUTH_RATE_LIMITED')
          }
        await this.recordAttempt(tx, fingerprint, evidence, false, 'PASSWORD_CHANGE_INVALID_CURRENT')
        await recordSecurityEvent(tx, {
          actorUserId: userId,
          eventType: 'PASSWORD_CHANGE_FAILED',
          ipAddress: evidence.ipAddress,
          correlationId: evidence.correlationId,
          details: { reason: 'INVALID_CURRENT_PASSWORD' }
        })
        })
        throw new SafeRequestError(401, 'Current password is incorrect')
      }

      const passwordHash = await this.provider.hashPassword(newPassword)
      return await this.db.tx(async tx => {
      await this.lockAuthAttempts(tx)
      const recentFailures = await this.recentFailureCount(
        tx, fingerprint, evidence.ipAddress, 'PASSWORD_CHANGE_'
      )
      if (recentFailures >= this.policy.loginFailureLimit) {
        throw new SafeRequestError(429, 'Password change temporarily unavailable', 'AUTH_RATE_LIMITED')
      }
      const session = await tx.run(
        SELECT.one.from('egas.AuthSession').columns('activeRole')
          .where({ ID: sessionId, user_ID: userId, revokedAt: null })
      ) as { activeRole: ActiveRole | null } | undefined
      if (!session) throw new SafeRequestError(401, 'Authentication required')
      const updated = await tx.run(UPDATE('egas.UserAccount').set({
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: nowIso(),
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: nowIso(),
        version: account.version + 1
      }).where({ ID: userId, version: account.version })) as number
      if (updated !== 1) throw new SafeRequestError(409, 'Account changed; retry the request')
      account.passwordHash = passwordHash
      account.mustChangePassword = false
      account.version += 1
      await tx.run(UPDATE('egas.AuthSession').set({
        revokedAt: nowIso(),
        revokedReason: 'PASSWORD_CHANGED'
      }).where({ user_ID: userId, revokedAt: null }))
      const roles = await this.rolesFor(tx, userId)
      const activeRole = session.activeRole && roles.some(role => role.role === session.activeRole)
        ? session.activeRole
        : roles.length === 1 ? roles[0]?.role ?? null : null
      const issued = await this.issueSession(tx, account, activeRole, evidence, sessionId)
      await this.recordAttempt(tx, fingerprint, evidence, true, null)
      await recordSecurityEvent(tx, {
        actorUserId: userId,
        eventType: 'PASSWORD_CHANGED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { revokedSessions: true, newSessionId: issued.sessionId }
      })
      return issued
      })
    })
  }

  async selectActiveRole(
    userId: string,
    sessionId: string,
    desiredRole: unknown,
    evidence: RequestEvidence
  ): Promise<IssuedSession> {
    if (!isActiveRole(desiredRole)) throw new SafeRequestError(400, 'Unsupported active role')
    return await this.db.tx(async tx => {
      const account = await tx.run(
        SELECT.one.from('egas.UserAccount')
          .columns(
            'ID', 'username', 'staffIdentifier', 'displayName', 'jobTitle', 'passwordHash',
            'mustChangePassword', 'isActive', 'failedLoginCount', 'lockedUntil', 'version'
          )
          .where({ ID: userId })
      ) as AccountRow | undefined
      if (!account?.isActive) throw new SafeRequestError(401, 'Authentication required')
      if (account.mustChangePassword) {
        throw new SafeRequestError(403, 'Password change is required before selecting a role')
      }
      const assignment = await tx.run(
        SELECT.one.from('egas.UserAccountRole').columns('ID')
          .where({ user_ID: userId, role: desiredRole, isActive: true })
      ) as { ID: string } | undefined
      if (!assignment) throw new SafeRequestError(403, 'Role is not assigned or active')
      const current = await tx.run(
        SELECT.one.from('egas.AuthSession').columns('ID').where({ ID: sessionId, user_ID: userId, revokedAt: null })
      ) as { ID: string } | undefined
      if (!current) throw new SafeRequestError(401, 'Authentication required')
      await tx.run(UPDATE('egas.AuthSession').set({
        revokedAt: nowIso(),
        revokedReason: 'ACTIVE_ROLE_CHANGED'
      }).where({ ID: sessionId }))
      const issued = await this.issueSession(tx, account, desiredRole, evidence, sessionId)
      await recordSecurityEvent(tx, {
        actorUserId: userId,
        eventType: 'ACTIVE_ROLE_CHANGED',
        ipAddress: evidence.ipAddress,
        correlationId: evidence.correlationId,
        details: { activeRole: desiredRole, newSessionId: issued.sessionId }
      })
      return issued
    })
  }
}

export type { RequestEvidence }
