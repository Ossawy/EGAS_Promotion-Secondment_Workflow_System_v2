import { Router } from 'express'
import type { Pool } from 'pg'
import { requireAuthenticated } from '../../middleware/authorize.ts'

export function referenceRouter(pool: Pool): Router {
  const router = Router()
  router.use(requireAuthenticated)

  router.get('/routing-units', async (_req, res) => {
    const result = await pool.query(
      `SELECT id, name_ar AS "nameAr", name_en AS "nameEn", code, is_active AS "isActive"
         FROM routing_unit ORDER BY name_ar`
    )
    res.json(result.rows)
  })

  router.get('/job-categories', async (_req, res) => {
    const result = await pool.query(
      `SELECT id, code, name, is_active AS "isActive"
         FROM job_category_reference ORDER BY code`
    )
    res.json(result.rows)
  })

  router.get('/qualification-statuses', async (_req, res) => {
    const result = await pool.query(
      `SELECT id, code, name, is_active AS "isActive"
         FROM qualification_status_reference ORDER BY code`
    )
    res.json(result.rows)
  })

  return router
}
