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

export const requireAdmin: RequestHandler = (_req, res, next) => {
  try { const auth = authContext(res); if (auth.mustChangePassword || auth.accountType !== 'ADMIN') throw new AppError(403, 'Admin account required', 'ADMIN_REQUIRED'); next() } catch (error) { next(error) }
}

export const requireOperational: RequestHandler = (_req, res, next) => { try { const auth = authContext(res); if (auth.mustChangePassword || auth.accountType !== 'OPERATIONAL') throw new AppError(403, 'Operational account required', 'OPERATIONAL_REQUIRED'); next() } catch (error) { next(error) } }

/** @deprecated obsolete v4 routes are unmounted; this fails closed if accidentally reused. */
export function requireActiveRole(..._roles: Role[]): RequestHandler { return (_req,_res,next) => next(new AppError(404,'Obsolete role route is unavailable','OBSOLETE_ROUTE')) }
