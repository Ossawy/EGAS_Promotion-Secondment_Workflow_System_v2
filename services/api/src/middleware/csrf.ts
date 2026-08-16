import type { NextFunction, Request, Response } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../config/env.ts'
import { authContext } from './authorize.ts'
import { LocalAuthenticationProvider } from '../modules/auth/local-authentication-provider.ts'
import { readCookie, secureEqual } from '../modules/auth/security.ts'
import { AppError } from '../shared/errors.ts'

export function requireTrustedOrigin(req: Request, config: AppConfig): void {
  const origin = req.header('origin')
  if (!origin) return
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.header('host')
  } catch {
    throw new AppError(403, 'Request origin is not allowed', 'ORIGIN_REJECTED')
  }
  if (!sameOrigin && !config.auth.allowedOrigins.has(origin)) {
    throw new AppError(403, 'Request origin is not allowed', 'ORIGIN_REJECTED')
  }
}

export function csrfProtection(pool: Pool, config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await validateCsrf(req, res, pool, config)
      next()
    } catch (error) { next(error) }
  }
}

export async function validateCsrf(req: Request, res: Response, pool: Pool, config: AppConfig): Promise<void> {
  requireTrustedOrigin(req, config)
  const auth = authContext(res)
  const headerToken = req.header('x-csrf-token')
  const cookieToken = readCookie(req.header('cookie'), config.auth.csrfCookieName)
  if (!headerToken || !cookieToken || !secureEqual(headerToken, cookieToken)) {
    throw new AppError(403, 'Invalid CSRF token', 'CSRF_REJECTED')
  }
  const result = await pool.query<{ csrfSecretHash: string | null }>(
    `SELECT csrfsecrethash AS "csrfSecretHash"
       FROM egas_authsession
      WHERE id = $1 AND revokedat IS NULL`,
    [auth.sessionId]
  )
  const stored = result.rows[0]?.csrfSecretHash
  const provider = new LocalAuthenticationProvider(pool, config)
  if (!stored || !secureEqual(stored, provider.hashSessionToken(headerToken))) {
    throw new AppError(403, 'Invalid CSRF token', 'CSRF_REJECTED')
  }
}
