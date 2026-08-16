import { Router } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireAdmin } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { evidence } from '../../middleware/request-context.ts'
import { exactObject } from '../../shared/validation.ts'
import { AppError } from '../../shared/errors.ts'
import { AdminService, type AdminActor } from './admin-service.ts'
import { AuthorityService } from '../authorities/authority-service.ts'

function actor(res: Parameters<typeof authContext>[0]): AdminActor {
  const auth = authContext(res)
  return { userId: auth.userId, canManageAdmins: auth.canManageAdmins }
}

function integer(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(400, `${field} must be a non-negative integer`)
  return Number(value)
}

function queryBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new AppError(400, 'activeOnly must be true or false')
}

export function adminRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const accounts = new AdminService(pool, config)
  const authorities = new AuthorityService(pool)
  const csrf = csrfProtection(pool, config)

  router.use(requireAdmin)

  router.get('/users', async (req, res) => {
    res.json(await accounts.listUsers(
      req.query.search, integer(req.query.skip, 0, 'skip'), integer(req.query.top, 50, 'top')
    ))
  })
  router.get('/users/:id', async (req, res) => res.json(await accounts.getUser(req.params.id)))
  router.post('/users', csrf, async (req, res) => {
    const body = exactObject(req.body, [
      'username','staffIdentifier','displayName','jobTitle','temporaryPassword','isActive','roles'
    ])
    res.status(201).json(await accounts.createUser(actor(res), body, evidence(res)))
  })
  router.patch('/users/:id', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion','staffIdentifier','displayName','jobTitle'])
    res.json(await accounts.updateUser(actor(res), { ...body, userId: req.params.id }, evidence(res)))
  })
  router.post('/users/:id/roles', csrf, async (req, res) => {
    const body = exactObject(req.body, ['role','canManageAdmins'])
    res.json(await accounts.assignRole(actor(res), { ...body, userId: req.params.id }, evidence(res)))
  })
  router.delete('/users/:id/roles/:role', csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    res.json(await accounts.revokeRole(
      actor(res), { userId: req.params.id, role: req.params.role }, evidence(res)
    ))
  })
  for (const [path, active] of [['disable', false], ['enable', true]] as const) {
    router.post(`/users/:id/${path}`, csrf, async (req, res) => {
      const body = exactObject(req.body, ['expectedVersion'])
      res.json(await accounts.setActive(
        actor(res), { ...body, userId: req.params.id }, active, evidence(res)
      ))
    })
  }
  router.post('/users/:id/unlock', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion'])
    res.json(await accounts.unlock(actor(res), { ...body, userId: req.params.id }, evidence(res)))
  })
  router.post('/users/:id/reset-password', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion','temporaryPassword'])
    res.json(await accounts.resetPassword(actor(res), { ...body, userId: req.params.id }, evidence(res)))
  })

  router.get('/authority-assignments', async (req, res) => {
    res.json(await authorities.listAssignments(req.query.routingUnitId, queryBoolean(req.query.activeOnly)))
  })
  router.post('/authority-assignments', csrf, async (req, res) => {
    const body = exactObject(req.body, [
      'routingUnitId','userAccountId','authorityKind','authorityJobTitle','isPrimary','validFrom','validTo','notes'
    ])
    res.status(201).json(await authorities.createAssignment(actor(res), body, evidence(res)))
  })
  router.patch('/authority-assignments/:id', csrf, async (req, res) => {
    const body = exactObject(req.body, [
      'expectedVersion','authorityKind','authorityJobTitle','isPrimary','validFrom','validTo','notes'
    ])
    res.json(await authorities.updateAssignment(
      actor(res), { ...body, assignmentId: req.params.id }, evidence(res)
    ))
  })
  router.post('/authority-assignments/:id/deactivate', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion'])
    res.json(await authorities.deactivateAssignment(
      actor(res), { ...body, assignmentId: req.params.id }, evidence(res)
    ))
  })

  router.get('/delegations', async (req, res) => {
    res.json(await authorities.listDelegations(req.query.assignmentId, queryBoolean(req.query.activeOnly)))
  })
  router.post('/delegations', csrf, async (req, res) => {
    const body = exactObject(req.body, ['assignmentId','delegatedUserId','validFrom','validTo','reason'])
    res.status(201).json(await authorities.createDelegation(actor(res), body, evidence(res)))
  })
  router.patch('/delegations/:id', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion','validFrom','validTo','reason'])
    res.json(await authorities.updateDelegation(
      actor(res), { ...body, delegationId: req.params.id }, evidence(res)
    ))
  })
  router.post('/delegations/:id/deactivate', csrf, async (req, res) => {
    const body = exactObject(req.body, ['expectedVersion'])
    res.json(await authorities.deactivateDelegation(
      actor(res), { ...body, delegationId: req.params.id }, evidence(res)
    ))
  })

  return router
}
