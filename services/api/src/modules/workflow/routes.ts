import express, { Router } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireActiveRole } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { evidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { exactObject } from '../../shared/validation.ts'
import { TaskService } from './task-service.ts'
import { WORKFLOW_TYPES, type WorkflowType } from './types.ts'
import { createRequestInput, noteText, personnelNumber } from './validation.ts'
import { WorkflowService } from './workflow-service.ts'
import { SecondmentService } from './secondment-service.ts'
import { PromotionService } from './promotion-service.ts'
import { WorkflowControlService } from './workflow-control-service.ts'
import { SignatureService } from './signature-service.ts'
import { PdfService, type PdfResult } from './pdf-service.ts'
import { HistoryService } from './history-service.ts'
import { date, optionalText, uuid } from '../../shared/validation.ts'

function sendPdf(res: import('express').Response, result: PdfResult, download: boolean): void {
  const safeFilename = result.filename.replace(/[^A-Za-z0-9._-]/g, '_')
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', result.state === 'DRAFT' ? 'private, no-store' : 'private, max-age=0, must-revalidate')
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safeFilename}"`)
  res.send(result.buffer)
}

function integer(value: unknown, fallback: number, field: string, maximum?: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new AppError(400, `${field} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
    throw new AppError(400, `${field} is out of range`)
  }
  return parsed
}

function typeFilter(value: unknown): WorkflowType | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !(WORKFLOW_TYPES as readonly string[]).includes(value)) {
    throw new AppError(400, 'requestType must be PROMOTION or SECONDMENT', 'WORKFLOW_TYPE_INVALID')
  }
  return value as WorkflowType
}

function statusFilter(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !['DRAFT','IN_PROGRESS','RETURNED','COMPLETED','CANCELLED'].includes(value)) {
    throw new AppError(400, 'status is invalid', 'WORKFLOW_STATUS_INVALID')
  }
  return value
}

export function workflowRouter(pool: Pool, config: AppConfig): Router {
  const router = Router(); const workflow = new WorkflowService(pool); const tasks = new TaskService(pool)
  const secondment = new SecondmentService(pool)
  const promotion = new PromotionService(pool)
  const controls = new WorkflowControlService(pool)
  const signatures = new SignatureService(pool, config)
  const pdf = new PdfService(pool, config)
  const history = new HistoryService(pool)
  const csrf = csrfProtection(pool, config)

  router.get('/history', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    const routingUnitId = req.query.routingUnitId === undefined || req.query.routingUnitId === '' ? null : uuid(req.query.routingUnitId, 'routingUnitId')
    const from = date(req.query.from, 'from'); const to = date(req.query.to, 'to')
    if (from && to && from > to) throw new AppError(400, 'from must not follow to', 'WORKFLOW_DATE_RANGE_INVALID')
    res.json(await history.search(authContext(res), {
      skip: integer(req.query.skip, 0, 'skip'), top: integer(req.query.top, 50, 'top', 100),
      requestType: typeFilter(req.query.requestType), status: statusFilter(req.query.status), routingUnitId,
      personnelNumber: optionalText(req.query.personnelNumber, 'personnelNumber', 120),
      query: optionalText(req.query.q, 'q', 120), from, to
    }))
  })

  router.post('/signatures', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION'), csrf,
    express.raw({ type: ['image/png', 'image/jpeg'], limit: config.signatures.maxUploadBytes }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        throw new AppError(415, 'Content-Type must be image/png or image/jpeg', 'SIGNATURE_MEDIA_TYPE_INVALID')
      }
      res.status(201).json(await signatures.upload(req.body, req.header('content-type')?.split(';', 1)[0] ?? '', authContext(res), evidence(res)))
    })
  router.get('/signatures', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION'), async (_req, res) => {
    res.json(await signatures.ownAssets(authContext(res)))
  })
  router.get('/signatures/:id/content', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    const actor = authContext(res)
    const content = await signatures.content(req.params.id, actor, async requestId => {
      try { await workflow.detail(requestId, actor); return true } catch (error) {
        if (error instanceof AppError && error.status === 404) return false
        throw error
      }
    })
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Type', 'image/png')
    res.send(content)
  })

  router.post('/requests', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['requestType','cycleYear','formMonth','formYear'])
    res.status(201).json(await workflow.create(createRequestInput(body), authContext(res), evidence(res)))
  })
  router.get('/requests', requireActiveRole('EMPLOYEE_AFFAIRS'), async (req, res) => {
    res.json(await workflow.list(authContext(res), integer(req.query.skip, 0, 'skip'),
      integer(req.query.top, 50, 'top', 100), typeFilter(req.query.requestType), statusFilter(req.query.status),
      req.query.cycleYear === undefined ? null : integer(req.query.cycleYear, 0, 'cycleYear', 2200)))
  })
  router.get('/requests/:id', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await workflow.detail(req.params.id, authContext(res)))
  })
  router.get('/requests/:id/signoffs', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    await workflow.detail(req.params.id, authContext(res))
    res.json(await signatures.signoffs(req.params.id))
  })
  router.post('/requests/:id/signoff', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['signatureAssetId','jobTitle'])
    res.status(201).json(await signatures.sign(req.params.id, body.signatureAssetId, body.jobTitle, authContext(res), evidence(res)))
  })
  router.get('/requests/:id/documents', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    await workflow.detail(req.params.id, authContext(res))
    res.json(await pdf.documents(req.params.id, authContext(res)))
  })
  router.get('/requests/:id/pdf/draft', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    await workflow.detail(req.params.id, authContext(res))
    sendPdf(res, await pdf.draft(req.params.id, authContext(res)), req.query.download === '1')
  })
  router.get('/requests/:id/pdf/received/:snapshotId', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    sendPdf(res, await pdf.received(req.params.id, req.params.snapshotId, authContext(res)), req.query.download === '1')
  })
  router.get('/requests/:id/pdf/final', requireActiveRole('EMPLOYEE_AFFAIRS'), async (req, res) => {
    sendPdf(res, await pdf.final(req.params.id, authContext(res)), req.query.download === '1')
  })
  router.get('/requests/:id/pdf/audit', requireActiveRole('EMPLOYEE_AFFAIRS'), async (req, res) => {
    sendPdf(res, await pdf.requestAudit(req.params.id, authContext(res)), req.query.download === '1')
  })
  router.post('/requests/:id/candidates', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['personnelNumber'])
    res.status(201).json(await workflow.addCandidate(req.params.id, personnelNumber(body.personnelNumber), authContext(res), evidence(res)))
  })
  router.delete('/requests/:id/candidates/:candidateId', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    await workflow.removeCandidate(req.params.id, req.params.candidateId, authContext(res), evidence(res))
    res.status(204).send()
  })
  router.get('/requests/:id/authority-options', requireActiveRole('EMPLOYEE_AFFAIRS'), async (req, res) => {
    res.json(await workflow.authorityOptions(req.params.id, authContext(res)))
  })
  router.put('/requests/:id/authority', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['authorityAssignmentId'])
    res.json(await workflow.selectAuthority(req.params.id, body.authorityAssignmentId, authContext(res), evidence(res)))
  })
  router.get('/requests/:id/notes', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await workflow.notes(req.params.id, authContext(res), integer(req.query.top, 100, 'top', 100)))
  })
  router.post('/requests/:id/notes', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['candidateId','message'])
    res.status(201).json(await workflow.addNote(req.params.id, body.candidateId, noteText(body.message), authContext(res), evidence(res)))
  })
  router.get('/requests/:id/timeline', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await workflow.timeline(req.params.id, authContext(res), integer(req.query.top, 100, 'top', 100)))
  })
  router.get('/requests/:id/secondment/positions', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await secondment.positions(req.params.id, authContext(res)))
  })
  router.post('/requests/:id/secondment/candidates/:candidateId/positions', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['positionTitle','organizationalDependency','qualificationStatus'])
    res.status(201).json(await secondment.addPosition(req.params.id, req.params.candidateId, body, authContext(res), evidence(res)))
  })
  router.put('/requests/:id/secondment/candidates/:candidateId/category', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['jobCategoryCode'])
    res.json(await secondment.setCandidateCategory(req.params.id, req.params.candidateId, body.jobCategoryCode, authContext(res), evidence(res)))
  })
  router.put('/requests/:id/secondment/positions/:positionId', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['positionTitle','organizationalDependency','qualificationStatus'])
    res.json(await secondment.updatePosition(req.params.id, req.params.positionId, body, authContext(res), evidence(res)))
  })
  router.delete('/requests/:id/secondment/positions/:positionId', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    await secondment.removePosition(req.params.id, req.params.positionId, authContext(res), evidence(res))
    res.status(204).send()
  })
  router.put('/requests/:id/secondment/candidates/:candidateId/selection', requireActiveRole('APPROVING_AUTHORITY'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['positionId'])
    res.json(await secondment.selectPosition(req.params.id, req.params.candidateId, body.positionId, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/secondment/submit-s1', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await secondment.submitS1(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/secondment/submit-s2', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await secondment.submitS2(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/secondment/approve-s3', requireActiveRole('APPROVING_AUTHORITY'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await secondment.approveS3(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/secondment/confirm-s4', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await secondment.confirmS4(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/secondment/final-approve-s5', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await secondment.approveS5(req.params.id, authContext(res), evidence(res)))
  })
  router.get('/requests/:id/promotion/decisions', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await promotion.decisions(req.params.id, authContext(res)))
  })
  router.put('/requests/:id/promotion/candidates/:candidateId/preparation', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['jobCategoryCode','lastPromotionReport'])
    res.json(await promotion.prepareCandidate(req.params.id, req.params.candidateId, body, authContext(res), evidence(res)))
  })
  router.put('/requests/:id/promotion/candidates/:candidateId/decision', requireActiveRole('APPROVING_AUTHORITY'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['decisionType','targetJobTitle','notes'])
    res.json(await promotion.decide(req.params.id, req.params.candidateId, body, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/promotion/submit-p1', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await promotion.submitP1(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/promotion/submit-p2', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await promotion.submitP2(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/promotion/approve-p3', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await promotion.approveP3(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/promotion/approve-p4', requireActiveRole('APPROVING_AUTHORITY'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await promotion.approveP4(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/promotion/final-approve-p5', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, []); res.json(await promotion.approveP5(req.params.id, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/return-for-correction', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['reason'])
    res.json(await controls.returnOrReject(req.params.id, 'RETURN', body.reason, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/reject', requireActiveRole('EMPLOYEE_AFFAIRS','ORGANIZATION','APPROVING_AUTHORITY'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['reason'])
    res.json(await controls.returnOrReject(req.params.id, 'REJECT', body.reason, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/restart', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['reason'])
    res.json(await controls.restart(req.params.id, body.reason, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/cancel-returned', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['reason'])
    res.json(await controls.cancelReturned(req.params.id, body.reason, authContext(res), evidence(res)))
  })
  router.post('/requests/:id/recall', requireActiveRole('EMPLOYEE_AFFAIRS'), csrf, async (req, res) => {
    const body = exactObject(req.body, ['reason'])
    res.json(await controls.recall(req.params.id, body.reason, authContext(res), evidence(res)))
  })
  router.get('/organization/queue', requireActiveRole('ORGANIZATION'), async (req, res) => {
    res.json(await tasks.organizationQueue(authContext(res), integer(req.query.skip, 0, 'skip'), integer(req.query.top, 50, 'top', 100)))
  })
  router.get('/authority/queue', requireActiveRole('APPROVING_AUTHORITY'), async (req, res) => {
    res.json(await tasks.authorityQueue(authContext(res), integer(req.query.skip, 0, 'skip'), integer(req.query.top, 50, 'top', 100)))
  })
  router.post('/tasks/:taskId/claim', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    res.json(await tasks.claim(req.params.taskId, authContext(res), evidence(res)))
  })
  return router
}
