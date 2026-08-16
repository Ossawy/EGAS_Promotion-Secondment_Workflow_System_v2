import { Router } from 'express'
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
  const csrf = csrfProtection(pool, config)

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
  router.get('/organization/queue', requireActiveRole('ORGANIZATION'), async (req, res) => {
    res.json(await tasks.organizationQueue(authContext(res), integer(req.query.skip, 0, 'skip'), integer(req.query.top, 50, 'top', 100)))
  })
  router.post('/tasks/:taskId/claim', requireActiveRole('ORGANIZATION'), csrf, async (req, res) => {
    exactObject(req.body ?? {}, [])
    res.json(await tasks.claim(req.params.taskId, authContext(res), evidence(res)))
  })
  return router
}
