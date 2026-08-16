import { Router } from 'express'
import type { Pool } from 'pg'
import { requireAuthenticated } from '../../middleware/authorize.ts'

export function referenceRouter(pool: Pool): Router {
  const router = Router()
  router.use(requireAuthenticated)
  router.get('/routing-units', async (_req, res) => {
    const result = await pool.query(
      `SELECT id,namear AS "nameAr",code,isactive AS "isActive",unitkind AS "unitKind"
         FROM egas_routingunit ORDER BY namear`
    )
    res.json(result.rows)
  })
  router.get('/job-categories', async (_req, res) => {
    const result = await pool.query(
      `SELECT code,namear AS "nameAr",displayorder AS "displayOrder",isactive AS "isActive"
         FROM egas_jobcategoryreference ORDER BY displayorder`
    )
    res.json(result.rows)
  })
  router.get('/qualification-statuses', async (_req, res) => {
    const result = await pool.query(
      `SELECT code,namear AS "nameAr",displayorder AS "displayOrder",isactive AS "isActive"
         FROM egas_qualificationstatusreference ORDER BY displayorder`
    )
    res.json(result.rows)
  })
  return router
}
