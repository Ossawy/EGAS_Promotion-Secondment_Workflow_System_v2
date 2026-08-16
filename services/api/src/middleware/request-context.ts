import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

export type RequestEvidence = {
  ipAddress: string | null
  userAgent: string | null
  correlationId: string
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header('x-correlation-id')?.trim()
  const correlationId = supplied && supplied.length <= 120 ? supplied : randomUUID()
  const socketIp = req.socket.remoteAddress ?? null
  res.locals.evidence = {
    ipAddress: socketIp?.startsWith('::ffff:') ? socketIp.slice(7, 52) : socketIp?.slice(0, 45) ?? null,
    userAgent: req.header('user-agent')?.slice(0, 1_000) ?? null,
    correlationId
  } satisfies RequestEvidence
  res.setHeader('X-Correlation-Id', correlationId)
  next()
}

export function evidence(res: Response): RequestEvidence {
  return res.locals.evidence as RequestEvidence
}
