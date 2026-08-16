import type { NextFunction, Request, Response } from 'express'
import type { AppConfig } from '../config/env.ts'
import type { AuthenticationProvider } from '../modules/auth/authentication-provider.ts'
import { readCookie } from '../modules/auth/security.ts'

export function authenticate(provider: AuthenticationProvider, config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readCookie(req.header('cookie'), config.auth.sessionCookieName)
      if (!token) {
        res.locals.auth = null
        next()
        return
      }
      const auth = await provider.resolveSessionToken(token)
      if (!auth) {
        res.clearCookie(config.auth.sessionCookieName, { path: '/' })
        res.clearCookie(config.auth.csrfCookieName, { path: '/' })
      }
      res.locals.auth = auth
      next()
    } catch (error) {
      next(error)
    }
  }
}
