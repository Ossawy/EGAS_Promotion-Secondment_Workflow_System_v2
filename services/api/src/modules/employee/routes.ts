import { Router } from 'express'
import type { Pool } from 'pg'
import { AppError } from '../../shared/errors.ts'
import { EmployeeDataService } from './employee-data-service.ts'

/**
 * Phase 2 employee data routes are unmounted and reference-only.
 * Employee data access during Phase 2 is performed via CLI/internal service calls.
 * Fails closed if mounted before Phase 3 authorization design.
 */
export function employeeDataRouter(pool: Pool): Router {
  const router = Router()
  const service = new EmployeeDataService(pool)

  router.use((_req, _res, next) => {
    next(new AppError(404, 'Employee data API route is unmounted and unavailable in Phase 2', 'UNMOUNTED_ROUTE'))
  })

  router.get('/active-snapshot', async (_req, res) => {
    res.json(await service.activeSnapshot())
  })

  router.get('/employees/:personnelNumber', async (req, res) => {
    res.json(await service.employee(req.params.personnelNumber))
  })

  return router
}
