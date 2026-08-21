import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import {
  type FinalFormSnapshotPayload,
  type FinalFormCandidate,
  computeSnapshotSha256,
  PROMOTION_TEMPLATE_V3,
  SECONDMENT_TEMPLATE_BASELINE
} from './form-snapshot.ts'
import {
  type AuditPdfEntry,
  renderAuditTrailPdf,
  renderOfficialFormPdf
} from './pdf-renderer.ts'
import { requireRequestReadAccess } from './workflow-auth.ts'
import type { WorkflowRequestContext } from './workflow-types.ts'
import { PdfRenderLimiter } from './pdf-render-limiter.ts'

const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i
const SIG_STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i

export class PdfService {
  private readonly limiter: PdfRenderLimiter
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig
  ) {
    this.limiter = new PdfRenderLimiter(config.pdf.maxConcurrentRenders, config.pdf.maxQueuedRenders, config.pdf.renderTimeoutMs)
  }

  private resolvePdfPath(storageKey: string): string {
    const cleanKey = basename(storageKey)
    if (!STORAGE_KEY_PATTERN.test(cleanKey)) {
      throw new AppError(400, 'Invalid PDF storage key', 'PDF_STORAGE_KEY_INVALID')
    }
    const baseDir = resolve(this.config.pdf.storageDirectory)
    const filePath = resolve(join(baseDir, cleanKey))
    if (!filePath.startsWith(baseDir + sep) && filePath !== baseDir) {
      throw new AppError(400, 'Invalid PDF path traversal', 'PDF_PATH_TRAVERSAL')
    }
    return filePath
  }

  private resolveSigPath(storageKey: string): string {
    const cleanKey = basename(storageKey)
    if (!SIG_STORAGE_KEY_PATTERN.test(cleanKey)) {
      throw new AppError(400, 'Invalid signature storage key', 'SIGNATURE_STORAGE_KEY_INVALID')
    }
    const baseDir = resolve(this.config.signatures.storageDirectory)
    const filePath = resolve(join(baseDir, cleanKey))
    if (!filePath.startsWith(baseDir + sep) && filePath !== baseDir) {
      throw new AppError(400, 'Invalid signature path traversal', 'SIGNATURE_PATH_TRAVERSAL')
    }
    return filePath
  }

  private async loadVerifiedSignatureImages(
    signoffs: Array<{ signatureAssetId: string, signatureSha256: string }>
  ): Promise<Map<string, Buffer>> {
    const imageMap = new Map<string, Buffer>()
    for (const s of signoffs) {
      if (!s.signatureAssetId) continue
      const assetResult = await this.pool.query<{ storage_key: string, sha256: string }>(
        `SELECT storage_key, sha256 FROM user_signature_asset WHERE id = $1`,
        [s.signatureAssetId]
      )
      const row = assetResult.rows[0]
      if (!row) {
        throw new AppError(500, 'Signature asset referenced by frozen evidence is missing', 'SIGNATURE_EVIDENCE_MISSING')
      }

      const filePath = this.resolveSigPath(row.storage_key)
      let buffer: Buffer
      try {
        buffer = await readFile(filePath)
      } catch {
        throw new AppError(500, 'Signature asset file missing from disk', 'SIGNATURE_FILE_MISSING')
      }

      const hash = createHash('sha256').update(buffer).digest('hex')
      if (hash !== s.signatureSha256) {
        throw new AppError(500, 'Signature asset integrity checksum mismatch', 'SIGNATURE_INTEGRITY_MISMATCH')
      }

      imageMap.set(s.signatureAssetId, buffer)
    }
    return imageMap
  }

  async getCurrentPdf(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<{ buffer: Buffer, filename: string }> {
    const requestId = uuid(requestIdValue, 'requestId')

    // 1. Authorize read access
    await requireRequestReadAccess(this.pool, actor.userId, requestId)
    const requestResult = await this.pool.query<{ id: string, requestNumber: string, requestType: 'PROMOTION' | 'SECONDMENT', routingUnitId: string | null, status: string, currentIterationId: string | null }>(
      `SELECT id, request_number AS "requestNumber", request_type AS "requestType", routing_unit_id AS "routingUnitId", status, current_iteration_id AS "currentIterationId" FROM workflow_request WHERE id = $1`,
      [requestId]
    )
    const request = requestResult.rows[0]
    if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')

    // 2. Fetch current active iteration
    const iterResult = await this.pool.query<{ id: string, iteration_no: number }>(
      `SELECT id, iteration_no FROM workflow_iteration WHERE id = $1`,
      [request.currentIterationId]
    )
    const iteration = iterResult.rows[0]
    if (!iteration) {
      throw new AppError(404, 'No active iteration found for request', 'ITERATION_NOT_FOUND')
    }

    // 3. Routing Unit info
    let routingUnit: { id: string, code: string, nameAr: string } | null = null
    if (request.routingUnitId) {
      const ruResult = await this.pool.query<{ id: string, code: string, name_ar: string }>(
        `SELECT id, code, name_ar FROM routing_unit WHERE id = $1`,
        [request.routingUnitId]
      )
      if (ruResult.rows[0]) {
        routingUnit = {
          id: ruResult.rows[0].id,
          code: ruResult.rows[0].code,
          nameAr: ruResult.rows[0].name_ar
        }
      }
    }

    // 4. Fetch current candidates
    const candResult = await this.pool.query<{
      candidateId: string
      personnelNumber: string
      employeeData: Record<string, unknown>
      acceptedData: Record<string, unknown>
      snapshotYear: number | null
    }>(
      `SELECT rc.id AS "candidateId",
              eas.personnel_number AS "personnelNumber",
               rc.frozen_data AS "employeeData",
              rc.accepted_data AS "acceptedData",
              eas.snapshot_year AS "snapshotYear"
         FROM request_candidate rc
         JOIN employee_annual_snapshot eas ON eas.id = rc.employee_snapshot_id
        WHERE rc.request_id = $1
        ORDER BY eas.personnel_number, rc.id`,
      [requestId]
    )

    const cycleYear = candResult.rows[0]?.snapshotYear ?? null

    // 5. Fetch available signoffs in current iteration
    const signoffsResult = await this.pool.query<{
      stageCode: string
      stageExecutionId: string
      executionNo: number
      signerUserId: string
      signerName: string
      signerUsername: string
      signerJobTitle: string
      jobTitleWasOverridden: boolean
      operationalUnitId: string
      operationalUnitKind: string
      managerAssignmentId: string | null
      signatureAssetId: string
      signatureSha256: string
      signedAt: Date
    }>(
      `SELECT DISTINCT ON (se.stage_code)
              se.stage_code AS "stageCode",
              se.id AS "stageExecutionId",
              se.execution_no AS "executionNo",
              ws.signer_user_id AS "signerUserId",
              ws.signer_snapshot->>'signerName' AS "signerName",
              ws.signer_snapshot->>'signerUsername' AS "signerUsername",
              ws.signer_snapshot->>'signerJobTitle' AS "signerJobTitle",
              (ws.signer_snapshot->>'jobTitleWasOverridden')::boolean AS "jobTitleWasOverridden",
              ws.signer_snapshot->>'operationalUnitId' AS "operationalUnitId",
              ws.signer_snapshot->>'operationalUnitKind' AS "operationalUnitKind",
              ws.manager_assignment_id AS "managerAssignmentId",
              ws.signature_asset_id AS "signatureAssetId",
              ws.signature_sha256 AS "signatureSha256",
              ws.signed_at AS "signedAt"
         FROM stage_execution se
         JOIN workflow_signoff ws ON ws.stage_execution_id = se.id
           WHERE pd.stage_execution_id = (
             SELECT id FROM stage_execution WHERE iteration_id = $1 AND stage_code = 'P4'
             ORDER BY execution_no DESC LIMIT 1
           )
          AND se.status = 'COMPLETED'
        ORDER BY se.stage_code, se.execution_no DESC`,
      [iteration.id]
    )

    const signoffs = signoffsResult.rows.map(s => ({
      stageCode: s.stageCode,
      stageExecutionId: s.stageExecutionId,
      executionNo: Number(s.executionNo),
      signerUserId: s.signerUserId,
      signerName: s.signerName ?? '',
      signerUsername: s.signerUsername ?? '',
      signerJobTitle: s.signerJobTitle ?? '',
      jobTitleWasOverridden: Boolean(s.jobTitleWasOverridden),
      operationalUnitId: s.operationalUnitId ?? '',
      operationalUnitKind: s.operationalUnitKind ?? '',
      managerAssignmentId: s.managerAssignmentId,
      signatureAssetId: s.signatureAssetId,
      signatureSha256: s.signatureSha256,
      signedAt: new Date(s.signedAt).toISOString()
    }))

    // 6. Promotion / Secondment Candidate Decisions
    const candidates: FinalFormCandidate[] = []
    if (request.requestType === 'PROMOTION') {
      const decResult = await this.pool.query<{
        candidateId: string
        decisionType: 'SAME_POSITION' | 'OTHER_POSITION'
        targetJobTitle: string | null
        recommendation: string | null
        notes: string | null
      }>(
        `SELECT pd.candidate_id AS "candidateId",
                pd.decision_type AS "decisionType",
                pd.target_job_title AS "targetJobTitle",
                pd.recommendation,
                pd.notes
           FROM promotion_decision pd
           JOIN stage_execution se ON se.id = pd.stage_execution_id
           WHERE pd.stage_execution_id = (
             SELECT id FROM stage_execution WHERE iteration_id = $1 AND stage_code = 'P4'
             ORDER BY execution_no DESC LIMIT 1
           )
          ORDER BY se.execution_no DESC`,
        [iteration.id]
      )
      const decMap = new Map(decResult.rows.map(d => [d.candidateId, d]))

      for (const c of candResult.rows) {
        const empData = c.employeeData ?? {}
        const dec = decMap.get(c.candidateId)
        const isSame = dec?.decisionType === 'SAME_POSITION'
        const currentJob = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : ''

        candidates.push({
          candidateId: c.candidateId,
          personnelNumber: c.personnelNumber,
          employeeName: String(empData.employeeName ?? ''),
          currentJobTitle: currentJob,
          currentJobStartDate: typeof empData.currentJobStartDate === 'string' ? empData.currentJobStartDate : null,
          sourceRoutingLabel: typeof empData.sourceRoutingLabel === 'string' && empData.sourceRoutingLabel.trim() ? empData.sourceRoutingLabel.trim() : null,
          subgroup: typeof empData.subgroup === 'string' ? empData.subgroup : null,
          department: typeof empData.department === 'string' ? empData.department : null,
          seniorityDate: typeof empData.seniorityDate === 'string' ? empData.seniorityDate : null,
          joiningDate: typeof empData.joiningDate === 'string' ? empData.joiningDate : null,
          experienceStartDate: typeof empData.experienceStartDate === 'string' ? empData.experienceStartDate : null,
          qualificationDate: typeof empData.originalQualificationDate === 'string' ? empData.originalQualificationDate : null,
          qualificationName: typeof empData.originalQualificationCertificate === 'string' ? empData.originalQualificationCertificate : null,
          qualificationInstitute: typeof empData.originalQualificationSource === 'string' ? empData.originalQualificationSource : null,
          performanceRating: typeof empData.performanceRating === 'string' ? empData.performanceRating : null,
          lastPromotionReport: typeof empData.lastPromotionReport === 'string' ? empData.lastPromotionReport : null,
          experience: {
            years: typeof empData.experienceYears === 'number' ? empData.experienceYears : null,
            months: typeof empData.experienceMonths === 'number' ? empData.experienceMonths : null,
            days: typeof empData.experienceDays === 'number' ? empData.experienceDays : null,
            referenceDate: typeof empData.experienceReferenceDate === 'string' ? empData.experienceReferenceDate : null
          },
          ...(dec ? {
            promotionDecision: {
              decisionType: dec.decisionType,
              targetJobTitle: isSame ? null : dec.targetJobTitle,
              effectiveNominatedJob: isSame ? currentJob : dec.targetJobTitle,
              recommendation: dec.recommendation,
              notes: dec.notes
            }
          } : {})
        })
      }
    } else {
      const selResult = await this.pool.query<{
        candidateId: string
        selectedOptionId: string
        positionTitle: string
        organizationalDependency: string
        qualificationStatus: string
        qualificationStatusName: string | null
      }>(
        `SELECT sd.candidate_id AS "candidateId",
                sd.selected_option_id AS "selectedOptionId",
                spo.position_title AS "positionTitle",
                spo.organizational_dependency AS "organizationalDependency",
                spo.qualification_status AS "qualificationStatus",
                qsr.name AS "qualificationStatusName"
           FROM secondment_decision sd
           JOIN stage_execution se ON se.id = sd.stage_execution_id
           JOIN secondment_position_option spo ON spo.id = sd.selected_option_id
           LEFT JOIN qualification_status_reference qsr ON qsr.code = spo.qualification_status
          WHERE se.iteration_id = $1
          ORDER BY se.execution_no DESC`,
        [iteration.id]
      )
      const selMap = new Map(selResult.rows.map(s => [s.candidateId, s]))

      for (const c of candResult.rows) {
        const empData = c.employeeData ?? {}
        const sel = selMap.get(c.candidateId)

        candidates.push({
          candidateId: c.candidateId,
          personnelNumber: c.personnelNumber,
          employeeName: String(empData.employeeName ?? ''),
          currentJobTitle: String(empData.currentJobTitle ?? ''),
          currentJobStartDate: typeof empData.currentJobStartDate === 'string' ? empData.currentJobStartDate : null,
          sourceRoutingLabel: typeof empData.sourceRoutingLabel === 'string' && empData.sourceRoutingLabel.trim() ? empData.sourceRoutingLabel.trim() : null,
          subgroup: typeof empData.subgroup === 'string' ? empData.subgroup : null,
          department: typeof empData.department === 'string' ? empData.department : null,
          seniorityDate: typeof empData.seniorityDate === 'string' ? empData.seniorityDate : null,
          joiningDate: typeof empData.joiningDate === 'string' ? empData.joiningDate : null,
          experienceStartDate: typeof empData.experienceStartDate === 'string' ? empData.experienceStartDate : null,
          qualificationDate: typeof empData.originalQualificationDate === 'string' ? empData.originalQualificationDate : null,
          qualificationName: typeof empData.originalQualificationCertificate === 'string' ? empData.originalQualificationCertificate : null,
          qualificationInstitute: typeof empData.originalQualificationSource === 'string' ? empData.originalQualificationSource : null,
          performanceRating: typeof empData.performanceRating === 'string' ? empData.performanceRating : null,
          lastPromotionReport: typeof empData.lastPromotionReport === 'string' ? empData.lastPromotionReport : null,
          experience: {
            years: typeof empData.experienceYears === 'number' ? empData.experienceYears : null,
            months: typeof empData.experienceMonths === 'number' ? empData.experienceMonths : null,
            days: typeof empData.experienceDays === 'number' ? empData.experienceDays : null,
            referenceDate: typeof empData.experienceReferenceDate === 'string' ? empData.experienceReferenceDate : null
          },
          ...(sel ? {
            secondmentSelection: {
              selectedOptionId: sel.selectedOptionId,
              positionTitle: sel.positionTitle,
              organizationalDependency: sel.organizationalDependency,
              qualificationStatus: sel.qualificationStatus,
              qualificationStatusName: sel.qualificationStatusName
            }
          } : {})
        })
      }
    }

    const payload: FinalFormSnapshotPayload = {
      schemaVersion: 1,
      kind: 'FINAL',
      templateVersion: request.requestType === 'PROMOTION' ? PROMOTION_TEMPLATE_V3 : SECONDMENT_TEMPLATE_BASELINE,
      requestId: request.id,
      requestNumber: request.requestNumber,
      requestType: request.requestType,
      routingUnit,
      iterationId: iteration.id,
      iterationNo: Number(iteration.iteration_no),
      cycleYear,
      capturedAt: new Date().toISOString(),
      candidates,
      signoffs
    }

    const images = await this.loadVerifiedSignatureImages(signoffs)
    const buffer = await this.limiter.run(() => renderOfficialFormPdf(payload, images, this.config.pdf.maxOutputBytes))

    return {
      buffer,
      filename: `${request.requestNumber}-current.pdf`
    }
  }

  async getFinalPdf(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<{ buffer: Buffer, filename: string }> {
    const requestId = uuid(requestIdValue, 'requestId')

    // 1. Authorize read access
    await requireRequestReadAccess(this.pool, actor.userId, requestId)
    const requestResult = await this.pool.query<{ id: string, requestNumber: string, status: string }>(
      `SELECT id, request_number AS "requestNumber", status FROM workflow_request WHERE id = $1`, [requestId]
    )
    const request = requestResult.rows[0]
    if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')
    if (request.status !== 'COMPLETED') {
      throw new AppError(400, 'Final PDF is only available for COMPLETED requests', 'REQUEST_NOT_COMPLETED')
    }

    // 2. Fetch completed iteration & final snapshot
    const snapResult = await this.pool.query<{
      id: string
      template_version: string
      payload: FinalFormSnapshotPayload
      sha256: string
    }>(
      `SELECT ffs.id, ffs.template_version, ffs.payload, ffs.sha256
         FROM final_form_snapshot ffs
         JOIN workflow_iteration wi ON wi.id = ffs.iteration_id
        WHERE ffs.request_id = $1 AND wi.status = 'COMPLETED'
        ORDER BY wi.iteration_no DESC
        LIMIT 1`,
      [requestId]
    )

    const snapshot = snapResult.rows[0]
    if (!snapshot) {
      throw new AppError(404, 'Final form snapshot not found for completed request', 'FINAL_SNAPSHOT_NOT_FOUND')
    }
    if (computeSnapshotSha256(snapshot.payload) !== snapshot.sha256) {
      throw new AppError(500, 'Final form snapshot integrity mismatch', 'FINAL_SNAPSHOT_INTEGRITY_MISMATCH')
    }

    const buffer = await this.ensureFinalPdfMaterialized(requestId, snapshot.id)
    return { buffer, filename: `${request.requestNumber}-final.pdf` }
  }

  async getAuditPdf(
    requestIdValue: unknown,
    actor: WorkflowRequestContext
  ): Promise<{ buffer: Buffer, filename: string }> {
    const requestId = uuid(requestIdValue, 'requestId')
    await requireRequestReadAccess(this.pool, actor.userId, requestId)
    const requestResult = await this.pool.query<{ requestNumber: string }>(
      `SELECT request_number AS "requestNumber" FROM workflow_request WHERE id = $1`, [requestId]
    )
    const request = requestResult.rows[0]
    if (!request) throw new AppError(404, 'Workflow request not found', 'REQUEST_NOT_FOUND')

    // Fetch chronological history
    const actionsResult = await this.pool.query<{
      requestNumber: string
      iterationNo: number
      stageCode: string | null
      actorName: string | null
      actorUsername: string | null
      actionType: string
      reason: string | null
      payload: Record<string, unknown>
      createdAt: Date
    }>(
      `SELECT r.request_number AS "requestNumber",
              wi.iteration_no AS "iterationNo",
              se.stage_code AS "stageCode",
              ua.display_name AS "actorName",
              ua.username AS "actorUsername",
              sa.action_type AS "actionType",
              sa.reason,
              sa.payload,
              sa.created_at AS "createdAt"
         FROM stage_action sa
         JOIN stage_execution se ON se.id = sa.stage_execution_id
         JOIN workflow_iteration wi ON wi.id = se.iteration_id
         JOIN workflow_request r ON r.id = wi.request_id
         LEFT JOIN user_account ua ON ua.id = sa.actor_user_id
        WHERE r.id = $1
        ORDER BY sa.created_at ASC`,
      [requestId]
    )

    const entries: AuditPdfEntry[] = actionsResult.rows.map(row => ({
      requestNumber: row.requestNumber,
      iterationNo: Number(row.iterationNo),
      stageCode: row.stageCode,
      actorName: row.actorName,
      actorUsername: row.actorUsername,
      actionType: row.actionType,
      reason: row.reason,
      details: row.payload ?? {},
      createdAt: new Date(row.createdAt).toISOString()
    }))

    // Evidence references are deliberately summarized, not dumped: the report
    // remains readable and never discloses signature storage keys or secrets.
    const [iterations, executions, assignments, snapshots, signoffs, audits, notes] = await Promise.all([
      this.pool.query(`SELECT iteration_no AS "iterationNo", status, started_at AS "startedAt", ended_at AS "endedAt" FROM workflow_iteration WHERE request_id=$1`, [requestId]),
      this.pool.query(`SELECT wi.iteration_no AS "iterationNo", se.stage_code AS "stageCode", se.execution_no AS "executionNo", se.status, se.opened_at AS "openedAt", se.completed_at AS "completedAt" FROM stage_execution se JOIN workflow_iteration wi ON wi.id=se.iteration_id WHERE wi.request_id=$1`, [requestId]),
      this.pool.query(`SELECT wi.iteration_no AS "iterationNo", se.stage_code AS "stageCode", wa.assigned_at AS "occurredAt", wa.end_reason AS "reason" FROM work_assignment wa JOIN stage_execution se ON se.id=wa.stage_execution_id JOIN workflow_iteration wi ON wi.id=se.iteration_id WHERE wi.request_id=$1`, [requestId]),
      this.pool.query(`SELECT wi.iteration_no AS "iterationNo", se.stage_code AS "stageCode", ss.sha256, ss.created_at AS "occurredAt" FROM stage_submission_snapshot ss JOIN stage_execution se ON se.id=ss.stage_execution_id JOIN workflow_iteration wi ON wi.id=se.iteration_id WHERE wi.request_id=$1`, [requestId]),
      this.pool.query(`SELECT wi.iteration_no AS "iterationNo", se.stage_code AS "stageCode", ws.signer_snapshot->>'signerName' AS "actorName", ws.signature_sha256 AS "sha256", ws.signed_at AS "occurredAt" FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id JOIN workflow_iteration wi ON wi.id=se.iteration_id WHERE wi.request_id=$1`, [requestId]),
      this.pool.query(`SELECT event_type AS "actionType", details, created_at AS "occurredAt" FROM audit_event WHERE subject_id IN (SELECT se.id FROM stage_execution se JOIN workflow_iteration wi ON wi.id=se.iteration_id WHERE wi.request_id=$1)`, [requestId]),
      this.pool.query(`SELECT wi.iteration_no AS "iterationNo", se.stage_code AS "stageCode", n.body AS reason, n.created_at AS "occurredAt" FROM workflow_note n LEFT JOIN workflow_iteration wi ON wi.id=n.iteration_id LEFT JOIN stage_execution se ON se.id=n.stage_execution_id WHERE n.request_id=$1`, [requestId])
    ])
    for (const row of iterations.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo), stageCode: null, actorName: null, actorUsername: null, actionType: `ITERATION_${row.status}`, reason: null, details: {}, createdAt: new Date(row.endedAt ?? row.startedAt).toISOString() })
    for (const row of executions.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo), stageCode: row.stageCode, actorName: null, actorUsername: null, actionType: `STAGE_${row.status}`, reason: null, details: { executionNo: row.executionNo }, createdAt: new Date(row.completedAt ?? row.openedAt).toISOString() })
    for (const row of assignments.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo), stageCode: row.stageCode, actorName: null, actorUsername: null, actionType: 'WORK_ASSIGNMENT', reason: row.reason, details: {}, createdAt: new Date(row.occurredAt).toISOString() })
    for (const row of snapshots.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo), stageCode: row.stageCode, actorName: null, actorUsername: null, actionType: 'STAGE_SNAPSHOT', reason: null, details: { sha256: row.sha256 }, createdAt: new Date(row.occurredAt).toISOString() })
    for (const row of signoffs.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo), stageCode: row.stageCode, actorName: row.actorName, actorUsername: null, actionType: 'WORKFLOW_SIGNOFF', reason: null, details: { signatureSha256: row.sha256 }, createdAt: new Date(row.occurredAt).toISOString() })
    for (const row of audits.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: 0, stageCode: null, actorName: null, actorUsername: null, actionType: row.actionType, reason: null, details: row.details ?? {}, createdAt: new Date(row.occurredAt).toISOString() })
    for (const row of notes.rows) entries.push({ requestNumber: request.requestNumber, iterationNo: Number(row.iterationNo ?? 0), stageCode: row.stageCode, actorName: null, actorUsername: null, actionType: 'WORKFLOW_NOTE', reason: row.reason, details: {}, createdAt: new Date(row.occurredAt).toISOString() })
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.actionType.localeCompare(b.actionType))

    const buffer = await this.limiter.run(() => renderAuditTrailPdf(entries, request.requestNumber, this.config.pdf.maxOutputBytes))

    return {
      buffer,
      filename: `${request.requestNumber}-audit.pdf`
    }
  }

  async materializeFinalPdfPostCommit(
    requestId: string,
    finalSnapshotId: string
  ): Promise<void> {
    try {
      await this.ensureFinalPdfMaterialized(requestId, finalSnapshotId)
    } catch { /* post-commit best effort; shared helper records safe failure */ }
  }

  private async ensureFinalPdfMaterialized(requestId: string, finalSnapshotId: string): Promise<Buffer> {
    const result = await this.pool.query<{ payload: FinalFormSnapshotPayload, sha256: string }>(`SELECT payload,sha256 FROM final_form_snapshot WHERE id=$1 AND request_id=$2`, [finalSnapshotId, requestId])
    const snapshot = result.rows[0]
    if (!snapshot) throw new AppError(404, 'Final form snapshot not found', 'FINAL_SNAPSHOT_NOT_FOUND')
    if (computeSnapshotSha256(snapshot.payload) !== snapshot.sha256) throw new AppError(500, 'Final form snapshot integrity mismatch', 'FINAL_SNAPSHOT_INTEGRITY_MISMATCH')
    const existing = await this.pool.query<{ storage_key: string, sha256: string, byte_size: number }>(`SELECT storage_key,sha256,byte_size FROM frozen_pdf_document WHERE final_form_snapshot_id=$1`, [finalSnapshotId])
    if (existing.rows[0]) return await this.readFrozenPdf(existing.rows[0])
    let path: string | null = null
    try {
      const images = await this.loadVerifiedSignatureImages(snapshot.payload.signoffs)
      const bytes = await this.limiter.run(() => renderOfficialFormPdf(snapshot.payload, images, this.config.pdf.maxOutputBytes))
      const key = `${randomUUID()}.pdf`; path = this.resolvePdfPath(key)
      await mkdir(this.config.pdf.storageDirectory, { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
      const winner = await withTransaction(this.pool, async db => {
        await db.query(`INSERT INTO frozen_pdf_document (id,final_form_snapshot_id,storage_key,sha256,byte_size,created_at) VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT (final_form_snapshot_id) DO NOTHING`, [randomUUID(), finalSnapshotId, key, createHash('sha256').update(bytes).digest('hex'), bytes.length])
        const authoritative = await db.query<{ storage_key: string, sha256: string, byte_size: number }>(
          'SELECT storage_key,sha256,byte_size FROM frozen_pdf_document WHERE final_form_snapshot_id=$1',
          [finalSnapshotId]
        )
        const row = authoritative.rows[0]
        if (!row) throw new AppError(500, 'Frozen PDF registration failed', 'FROZEN_PDF_REGISTRATION_FAILED')
        await db.query(`INSERT INTO pdf_generation_log (id,request_id,document_kind,succeeded,safe_metadata,created_at) VALUES ($1,$2,'FINAL_OFFICIAL',true,$3,CURRENT_TIMESTAMP)`, [randomUUID(), requestId, JSON.stringify({ snapshotId: finalSnapshotId, byteSize: row.byte_size })])
        return row
      })
      if (winner.storage_key !== key) await unlink(path).catch(() => undefined)
      path = null
      return await this.readFrozenPdf(winner)
    } catch (error) {
      if (path) await unlink(path).catch(() => undefined)
      await this.pool.query(`INSERT INTO pdf_generation_log (id,request_id,document_kind,succeeded,safe_metadata,created_at) VALUES ($1,$2,'FINAL_OFFICIAL',false,$3,CURRENT_TIMESTAMP)`, [randomUUID(), requestId, JSON.stringify({ failure: 'FINAL_PDF_MATERIALIZATION_FAILED' })]).catch(() => undefined)
      throw error
    }
  }

  private async readFrozenPdf(row: { storage_key: string, sha256: string, byte_size: number }): Promise<Buffer> {
    let bytes: Buffer
    try { bytes = await readFile(this.resolvePdfPath(row.storage_key)) } catch { throw new AppError(500, 'Frozen PDF file missing from storage', 'FROZEN_PDF_FILE_MISSING') }
    if (bytes.length !== Number(row.byte_size)) throw new AppError(500, 'Frozen PDF document size mismatch', 'FROZEN_PDF_INTEGRITY_MISMATCH')
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new AppError(500, 'Frozen PDF document integrity mismatch', 'FROZEN_PDF_INTEGRITY_MISMATCH')
    return bytes
  }
}
