import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthContext } from '../modules/auth/types.ts'
import { AppError } from '../shared/errors.ts'
import type { Role } from '../shared/roles.ts'

export function authContext(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | null | undefined
  if (!auth) throw new AppError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED')
  return auth
}

export const requireAuthenticated: RequestHandler = (_req, res, next) => {
  try { authContext(res); next() } catch (error) { next(error) }
}

export function requireActiveRole(...roles: Role[]): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authContext(res)
      if (auth.mustChangePassword || !auth.activeRole || !roles.includes(auth.activeRole)) {
        throw new AppError(403, `Active ${roles.join(' or ')} role required`, 'ACTIVE_ROLE_REQUIRED')
      }
      next()
    } catch (error) { next(error) }
  }
}

export const requireAdmin = requireActiveRole('ADMIN')

export const requireManageAdmins: RequestHandler = (_req, res, next) => {
  try {
    const auth = authContext(res)
    if (auth.mustChangePassword || auth.activeRole !== 'ADMIN' || !auth.canManageAdmins) {
      throw new AppError(403, 'Manage-Admins privilege required', 'MANAGE_ADMINS_REQUIRED')
    }
    next()
  } catch (error) { next(error) }
}
