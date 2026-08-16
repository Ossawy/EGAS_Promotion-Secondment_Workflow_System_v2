import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import cds, { type Service } from '@sap/cds'
import type {
  ActiveRole,
  AuthenticatedPrincipal,
  AuthenticationProvider
} from './authentication-provider.ts'

const ACTIVE_ROLES = new Set<ActiveRole>([
  'ADMIN',
  'EMPLOYEE_AFFAIRS',
  'ORGANIZATION',
  'APPROVING_AUTHORITY'
])

type SessionRow = {
  ID: string
  user_ID: string
  activeRole: ActiveRole | null
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
}

type AccountRow = {
  ID: string
  isActive: boolean
  mustChangePassword: boolean
}

export class LocalAuthenticationProvider implements AuthenticationProvider {
  private readonly injectedDb: Service | undefined

  constructor(injectedDb?: Service) {
    this.injectedDb = injectedDb
  }

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1
    })
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password)
    } catch {
      return false
    }
  }

  generateSessionToken(): string {
    return randomBytes(32).toString('base64url')
  }

  hashSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }

  async resolveSessionToken(token: string): Promise<AuthenticatedPrincipal | null> {
    if (token.length < 32 || token.length > 256) return null

    const db = this.injectedDb ?? await cds.connect.to('db')
    const tokenHash = this.hashSessionToken(token)
    const session = await db.run(
      SELECT.one.from('egas.AuthSession').where({ tokenHash })
    ) as SessionRow | undefined

    if (!session || session.revokedAt) return null
    if (session.activeRole && !ACTIVE_ROLES.has(session.activeRole)) return null

    const now = Date.now()
    if (new Date(session.idleExpiresAt).getTime() <= now) return null
    if (new Date(session.absoluteExpiresAt).getTime() <= now) return null

    const account = await db.run(
      SELECT.one.from('egas.UserAccount')
        .columns('ID', 'isActive', 'mustChangePassword')
        .where({ ID: session.user_ID })
    ) as AccountRow | undefined

    if (!account?.isActive) return null

    // Deliberately check only the selected role. Never union all assigned roles.
    const activeAssignment = session.activeRole
      ? await db.run(
        SELECT.one.from('egas.UserAccountRole')
          .columns('ID', 'canManageAdmins')
          .where({
            user_ID: session.user_ID,
            role: session.activeRole,
            isActive: true
          })
      ) as { ID: string, canManageAdmins: boolean } | undefined
      : undefined

    if (session.activeRole && !activeAssignment) return null

    const lastSeen = new Date(session.lastSeenAt).getTime()
    if (Number.isFinite(lastSeen) && now - lastSeen >= 60_000) {
      const idleMinutes = Number(process.env.EGAS_SESSION_IDLE_MINUTES ?? 30)
      const requestedIdle = now + Math.max(5, Math.min(1_440, idleMinutes)) * 60_000
      const nextIdle = new Date(Math.min(
        requestedIdle,
        new Date(session.absoluteExpiresAt).getTime()
      )).toISOString()
      await db.run(UPDATE('egas.AuthSession').set({
        lastSeenAt: new Date(now).toISOString(),
        idleExpiresAt: nextIdle
      }).where({ ID: session.ID, revokedAt: null }))
    }

    return {
      userId: account.ID,
      sessionId: session.ID,
      activeRole: session.activeRole,
      mustChangePassword: account.mustChangePassword,
      canManageAdmins: session.activeRole === 'ADMIN' && Boolean(activeAssignment?.canManageAdmins)
    }
  }
}
