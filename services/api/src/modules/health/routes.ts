import { Router } from 'express'
import type { Pool } from 'pg'

export function healthRouter(pool: Pool): Router {
  const router = Router()
  router.get('/health', (_req, res) => res.json({ status: 'ok' }))
  router.get('/ready', async (_req, res) => {
    await pool.query('SELECT 1 FROM egas_routingunit LIMIT 1')
    res.json({ status: 'ready' })
  })
  return router
}
