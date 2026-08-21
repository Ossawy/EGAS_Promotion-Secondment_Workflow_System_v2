import express, { Router, type Request, type Response, type NextFunction } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireOperational } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { exactObject, uuid } from '../../shared/validation.ts'
import { SignatureService } from './signature-service.ts'
import { AppError } from '../../shared/errors.ts'
import { requireRequestReadAccess } from '../workflow/workflow-auth.ts'

export function signatureRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const signatureService = new SignatureService(pool, config)
  const csrf = csrfProtection(pool, config)

  router.use(requireOperational)

  // 1. Upload signature image (raw binary PNG or JPEG)
  router.post(
    '/my-signature',
    csrf,
    express.raw({
      type: ['image/png', 'image/jpeg'],
      limit: config.signatures.maxUploadBytes
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const auth = authContext(res)
        const contentType = req.headers['content-type'] ?? ''
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new AppError(400, 'Signature image body is required', 'SIGNATURE_BODY_REQUIRED')
        }
        const result = await signatureService.uploadSignature(
          auth.userId,
          req.body,
          contentType
        )
        res.status(201).json(result)
      } catch (error) {
        next(error)
      }
    }
  )

  // 2. List user's signature versions
  router.get('/my-signatures', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authContext(res)
      const result = await signatureService.listMySignatures(auth.userId)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  // 3. Get signature image bytes
  router.get('/:id/image', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = authContext(res)
      const assetId = uuid(req.params.id, 'id')
      const requestId = typeof req.query.requestId === 'string' ? uuid(req.query.requestId, 'requestId') : undefined
      if (requestId) await requireRequestReadAccess(pool, auth.userId, requestId)

      const { buffer, mimeType } = await signatureService.getSignatureAssetBytes(
        assetId,
        auth.userId,
        requestId
      )

      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'private, no-cache, no-store')
      res.send(buffer)
    } catch (error) {
      next(error)
    }
  })

  // 4. Deactivate a signature asset
  router.post('/:id/deactivate', csrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      exactObject(req.body ?? {}, [])
      const auth = authContext(res)
      const assetId = uuid(req.params.id, 'id')
      const result = await signatureService.deactivateSignature(auth.userId, assetId)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
