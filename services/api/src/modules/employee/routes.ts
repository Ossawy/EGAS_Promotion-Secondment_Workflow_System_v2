import { Router } from 'express'
import type { Pool } from 'pg'
import { requireActiveRole } from '../../middleware/authorize.ts'
import { EmployeeDataService } from './employee-data-service.ts'

export function employeeDataRouter(pool: Pool): Router {
  const router = Router()
  const service = new EmployeeDataService(pool)
  router.use(requireActiveRole('EMPLOYEE_AFFAIRS'))
  router.get('/active-snapshot', async (_req, res) => res.json(await service.activeSnapshot()))
  router.get('/employees/:personnelNumber', async (req, res) => {
    res.json(await service.employee(req.params.personnelNumber))
  })
  return router
}
