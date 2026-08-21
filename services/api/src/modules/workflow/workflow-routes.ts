import express, { Router } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireOperational } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { exactObject, optionalText, text, uuid } from '../../shared/validation.ts'
import { WorkflowEngineService } from './workflow-engine-service.ts'
import { PromotionWorkflowService } from './promotion-workflow-service.ts'
import { SecondmentWorkflowService } from './secondment-workflow-service.ts'
import type {
  AddNoteInput,
  AssignStageInput,
  WorkflowRequestContext
} from './workflow-types.ts'

function context(res: express.Response): WorkflowRequestContext {
  const auth = authContext(res)
  return {
    userId: auth.userId,
    username: auth.username
  }
}

export function workflowRouter(pool: Pool, config: AppConfig): Router {
  const router = Router()
  const engine = new WorkflowEngineService(pool, config)
  const promotion = new PromotionWorkflowService(pool)
  const secondment = new SecondmentWorkflowService(pool)
  const csrf = csrfProtection(pool, config)

  router.use(requireOperational)

  // 1. Requests
  router.post('/requests', csrf, async (req, res, next) => {
    try {
      const body = exactObject(req.body, ['requestType', 'routingUnitId'])
      const requestType = text(body.requestType, 'requestType', 20)
      const routingUnitId = uuid(body.routingUnitId, 'routingUnitId')
      const result = await engine.createRequest({ requestType: requestType as any, routingUnitId }, context(res))
      res.status(201).json(result)
    } catch (error) { next(error) }
  })

  router.get('/requests', async (req, res, next) => {
    try {
      const skip = typeof req.query.skip === 'string' && /^\d+$/.test(req.query.skip) ? Number(req.query.skip) : 0
      const top = typeof req.query.top === 'string' && /^\d+$/.test(req.query.top) ? Math.min(100, Number(req.query.top)) : 50
      const result = await engine.listRequests(context(res), skip, top)
      res.json(result)
    } catch (error) { next(error) }
  })

  router.get('/requests/:id', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.id, 'id')
      const result = await engine.getRequest(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/requests/:id/restart', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const requestId = uuid(req.params.id, 'id')
      const result = await engine.restartRequest(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/requests/:id/cancel', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const requestId = uuid(req.params.id, 'id')
      const result = await engine.cancelRequest(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  // 2. Candidates
  router.post('/requests/:requestId/candidates', csrf, async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const body = exactObject(req.body, ['personnelNumber'])
      const personnelNumber = text(body.personnelNumber, 'personnelNumber', 30)
      const result = await engine.addCandidate(requestId, { personnelNumber }, context(res))
      res.status(201).json(result)
    } catch (error) { next(error) }
  })

  router.delete('/requests/:requestId/candidates/:candidateId', csrf, async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const candidateId = uuid(req.params.candidateId, 'candidateId')
      await engine.removeCandidate(requestId, candidateId, context(res))
      res.json({ success: true, candidateId })
    } catch (error) { next(error) }
  })

  // 3. Notes & Timeline
  router.get('/requests/:requestId/notes', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const result = await engine.listNotes(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/requests/:requestId/notes', csrf, async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const body = exactObject(req.body, ['body', 'candidateId'])
      const noteBody = text(body.body, 'body', 4000)
      const candidateRaw = body.candidateId
      const candidateId =
        candidateRaw === undefined || candidateRaw === null || candidateRaw === ''
          ? null
          : uuid(candidateRaw, 'candidateId')
      const noteInput: AddNoteInput =
        candidateId === null
          ? { body: noteBody }
          : { body: noteBody, candidateId }
      const result = await engine.addNote(requestId, noteInput, context(res))
      res.status(201).json(result)
    } catch (error) { next(error) }
  })

  router.get('/requests/:requestId/timeline', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const result = await engine.getTimeline(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  // 4. Inboxes
  router.get('/manager/inbox', async (_req, res, next) => {
    try {
      const result = await engine.getManagerInbox(context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.get('/my-work', async (_req, res, next) => {
    try {
      const result = await engine.getMyWork(context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  // 5. Stage Operations
  router.post('/stages/:id/assign', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.id, 'id')
      const body = exactObject(req.body, ['assignedToUserId', 'reason'])
      const assignedToUserId = uuid(body.assignedToUserId, 'assignedToUserId')
      const reason = optionalText(body.reason, 'reason', 500)
      const assignInput: AssignStageInput =
        reason === null
          ? { assignedToUserId }
          : { assignedToUserId, reason }
      const result = await engine.assignStage(stageExecutionId, assignInput, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/take', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const stageExecutionId = uuid(req.params.id, 'id')
      const result = await engine.takeStage(stageExecutionId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/submit-to-manager', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const stageExecutionId = uuid(req.params.id, 'id')
      const result = await engine.submitToManager(stageExecutionId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/internal-correction', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.id, 'id')
      const body = exactObject(req.body, ['reason'])
      const reason = text(body.reason, 'reason', 1000)
      const result = await engine.internalCorrection(stageExecutionId, { reason }, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/return-previous', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.id, 'id')
      const body = exactObject(req.body, ['reason'])
      const reason = text(body.reason, 'reason', 1000)
      const result = await engine.returnPreviousStage(stageExecutionId, { reason }, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/reject', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.id, 'id')
      const body = exactObject(req.body, ['reason'])
      const reason = text(body.reason, 'reason', 1000)
      const result = await engine.rejectStage(stageExecutionId, { reason }, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/approve-and-advance', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const stageExecutionId = uuid(req.params.id, 'id')
      const result = await engine.approveAndAdvance(stageExecutionId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:id/sign-and-advance', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.id, 'id')
      const body = exactObject(req.body, ['password', 'signatureAssetId', 'jobTitleOverride'])
      // Passwords are intentionally not passed through text(): that helper trims
      // values, while signature reauthentication must verify the exact bytes sent.
      const password = body.password
      const signatureAssetId = uuid(body.signatureAssetId, 'signatureAssetId')
      const jobTitleOverride = optionalText(body.jobTitleOverride, 'jobTitleOverride', 240)
      const userAgent = req.headers['user-agent']
      const evidence = {
        ...(req.ip ? { ipAddress: req.ip } : {}),
        ...(typeof userAgent === 'string' ? { userAgent } : {})
      }
      const result = await engine.signAndAdvance(
        stageExecutionId,
        {
          password: password as string,
          signatureAssetId,
          ...(jobTitleOverride !== undefined ? { jobTitleOverride } : {})
        },
        context(res),
        evidence
      )
      res.json(result)
    } catch (error) { next(error) }
  })

  // 6. Promotion Decisions
  router.get('/requests/:requestId/promotion/decisions', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const result = await promotion.getAuthoritativeDecisions(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.put('/stages/:stageExecutionId/promotion/candidates/:candidateId/decision', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const candidateId = uuid(req.params.candidateId, 'candidateId')
      const body = exactObject(req.body, ['decisionType', 'targetJobTitle', 'recommendation', 'notes'])
      const decisionType = text(body.decisionType, 'decisionType', 20) as 'SAME_POSITION' | 'OTHER_POSITION'
      const targetJobTitle = optionalText(body.targetJobTitle, 'targetJobTitle', 240)
      const recommendation = text(body.recommendation, 'recommendation', 80, 1)
      const notes = optionalText(body.notes, 'notes', 4000)
      const result = await promotion.upsertDecision(
        stageExecutionId,
        candidateId,
        { decisionType, targetJobTitle, recommendation, notes },
        context(res)
      )
      res.json(result)
    } catch (error) { next(error) }
  })

  // 7. Secondment Position Options & Selections
  router.get('/requests/:requestId/secondment/options', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const result = await secondment.getAuthoritativePositionOptions(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.put('/stages/:stageExecutionId/secondment/candidates/:candidateId/preparation', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const candidateId = uuid(req.params.candidateId, 'candidateId')
      const body = exactObject(req.body, ['lastPromotionReport', 'jobCategoryCode'])
      const lastPromotionReport = text(body.lastPromotionReport, 'lastPromotionReport', 4000, 1)
      const jobCategoryCode = text(body.jobCategoryCode, 'jobCategoryCode', 80, 1)
      const result = await secondment.upsertS2CandidatePreparation(
        stageExecutionId,
        candidateId,
        { lastPromotionReport, jobCategoryCode },
        context(res)
      )
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/stages/:stageExecutionId/secondment/candidates/:candidateId/options', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const candidateId = uuid(req.params.candidateId, 'candidateId')
      const body = exactObject(req.body, ['positionTitle', 'organizationalDependency', 'qualificationStatus'])
      const positionTitle = text(body.positionTitle, 'positionTitle', 240, 1)
      const organizationalDependency = text(body.organizationalDependency, 'organizationalDependency', 240, 1)
      const qualificationStatus = text(body.qualificationStatus, 'qualificationStatus', 80, 1)
      const result = await secondment.addPositionOption(
        stageExecutionId,
        candidateId,
        { positionTitle, organizationalDependency, qualificationStatus },
        context(res)
      )
      res.status(201).json(result)
    } catch (error) { next(error) }
  })

  router.put('/stages/:stageExecutionId/secondment/options/:optionId', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const optionId = uuid(req.params.optionId, 'optionId')
      const body = exactObject(req.body, ['positionTitle', 'organizationalDependency', 'qualificationStatus'])
      const positionTitle = text(body.positionTitle, 'positionTitle', 240, 1)
      const organizationalDependency = text(body.organizationalDependency, 'organizationalDependency', 240, 1)
      const qualificationStatus = text(body.qualificationStatus, 'qualificationStatus', 80, 1)
      const result = await secondment.updatePositionOption(
        stageExecutionId,
        optionId,
        { positionTitle, organizationalDependency, qualificationStatus },
        context(res)
      )
      res.json(result)
    } catch (error) { next(error) }
  })

  router.delete('/stages/:stageExecutionId/secondment/options/:optionId', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const optionId = uuid(req.params.optionId, 'optionId')
      const result = await secondment.removePositionOption(stageExecutionId, optionId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.get('/requests/:requestId/secondment/selections', async (req, res, next) => {
    try {
      const requestId = uuid(req.params.requestId, 'requestId')
      const result = await secondment.getAuthoritativeSelections(requestId, context(res))
      res.json(result)
    } catch (error) { next(error) }
  })

  router.put('/stages/:stageExecutionId/secondment/candidates/:candidateId/selection', csrf, async (req, res, next) => {
    try {
      const stageExecutionId = uuid(req.params.stageExecutionId, 'stageExecutionId')
      const candidateId = uuid(req.params.candidateId, 'candidateId')
      const body = exactObject(req.body, ['selectedOptionId'])
      const selectedOptionId = uuid(body.selectedOptionId, 'selectedOptionId')
      const result = await secondment.upsertSelection(
        stageExecutionId,
        candidateId,
        { selectedOptionId },
        context(res)
      )
      res.json(result)
    } catch (error) { next(error) }
  })

  // 8. Notifications
  router.get('/notifications', async (req, res, next) => {
    try {
      const skip = typeof req.query.skip === 'string' && /^\d+$/.test(req.query.skip) ? Number(req.query.skip) : 0
      const top = typeof req.query.top === 'string' && /^\d+$/.test(req.query.top) ? Math.min(100, Number(req.query.top)) : 50
      const unreadOnly = req.query.unread === 'true'
      const result = await engine.listNotifications(context(res), skip, top, unreadOnly)
      res.json(result)
    } catch (error) { next(error) }
  })

  router.post('/notifications/:id/read', csrf, async (req, res, next) => {
    try {
      exactObject(req.body ?? {}, [])
      const notificationId = uuid(req.params.id, 'id')
      await engine.markNotificationRead(notificationId, context(res))
      res.json({ success: true, notificationId })
    } catch (error) { next(error) }
  })

  return router
}
