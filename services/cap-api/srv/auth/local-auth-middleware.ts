import cds from '@sap/cds'
import type { NextFunction, Request, Response } from 'express'
import { LocalAuthenticationProvider } from '../../lib/auth/local-authentication-provider.js'

const provider = new LocalAuthenticationProvider()
const DEFAULT_COOKIE_NAME = 'EGAS_SESSION'

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const key = part.slice(0, separator).trim()
    if (key !== name) continue
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

export default async function localAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookieName = process.env.EGAS_SESSION_COOKIE_NAME ?? DEFAULT_COOKIE_NAME
  const rawToken = readCookie(req.headers.cookie, cookieName)
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
      res.clearCookie(cookieName)
      context.user = cds.User.anonymous
      next()
      return
    }

    context.user = new cds.User({
      id: principal.userId,
      roles: [principal.activeRole],
      attr: {
        activeRole: principal.activeRole,
        sessionId: principal.sessionId
      }
    })
    next()
  } catch (error) {
    next(error)
  }
}
