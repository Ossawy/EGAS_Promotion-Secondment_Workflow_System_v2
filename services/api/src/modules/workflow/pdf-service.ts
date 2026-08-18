import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'
import { uuid } from '../../shared/validation.ts'
import type { AuthContext } from '../auth/types.ts'
import {
  buildFormSnapshot,
  PDF_TEMPLATE_V1,
  PDF_TEMPLATE_V2,
  PDF_TEMPLATE_VERSION,
  snapshotSha256,
  type FormSnapshot
} from './form-snapshot.ts'
import {
  renderAuditPdf,
  renderOfficialPdfV1,
  renderOfficialPdfV2,
  type AuditPdfEntry
} from './pdf-renderer.ts'
import { SignatureService } from './signature-service.ts'

type FrozenDocumentRow = {
  id: string
  requestId: string
  iterationId: string
  documentState: 'RECEIVED' | 'FINAL'
  receivedSnapshotId: string | null
  snapshotJson: FormSnapshot
  snapshotSha256: string
  templateVersion: string
  storageKey: string | null
  fileSha256: string | null
  fileSizeBytes: string | number | null
  routingUnitId: string | null
  requestNumber: string
}

export type PdfResult = { buffer: Buffer, filename: string, state: 'RECEIVED'|'DRAFT'|'FINAL'|'AUDIT_LOG' }
export type AdminAuditPdfInput = {
  requestId?: unknown
  routingUnitId?: unknown
  periodCode?: unknown
  periodStart?: unknown
  periodEnd?: unknown
}

class RenderLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly maximum: number, private readonly maxQueued: number, private readonly timeoutMs: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      if (this.queue.length >= this.maxQueued) throw new AppError(503, 'PDF renderer is busy', 'PDF_RENDERER_BUSY')
      await new Promise<void>(resolve => this.queue.push(resolve))
    }
    this.active += 1
    let timer: ReturnType<typeof setTimeout> | undefined; let deferredRelease = false
    const task = operation()
    const release = (): void => {
      this.active -= 1
      this.queue.shift()?.()
    }
    try {
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AppError(503, 'PDF rendering timed out', 'PDF_RENDER_TIMEOUT')), this.timeoutMs)
        })
      ])
    } catch (error) {
      if (error instanceof AppError && error.code === 'PDF_RENDER_TIMEOUT') {
        deferredRelease = true
        void task.finally(release).catch(() => undefined)
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (!deferredRelease) release()
    }
  }
}

function sha256(content: Buffer): string { return createHash('sha256').update(content).digest('hex') }

function assertSnapshot(value: unknown): FormSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(500, 'Stored PDF snapshot is invalid', 'PDF_SNAPSHOT_INVALID')
  const snapshot = value as Partial<FormSnapshot>
  if (snapshot.schemaVersion !== 1 || !['RECEIVED','DRAFT','FINAL'].includes(String(snapshot.kind))
    || !snapshot.request || !Array.isArray(snapshot.candidates) || !Array.isArray(snapshot.signoffs)
    || !Array.isArray(snapshot.approvals)) {
    throw new AppError(500, 'Stored PDF snapshot is invalid', 'PDF_SNAPSHOT_INVALID')
  }
  return snapshot as FormSnapshot
}

export class PdfService {
  private readonly storageRoot: string
  private readonly limiter: RenderLimiter
  private readonly signatures: SignatureService
  private readonly inFlight = new Map<string, Promise<Buffer>>()

  constructor(private readonly pool: Pool, private readonly config: AppConfig) {
    this.storageRoot = resolve(config.pdf.storageDirectory)
    this.limiter = new RenderLimiter(config.pdf.maxConcurrentRenders, config.pdf.maxQueuedRenders, config.pdf.renderTimeoutMs)
    this.signatures = new SignatureService(pool, config)
  }

  async documents(requestValue: unknown, actor: AuthContext): Promise<Record<string, unknown>> {
    const requestId = uuid(requestValue, 'requestId')
    await this.assertRequestAccess(requestId, actor)
    const received = await this.pool.query<Record<string, unknown>>(
      `SELECT s.id AS "snapshotId",s.stageTask_id AS "taskId",t.stagecode AS "stageCode",
              i.iterationno AS "iterationNo",s.receivedat AS "receivedAt",s.snapshotsha256 AS "snapshotSha256"
         FROM egas_stagereceivedsnapshot s
         JOIN egas_stagetask t ON t.id=s.stagetask_id
         JOIN egas_workflowiteration i ON i.id=s.iteration_id
        WHERE s.request_id=$1 AND s.recipientuser_id=$2 AND s.recipientrolesnapshot=$3
        ORDER BY i.iterationno,t.openedat,s.id`, [requestId, actor.userId, actor.activeRole]
    )
    const request = await this.pool.query<{ status: string, createdById: string }>(
      `SELECT status,createdby_id AS "createdById" FROM egas_workflowrequest WHERE id=$1`, [requestId]
    )
    if (!request.rows[0]) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    return {
      received: received.rows.map(row => ({ ...row, receivedAt: new Date(String(row.receivedAt)).toISOString() })),
      finalAvailable: request.rows[0].status === 'COMPLETED'
        && actor.activeRole === 'EMPLOYEE_AFFAIRS' && request.rows[0].createdById === actor.userId
    }
  }

  async draft(requestValue: unknown, actor: AuthContext): Promise<PdfResult> {
    const requestId = uuid(requestValue, 'requestId')
    await this.assertRequestAccess(requestId, actor)
    const context = await this.pool.query<{ iterationId: string, requestNumber: string, routingUnitId: string | null }>(
      `SELECT i.id AS "iterationId",r.requestnumber AS "requestNumber",r.routingunit_id AS "routingUnitId"
         FROM egas_workflowrequest r JOIN egas_workflowiteration i ON i.request_id=r.id AND i.iterationno=r.currentiterationno
        WHERE r.id=$1`, [requestId]
    )
    if (!context.rows[0]) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    const snapshot = await buildFormSnapshot(this.pool, requestId, context.rows[0].iterationId, 'DRAFT', null)
    const buffer = await this.render(
      snapshot,
      PDF_TEMPLATE_VERSION
    )
    await this.log(actor, 'FORM', 'DRAFT', requestId, null, context.rows[0].routingUnitId, PDF_TEMPLATE_VERSION, buffer)
    return { buffer, filename: `EGAS-${context.rows[0].requestNumber}-draft.pdf`, state: 'DRAFT' }
  }

  async received(requestValue: unknown, snapshotValue: unknown, actor: AuthContext): Promise<PdfResult> {
    const requestId = uuid(requestValue, 'requestId'); const receivedSnapshotId = uuid(snapshotValue, 'snapshotId')
    const source = await this.pool.query<{ iterationId: string, snapshotJson: FormSnapshot, snapshotSha256: string, templateVersion: string, requestNumber: string }>(
      `SELECT s.iteration_id AS "iterationId",s.snapshotjson AS "snapshotJson",s.snapshotsha256 AS "snapshotSha256",
               s.templateversion AS "templateVersion",
               r.requestnumber AS "requestNumber"
          FROM egas_stagereceivedsnapshot s JOIN egas_workflowrequest r ON r.id=s.request_id
         WHERE s.id=$1 AND s.request_id=$2 AND s.recipientuser_id=$3 AND s.recipientrolesnapshot=$4`,
      [receivedSnapshotId, requestId, actor.userId, actor.activeRole]
    )
    if (!source.rows[0]) throw new AppError(404, 'Received-stage PDF not found', 'PDF_RECEIVED_NOT_FOUND')
    const snapshot = assertSnapshot(source.rows[0].snapshotJson)
    if (snapshotSha256(snapshot) !== source.rows[0].snapshotSha256) {
      throw new AppError(409, 'Received-stage snapshot checksum failed', 'PDF_SNAPSHOT_CHECKSUM_FAILED')
    }
    const documentId = await withTransaction(this.pool, async db => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`egas.pdf.received.${receivedSnapshotId}`])
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM egas_frozenpdfdocument WHERE stagereceivedsnapshot_id=$1 AND documentstate='RECEIVED'`, [receivedSnapshotId]
      )
      if (existing.rows[0]) return existing.rows[0].id
      const id = randomUUID()
      await db.query(
  `INSERT INTO egas_frozenpdfdocument
    (
      id,
      request_id,
      iteration_id,
      documentstate,
      stagereceivedsnapshot_id,
      snapshotjson,
      snapshotsha256,
      templateversion,
      frozenat
    )
   VALUES (
      $1,
      $2,
      $3,
      'RECEIVED',
      $4,
      $5::jsonb,
      $6,
      $7,
      CURRENT_TIMESTAMP
   )`,
  [
    id,
    requestId,
    source.rows[0]!.iterationId,
    receivedSnapshotId,
    JSON.stringify(snapshot),
    source.rows[0]!.snapshotSha256,
    source.rows[0]!.templateVersion
  ]
)
      return id
    })
    const result = await this.serveFrozen(documentId, actor)
    return { ...result, filename: `EGAS-${source.rows[0].requestNumber}-received.pdf`, state: 'RECEIVED' }
  }

  async final(requestValue: unknown, actor: AuthContext): Promise<PdfResult> {
    const requestId = uuid(requestValue, 'requestId')
    const document = await this.pool.query<{ id: string, requestNumber: string }>(
      `SELECT d.id,r.requestnumber AS "requestNumber" FROM egas_frozenpdfdocument d
       JOIN egas_workflowrequest r ON r.id=d.request_id
       WHERE d.request_id=$1 AND d.documentstate='FINAL' AND r.status='COMPLETED'
         AND r.createdby_id=$2 AND $3='EMPLOYEE_AFFAIRS'`, [requestId, actor.userId, actor.activeRole]
    )
    if (!document.rows[0]) throw new AppError(404, 'Final PDF not found', 'PDF_FINAL_NOT_FOUND')
    const result = await this.serveFrozen(document.rows[0].id, actor)
    return { ...result, filename: `EGAS-${document.rows[0].requestNumber}-final.pdf`, state: 'FINAL' }
  }

  async requestAudit(requestValue: unknown, actor: AuthContext): Promise<PdfResult> {
    const requestId = uuid(requestValue, 'requestId')
    const request = await this.pool.query<{ requestNumber: string, currentStage: string, routingUnitId: string | null }>(
      `SELECT requestnumber AS "requestNumber",currentstage AS "currentStage",routingunit_id AS "routingUnitId"
         FROM egas_workflowrequest WHERE id=$1 AND createdby_id=$2 AND $3='EMPLOYEE_AFFAIRS'`,
      [requestId, actor.userId, actor.activeRole]
    )
    if (!request.rows[0]) throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
    const entries = await this.auditEntries(this.pool, requestId)
    const buffer = await this.limiter.run(() => renderAuditPdf(
      `سجل تدقيق الطلب ${request.rows[0]!.requestNumber}`, request.rows[0]!.currentStage, entries, this.config.pdf.maxOutputBytes
    ))
    await this.log(
      actor,
      'AUDIT_LOG',
      'DRAFT',
      requestId,
      null,
      request.rows[0].routingUnitId,
      PDF_TEMPLATE_VERSION,
      buffer
    )
    return { buffer, filename: `EGAS-${request.rows[0].requestNumber}-audit.pdf`, state: 'AUDIT_LOG' }
  }

  async adminAudit(input: AdminAuditPdfInput, actor: AuthContext): Promise<PdfResult> {
    if (actor.activeRole !== 'ADMIN') throw new AppError(403, 'Active ADMIN role required', 'ACTIVE_ROLE_REQUIRED')
    const requestId = input.requestId === undefined || input.requestId === '' ? null : uuid(input.requestId, 'requestId')
    const routingUnitId = input.routingUnitId === undefined || input.routingUnitId === '' ? null : uuid(input.routingUnitId, 'routingUnitId')
    const periodCodes = ['DAILY','WEEKLY','MONTHLY','QUARTERLY','HALF_YEARLY','YEARLY']
    const periodCode = typeof input.periodCode === 'string' && periodCodes.includes(input.periodCode) ? input.periodCode : null
    const periodStart = this.reportDate(input.periodStart, 'periodStart')
    const periodEnd = this.reportDate(input.periodEnd, 'periodEnd')
    if (!requestId && (!routingUnitId || !periodCode || !periodStart || !periodEnd)) {
      throw new AppError(400, 'Department reports require routingUnitId, periodCode, periodStart, and periodEnd', 'PDF_AUDIT_SCOPE_REQUIRED')
    }
    if (periodStart && periodEnd) {
      const start = new Date(`${periodStart}T00:00:00.000Z`); const end = new Date(`${periodEnd}T00:00:00.000Z`)
      const days = (end.getTime() - start.getTime()) / 86_400_000
      if (days < 0 || days > 366) throw new AppError(400, 'Audit report period must be 0-366 days', 'PDF_AUDIT_PERIOD_INVALID')
    }
    const result = await this.pool.query<AuditPdfEntry>(
      `SELECT r.requestnumber AS "requestNumber",c.employeenamesnapshot AS "candidateName",
              a.actornamesnapshot AS "actorName",u.username AS "actorUsername",a.actorrolesnapshot AS "actorRole",
              a.actioncode AS "actionCode",a.fromstage AS "fromStage",a.tostage AS "toStage",a.reason,
              a.createdat AS "createdAt"
         FROM egas_auditevent a JOIN egas_workflowrequest r ON r.id=a.request_id
         LEFT JOIN egas_requestcandidate c ON c.id=a.requestcandidate_id
         LEFT JOIN egas_useraccount u ON u.id=a.actoruser_id
        WHERE ($1::varchar IS NULL OR a.request_id=$1)
          AND ($2::varchar IS NULL OR a.routingunit_id=$2)
          AND ($3::date IS NULL OR a.createdat >= $3::date)
          AND ($4::date IS NULL OR a.createdat < ($4::date + INTERVAL '1 day'))
        ORDER BY a.createdat,a.id LIMIT 5001`, [requestId, routingUnitId, periodStart, periodEnd]
    )
    if (result.rows.length > 5_000) throw new AppError(413, 'Audit report exceeds 5,000 events; narrow the period', 'PDF_AUDIT_TOO_LARGE')
    const entries = result.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }))
    const title = requestId ? 'سجل تدقيق طلب' : 'سجل تدقيق وحدة مسار'
    const buffer = await this.limiter.run(() => renderAuditPdf(title, requestId ? 'طلب واحد' : `${periodCode}: ${periodStart} — ${periodEnd}`,
      entries, this.config.pdf.maxOutputBytes))
    await this.pool.query(
      `INSERT INTO egas_pdfgenerationlog
        (id,generatedby_id,documenttype,documentstate,request_id,routingunit_id,periodcode,
         periodstart,periodend,templateversion,filesha256,generatedat)
       VALUES ($1,$2,'AUDIT_LOG','DRAFT',$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)`,
      [randomUUID(), actor.userId, requestId, routingUnitId, periodCode, periodStart, periodEnd,
        PDF_TEMPLATE_VERSION, sha256(buffer)]
    )
    return { buffer, filename: requestId ? `EGAS-${requestId}-audit.pdf` : `EGAS-routing-audit.pdf`, state: 'AUDIT_LOG' }
  }

  private async auditEntries(db: Queryable, requestId: string): Promise<AuditPdfEntry[]> {
    const result = await db.query<AuditPdfEntry>(
      `SELECT r.requestnumber AS "requestNumber",c.employeenamesnapshot AS "candidateName",
              a.actornamesnapshot AS "actorName",u.username AS "actorUsername",a.actorrolesnapshot AS "actorRole",
              a.actioncode AS "actionCode",a.fromstage AS "fromStage",a.tostage AS "toStage",a.reason,
              a.createdat AS "createdAt"
         FROM egas_auditevent a JOIN egas_workflowrequest r ON r.id=a.request_id
         LEFT JOIN egas_requestcandidate c ON c.id=a.requestcandidate_id
         LEFT JOIN egas_useraccount u ON u.id=a.actoruser_id
        WHERE a.request_id=$1 ORDER BY a.createdat,a.id`, [requestId]
    )
    return result.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }))
  }

  private async assertRequestAccess(requestId: string, actor: AuthContext): Promise<void> {
    if (actor.activeRole === 'EMPLOYEE_AFFAIRS') {
      const owned = await this.pool.query(`SELECT 1 FROM egas_workflowrequest WHERE id=$1 AND createdby_id=$2`, [requestId, actor.userId])
      if (owned.rows[0]) return
    } else {
      const stages = actor.activeRole === 'ORGANIZATION' ? ['P2','P4O','S2','S4']
        : actor.activeRole === 'APPROVING_AUTHORITY' ? ['P4','S3'] : []
      if (stages.length) {
        const participated = await this.pool.query(
          `SELECT 1 FROM egas_stagetask WHERE request_id=$1 AND assigneduser_id=$2 AND stagecode=ANY($3::varchar[]) LIMIT 1`,
          [requestId, actor.userId, stages]
        )
        if (participated.rows[0]) return
      }
    }
    throw new AppError(404, 'Workflow request not found', 'WORKFLOW_REQUEST_NOT_FOUND')
  }

  private async serveFrozen(documentId: string, actor: AuthContext): Promise<{ buffer: Buffer }> {
    let promise = this.inFlight.get(documentId)
    if (!promise) {
      promise = this.ensureMaterialized(documentId)
      this.inFlight.set(documentId, promise)
      void promise.finally(() => this.inFlight.delete(documentId)).catch(() => undefined)
    }
    const buffer = await promise
    const row = await this.document(documentId)
    await this.log(actor, 'FORM', row.documentState, row.requestId, row.receivedSnapshotId, row.routingUnitId, row.templateVersion, buffer)
    return { buffer }
  }

  private async ensureMaterialized(documentId: string): Promise<Buffer> {
    return await withTransaction(this.pool, async db => {
      await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`egas.pdf.document.${documentId}`])
      const row = await this.document(documentId, db, true)
      const snapshot = assertSnapshot(row.snapshotJson)
      if (snapshotSha256(snapshot) !== row.snapshotSha256) throw new AppError(409, 'Frozen PDF snapshot checksum failed', 'PDF_SNAPSHOT_CHECKSUM_FAILED')
      if (row.storageKey) {
        const content = await readFile(this.controlledPath(row.storageKey))
        if (sha256(content) !== row.fileSha256) throw new AppError(409, 'Frozen PDF file checksum failed', 'PDF_FILE_CHECKSUM_FAILED')
        return content
      }
      const content = await this.render(snapshot, row.templateVersion)
      const storageKey = `${randomUUID()}.pdf`; const target = this.controlledPath(storageKey)
      await mkdir(this.storageRoot, { recursive: true, mode: 0o700 })
      await writeFile(target, content, { flag: 'wx', mode: 0o600 })
      try {
        const updated = await db.query(
          `UPDATE egas_frozenpdfdocument SET storagekey=$2,filesha256=$3,filesizebytes=$4,materializedat=CURRENT_TIMESTAMP
            WHERE id=$1 RETURNING id`, [documentId, storageKey, sha256(content), content.length]
        )
        if (!updated.rows[0]) throw new AppError(409, 'PDF evidence changed concurrently', 'PDF_MATERIALIZATION_CONFLICT')
      } catch (error) {
        await unlink(target).catch(() => undefined)
        throw error
      }
      return content
    })
  }

  private async render(
    snapshot: FormSnapshot,
    templateVersion: string
  ): Promise<Buffer> {
    /*
     * V2 is intentionally NOT enabled yet.
     *
     * Once the V2 renderer exists, this becomes the
     * V1/V2 dispatcher.
     */
    const images = new Map<string, Buffer>()

    for (const signoff of snapshot.signoffs) {
      const assetId = String(signoff.signatureAssetId ?? '')
      const hash = String(signoff.signatureSha256 ?? '')
      if (assetId && hash && !images.has(assetId)) images.set(assetId, await this.signatures.verifiedEvidenceContent(assetId, hash))
    }

    if (templateVersion === PDF_TEMPLATE_V1) {
      return await this.limiter.run(
        () =>
          renderOfficialPdfV1(
            snapshot,
            images,
            this.config.pdf.maxOutputBytes
          )
      )
    }

    if (templateVersion === PDF_TEMPLATE_V2) {
      return await this.limiter.run(
        () =>
          renderOfficialPdfV2(
            snapshot,
            images,
            this.config.pdf.maxOutputBytes
          )
      )
    }

    throw new AppError(
      500,
      `Unsupported PDF template version: ${templateVersion}`,
      'PDF_TEMPLATE_UNSUPPORTED'
    )
  }

  private async document(id: string, db: Queryable = this.pool, lock = false): Promise<FrozenDocumentRow> {
    const result = await db.query<FrozenDocumentRow>(
      `SELECT d.id,d.request_id AS "requestId",d.iteration_id AS "iterationId",d.documentstate AS "documentState",
              d.stagereceivedsnapshot_id AS "receivedSnapshotId",d.snapshotjson AS "snapshotJson",
              d.snapshotsha256 AS "snapshotSha256",d.templateversion AS "templateVersion",d.storagekey AS "storageKey",d.filesha256 AS "fileSha256",
              d.filesizebytes AS "fileSizeBytes",r.routingunit_id AS "routingUnitId",r.requestnumber AS "requestNumber"
          FROM egas_frozenpdfdocument d JOIN egas_workflowrequest r ON r.id=d.request_id WHERE d.id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id]
    )
    if (!result.rows[0]) throw new AppError(404, 'PDF evidence not found', 'PDF_NOT_FOUND')
    return result.rows[0]
  }

  private async log(
    actor: AuthContext,
    documentType: 'FORM'|'AUDIT_LOG',
    documentState: 'RECEIVED'|'DRAFT'|'FINAL',
    requestId: string,
    receivedSnapshotId: string | null,
    routingUnitId: string | null,
    templateVersion: string,
    content: Buffer
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO egas_pdfgenerationlog
        (id,generatedby_id,documenttype,documentstate,request_id,stagereceivedsnapshot_id,
         routingunit_id,templateversion,filesha256,generatedat)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_TIMESTAMP)`,
      [randomUUID(), actor.userId, documentType, documentState, requestId, receivedSnapshotId,
        routingUnitId, templateVersion, sha256(content)]
    )
  }

  private controlledPath(storageKey: string): string {
    if (basename(storageKey) !== storageKey || !/^[0-9a-f]{8}-[0-9a-f-]{27}\.pdf$/i.test(storageKey)) {
      throw new AppError(500, 'Stored PDF identity is invalid', 'PDF_STORAGE_INVALID')
    }
    const target = resolve(join(this.storageRoot, storageKey))
    if (!target.startsWith(`${this.storageRoot}${sep}`)) throw new AppError(500, 'Stored PDF identity is invalid', 'PDF_STORAGE_INVALID')
    return target
  }

  private reportDate(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, `${field} must be YYYY-MM-DD`)
    const date = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError(400, `${field} is invalid`)
    return value
  }
}
