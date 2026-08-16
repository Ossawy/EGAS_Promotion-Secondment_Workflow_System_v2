import type { ErrorRequestHandler, RequestHandler } from 'express'
import { AppError } from '../shared/errors.ts'

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'Resource not found', 'NOT_FOUND'))
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } })
    return
  }
  if (error && typeof error === 'object' && 'status' in error && error.status === 400) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request body' } })
    return
  }
  if (error && typeof error === 'object' && 'status' in error && error.status === 413) {
    res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body is too large' } })
    return
  }
  console.error('Unexpected request failure', { correlationId: res.locals.evidence?.correlationId ?? null })
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } })
}
