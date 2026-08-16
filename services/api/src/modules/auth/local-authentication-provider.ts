import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { isRole, type Role } from '../../shared/roles.ts'
import type { AuthenticationProvider } from './authentication-provider.ts'
import type { AuthContext } from './types.ts'

type SessionPrincipalRow = {
  sessionId: string
  userId: string
  username: string
  activeRole: string | null
  roleAssignmentId: string | null
  canManageAdmins: boolean | null
  mustChangePassword: boolean
  absoluteExpiresAt: Date | string
  lastSeenAt: Date | string
}

export class LocalAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly pool: Pool, private readonly config: AppConfig) {}

  async hashPassword(password: string): Promise<string> {
    return await argon2.hash(password, {
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

  async resolveSessionToken(token: string): Promise<AuthContext | null> {
    if (token.length < 32 || token.length > 256) return null
    const result = await this.pool.query<SessionPrincipalRow>(
      `SELECT s.id AS "sessionId", a.id AS "userId", a.username,
              s.activerole AS "activeRole", r.id AS "roleAssignmentId",
              r.canmanageadmins AS "canManageAdmins", a.mustchangepassword AS "mustChangePassword",
              s.absoluteexpiresat AS "absoluteExpiresAt", s.lastseenat AS "lastSeenAt"
         FROM egas_authsession s
         JOIN egas_useraccount a ON a.id = s.user_id AND a.isactive = TRUE
         LEFT JOIN egas_useraccountrole r
           ON r.user_id = a.id AND r.role = s.activerole AND r.isactive = TRUE
        WHERE s.tokenhash = $1
          AND s.revokedat IS NULL
          AND s.idleexpiresat > CURRENT_TIMESTAMP
          AND s.absoluteexpiresat > CURRENT_TIMESTAMP
          AND (s.activerole IS NULL OR r.id IS NOT NULL)`,
      [this.hashSessionToken(token)]
    )
    const row = result.rows[0]
    if (!row || (row.activeRole !== null && !isRole(row.activeRole))) return null

    const lastSeen = new Date(row.lastSeenAt).getTime()
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen >= 60_000) {
      await this.pool.query(
        `UPDATE egas_authsession
            SET lastseenat = CURRENT_TIMESTAMP,
                idleexpiresat = LEAST(CURRENT_TIMESTAMP + $2::interval, absoluteexpiresat)
          WHERE id = $1 AND revokedat IS NULL`,
        [row.sessionId, `${this.config.auth.idleMinutes} minutes`]
      )
    }

    const activeRole = row.activeRole as Role | null
    return {
      userId: row.userId,
      username: row.username,
      sessionId: row.sessionId,
      activeRole,
      roleAssignmentId: row.roleAssignmentId,
      canManageAdmins: activeRole === 'ADMIN' && Boolean(row.canManageAdmins),
      mustChangePassword: row.mustChangePassword
    }
  }
}
