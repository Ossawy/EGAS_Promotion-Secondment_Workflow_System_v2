import cds from '@sap/cds'
import type { NextFunction, Request, Response } from 'express'
import { LocalAuthenticationProvider } from '../../lib/auth/local-authentication-provider.ts'
import { loadSecurityPolicy } from '../../lib/auth/security-policy.ts'
import { readCookie } from './request-security.ts'

const provider = new LocalAuthenticationProvider()

export default async function localAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const policy = loadSecurityPolicy()
  const rawToken = readCookie(req.headers.cookie, policy.sessionCookieName)
  const context = cds.context
  if (!context) {
    next(new Error('CAP request context is unavailable'))
    return
  }

  if (!rawToken) {
    context.user = cds.User.anonymous
    next()
    return
  }

  try {
    const principal = await provider.resolveSessionToken(rawToken)
    if (!principal) {
      res.clearCookie(policy.sessionCookieName, { path: '/' })
      res.clearCookie(policy.csrfCookieName, { path: '/' })
      context.user = cds.User.anonymous
      next()
      return
    }

    context.user = new cds.User({
      id: principal.userId,
      roles: principal.mustChangePassword || !principal.activeRole ? [] : [principal.activeRole],
      attr: {
        activeRole: principal.activeRole ?? '',
        sessionId: principal.sessionId,
        mustChangePassword: String(principal.mustChangePassword),
        canManageAdmins: String(principal.canManageAdmins)
      }
    })
    next()
  } catch (error) {
    next(error)
  }
}
