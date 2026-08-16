import { Router } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireActiveRole } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { AppError } from '../../shared/errors.ts'
import { exactObject } from '../../shared/validation.ts'
import { NotificationService } from './notification-service.ts'

function integer(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(400, `${field} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new AppError(400, `${field} is too large`)
  return parsed
}

function unread(value: unknown): boolean {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new AppError(400, 'unreadOnly must be true or false')
}

export function notificationRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const service = new NotificationService(pool)
  const csrf = csrfProtection(pool, config)
  router.use(requireActiveRole('ADMIN','EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'))
  router.get('/', async (req, res) => {
    const actor = authContext(res)
    const top = Math.min(100, integer(req.query.top, 50, 'top'))
    res.json(await service.list(actor.userId, integer(req.query.skip, 0, 'skip'), top, unread(req.query.unreadOnly)))
  })
  router.get('/unread-count', async (_req, res) => {
    res.json({ count: await service.unreadCount(authContext(res).userId) })
  })
  router.post('/:id/read', csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    res.json(await service.markRead(authContext(res).userId, req.params.id))
  })
  return router
}
