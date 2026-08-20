import { Router, type Response } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireAuthenticated } from '../../middleware/authorize.ts'
import { csrfProtection, requireTrustedOrigin, validateCsrf } from '../../middleware/csrf.ts'
import { evidence } from '../../middleware/request-context.ts'
import { exactObject } from '../../shared/validation.ts'
import { AuthService } from './auth-service.ts'
import type { IssuedSession } from './types.ts'

function issueCookies(res: Response, issued: IssuedSession, config: AppConfig): void {
  const common = {
    secure: config.auth.requireSecureCookie,
    sameSite: 'strict' as const,
    path: '/',
    expires: new Date(issued.absoluteExpiresAt)
  }
  const expires = common.expires.toUTCString()
  res.append('Set-Cookie', `${config.auth.sessionCookieName}=${encodeURIComponent(issued.sessionToken)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Strict${common.secure ? '; Secure' : ''}`)
  res.append('Set-Cookie', `${config.auth.csrfCookieName}=${encodeURIComponent(issued.csrfToken)}; Path=/; Expires=${expires}; SameSite=Strict${common.secure ? '; Secure' : ''}`)
  res.setHeader('Cache-Control', 'no-store')
}

function clearCookies(res: Response, config: AppConfig): void {
  const common = { secure: config.auth.requireSecureCookie, sameSite: 'strict' as const, path: '/' }
  res.append('Set-Cookie', `${config.auth.sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${common.secure ? '; Secure' : ''}`)
  res.append('Set-Cookie', `${config.auth.csrfCookieName}=; Path=/; Max-Age=0; SameSite=Strict${common.secure ? '; Secure' : ''}`)
  res.setHeader('Cache-Control', 'no-store')
}

export function authRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const service = new AuthService(pool, config)
  const csrf = csrfProtection(pool, config)

  router.post('/login', async (req, res) => {
    requireTrustedOrigin(req, config)
    const body = exactObject(req.body, ['username', 'password'])
    const issued = await service.login(body.username, body.password, evidence(res))
    issueCookies(res, issued, config)
    res.json(issued.context)
  })

  router.get('/me', requireAuthenticated, async (_req, res) => {
    const auth = authContext(res)
    res.json(await service.getContext(auth.userId, auth.sessionId))
  })

  router.post('/change-password', requireAuthenticated, csrf, async (req, res) => {
    const body = exactObject(req.body, ['currentPassword', 'newPassword'])
    const auth = authContext(res)
    const issued = await service.changePassword(
      auth.userId, auth.sessionId, body.currentPassword, body.newPassword, evidence(res)
    )
    issueCookies(res, issued, config)
    res.json(issued.context)
  })

  router.post('/logout', async (req, res) => {
    requireTrustedOrigin(req, config)
    const auth = res.locals.auth
    if (auth) {
      await validateCsrf(req, res, pool, config)
      await service.logout(auth.userId, auth.sessionId, evidence(res))
    }
    clearCookies(res, config)
    res.status(204).end()
  })

  return router
}
