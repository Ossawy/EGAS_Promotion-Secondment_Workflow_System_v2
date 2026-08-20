import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import type { AuthenticationProvider } from './authentication-provider.ts'
import type { AuthContext } from './types.ts'

type SessionPrincipalRow = {
  sessionId: string
  userId: string
  username: string
  accountType: 'ADMIN' | 'OPERATIONAL'
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
      `SELECT s.id AS "sessionId", a.id AS "userId", a.username, a.account_type AS "accountType", a.must_change_password AS "mustChangePassword", s.absolute_expires_at AS "absoluteExpiresAt", s.last_seen_at AS "lastSeenAt"
         FROM auth_session s JOIN user_account a ON a.id = s.user_id AND a.is_active = TRUE
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.idle_expires_at > CURRENT_TIMESTAMP AND s.absolute_expires_at > CURRENT_TIMESTAMP`,
      [this.hashSessionToken(token)]
    )
    const row = result.rows[0]
    if (!row) return null

    const lastSeen = new Date(row.lastSeenAt).getTime()
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen >= 60_000) {
      await this.pool.query(
        `UPDATE auth_session SET last_seen_at=CURRENT_TIMESTAMP, idle_expires_at=LEAST(CURRENT_TIMESTAMP + $2::interval, absolute_expires_at) WHERE id=$1 AND revoked_at IS NULL`,
        [row.sessionId, `${this.config.auth.idleMinutes} minutes`]
      )
    }

    return {
      userId: row.userId,
      username: row.username,
      sessionId: row.sessionId,
      accountType: row.accountType,
      mustChangePassword: row.mustChangePassword
    }
  }
}
