import express, { Router, type Request, type Response, type NextFunction } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireOperational } from '../../middleware/authorize.ts'
import { uuid } from '../../shared/validation.ts'
import { PdfService } from './pdf-service.ts'
import type { WorkflowRequestContext } from './workflow-types.ts'

function context(res: express.Response): WorkflowRequestContext {
  const auth = authContext(res)
  return {
    userId: auth.userId,
    username: auth.username
  }
}

export function documentRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const pdfService = new PdfService(pool, config)

  router.use(requireOperational)

  // 1. Current Preview PDF
  router.get('/requests/:requestId/current.pdf', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const { buffer, filename } = await pdfService.getCurrentPdf(requestId, context(res))

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'private, no-cache, no-store')
      res.send(buffer)
    } catch (error) {
      next(error)
    }
  })

  // 2. Final Official PDF
  router.get('/requests/:requestId/final.pdf', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const { buffer, filename } = await pdfService.getFinalPdf(requestId, context(res))

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'private, immutable, max-age=86400')
      res.send(buffer)
    } catch (error) {
      next(error)
    }
  })

  // 3. Audit Trail PDF
  router.get('/requests/:requestId/audit.pdf', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const { buffer, filename } = await pdfService.getAuditPdf(requestId, context(res))

      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'private, no-cache, no-store')
      res.send(buffer)
    } catch (error) {
      next(error)
    }
  })

  return router
}
