import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import sharp from 'sharp'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { optionalText, uuid } from '../../shared/validation.ts'
import { recordSecurityEvent } from '../audit/security-events.ts'
import { recordWorkflowAudit } from '../audit/workflow-audit.ts'
import {
  signaturePassword,
  type CurrentPasswordVerifier
} from '../auth/current-password-verifier.ts'
import type { AuthContext } from '../auth/types.ts'
import { responsibleRole, type WorkflowStage } from './types.ts'
import { WorkflowRepository } from './workflow-repository.ts'

type SignatureAssetRow = {
  id: string
  userId: string
  storageKey: string
  mimeType: string
  fileSizeBytes: string | number
  widthPx: number
  heightPx: number
  fileSha256: string
  uploadedAt: Date | string
}

type SignoffRow = {
  id: string
  stageCode: string
  signerUserId: string
  signerRole: string
  signerName: string
  signerJobTitle: string
  jobTitleWasOverridden: boolean
  signatureAssetId: string
  signatureSha256: string
  signedAt: Date | string
  iterationNo: number
}

const mandatoryStages = new Set<WorkflowStage>(['P1', 'P2', 'S1', 'S2'])
const signatureKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i

function iso(value: Date | string): string { return new Date(value).toISOString() }

function assetView(row: SignatureAssetRow): Record<string, unknown> {
  return {
    id: row.id,
    mimeType: row.mimeType,
    fileSizeBytes: Number(row.fileSizeBytes),
    widthPx: Number(row.widthPx),
    heightPx: Number(row.heightPx),
    fileSha256: row.fileSha256,
    uploadedAt: iso(row.uploadedAt)
  }
}

function signoffView(row: SignoffRow): Record<string, unknown> {
  return {
    id: row.id,
    stageCode: row.stageCode,
    iterationNo: Number(row.iterationNo),
    signerUserId: row.signerUserId,
    signerRole: row.signerRole,
    signerName: row.signerName,
    signerJobTitle: row.signerJobTitle,
    jobTitleWasOverridden: row.jobTitleWasOverridden,
    signatureAssetId: row.signatureAssetId,
    signatureSha256: row.signatureSha256,
    signedAt: iso(row.signedAt)
  }
}

export async function canonicalizeSignature(
  input: Buffer,
  declaredMimeType: string,
  limits: AppConfig['signatures']
): Promise<{ buffer: Buffer, width: number, height: number, sha256: string }> {
  if (!['image/png', 'image/jpeg'].includes(declaredMimeType)) {
    throw new AppError(415, 'Only PNG and JPEG signature images are accepted', 'SIGNATURE_MEDIA_TYPE_INVALID')
  }
  if (input.length === 0 || input.length > limits.maxUploadBytes) {
    throw new AppError(413, 'Signature image exceeds the permitted size', 'SIGNATURE_FILE_SIZE_INVALID')
  }
  try {
    const pipeline = sharp(input, { failOn: 'error', limitInputPixels: limits.maxPixels, sequentialRead: true })
    const metadata = await pipeline.metadata()
    const expectedFormat = declaredMimeType === 'image/png' ? 'png' : 'jpeg'
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new AppError(400, 'Signature image content does not match its declared type', 'SIGNATURE_IMAGE_INVALID')
    }
    if (metadata.width > limits.maxWidthPixels || metadata.height > limits.maxHeightPixels
      || metadata.width * metadata.height > limits.maxPixels) {
      throw new AppError(400, 'Signature image dimensions exceed the permitted limits', 'SIGNATURE_DIMENSIONS_INVALID')
    }
    const canonical = await pipeline.rotate().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true })
    if (canonical.info.width > limits.maxWidthPixels || canonical.info.height > limits.maxHeightPixels
      || canonical.data.length > limits.maxUploadBytes) {
      throw new AppError(400, 'Canonical signature image exceeds the permitted limits', 'SIGNATURE_CANONICAL_SIZE_INVALID')
    }
    return {
      buffer: canonical.data,
      width: canonical.info.width,
      height: canonical.info.height,
      sha256: createHash('sha256').update(canonical.data).digest('hex')
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'Signature image could not be decoded safely', 'SIGNATURE_IMAGE_INVALID')
  }
}

export class SignatureService {
  private readonly storageRoot: string

  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly currentPasswordVerifier?: CurrentPasswordVerifier
  ) {
    this.storageRoot = resolve(config.signatures.storageDirectory)
  }

  private async assetRow(assetId: string): Promise<SignatureAssetRow | undefined> {
    const result = await this.pool.query<SignatureAssetRow>(
      `SELECT id,user_id AS "userId",storagekey AS "storageKey",mimetype AS "mimeType",
              filesizebytes AS "fileSizeBytes",widthpx AS "widthPx",heightpx AS "heightPx",
              filesha256 AS "fileSha256",uploadedat AS "uploadedAt"
         FROM egas_usersignatureasset WHERE id=$1 AND isactive=TRUE`, [assetId]
    )
    return result.rows[0]
  }

  async upload(input: Buffer, declaredMimeType: string, actor: AuthContext, evidence: RequestEvidence): Promise<Record<string, unknown>> {
    const canonical = await canonicalizeSignature(input, declaredMimeType, this.config.signatures)
    const duplicate = await this.pool.query<SignatureAssetRow>(
      `SELECT id,user_id AS "userId",storagekey AS "storageKey",mimetype AS "mimeType",
              filesizebytes AS "fileSizeBytes",widthpx AS "widthPx",heightpx AS "heightPx",
              filesha256 AS "fileSha256",uploadedat AS "uploadedAt"
         FROM egas_usersignatureasset WHERE filesha256=$1 LIMIT 1`, [canonical.sha256]
    )
    if (duplicate.rows[0]) {
      if (duplicate.rows[0].userId === actor.userId) return assetView(duplicate.rows[0])
      throw new AppError(409, 'This signature image is already registered', 'SIGNATURE_ASSET_DUPLICATE')
    }

    const id = randomUUID()
    const storageKey = `${randomUUID()}.png`
    const target = this.controlledPath(storageKey)
    await mkdir(this.storageRoot, { recursive: true, mode: 0o700 })
    await writeFile(target, canonical.buffer, { flag: 'wx', mode: 0o600 })
    try {
      await this.pool.query(
        `INSERT INTO egas_usersignatureasset
          (id,user_id,storagekey,mimetype,filesizebytes,widthpx,heightpx,filesha256,isactive,uploadedat,uploadedfromip)
         VALUES ($1,$2,$3,'image/png',$4,$5,$6,$7,TRUE,CURRENT_TIMESTAMP,$8)`,
        [id, actor.userId, storageKey, canonical.buffer.length, canonical.width, canonical.height, canonical.sha256, evidence.ipAddress]
      )
    } catch (error) {
      await unlink(target).catch(() => undefined)
      if (isUniqueViolation(error)) throw new AppError(409, 'This signature image is already registered', 'SIGNATURE_ASSET_DUPLICATE')
      throw error
    }
    return assetView((await this.assetRow(id))!)
  }

  async ownAssets(actor: AuthContext): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query<SignatureAssetRow>(
      `SELECT id,user_id AS "userId",storagekey AS "storageKey",mimetype AS "mimeType",
              filesizebytes AS "fileSizeBytes",widthpx AS "widthPx",heightpx AS "heightPx",
              filesha256 AS "fileSha256",uploadedat AS "uploadedAt"
         FROM egas_usersignatureasset WHERE user_id=$1 AND isactive=TRUE
        ORDER BY uploadedat DESC,id DESC LIMIT 20`, [actor.userId]
    )
    return result.rows.map(assetView)
  }

  async content(assetValue: unknown, actor: AuthContext, canAccessRequest: (requestId: string) => Promise<boolean>): Promise<Buffer> {
    const assetId = uuid(assetValue, 'signatureAssetId')
    const asset = await this.assetRow(assetId)
    if (!asset) throw new AppError(404, 'Signature asset not found', 'SIGNATURE_ASSET_NOT_FOUND')
    let authorized = asset.userId === actor.userId
    if (!authorized) {
      const requests = await this.pool.query<{ requestId: string }>(
        `SELECT DISTINCT request_id AS "requestId" FROM egas_workflowsignoff WHERE signatureasset_id=$1`, [assetId]
      )
      for (const request of requests.rows) {
        if (await canAccessRequest(request.requestId)) { authorized = true; break }
      }
    }
    if (!authorized) throw new AppError(404, 'Signature asset not found', 'SIGNATURE_ASSET_NOT_FOUND')
    return await readFile(this.controlledPath(asset.storageKey))
  }

  async verifiedEvidenceContent(assetValue: unknown, expectedSha256: string): Promise<Buffer> {
    const assetId = uuid(assetValue, 'signatureAssetId')
    const result = await this.pool.query<SignatureAssetRow>(
      `SELECT id,user_id AS "userId",storagekey AS "storageKey",mimetype AS "mimeType",
              filesizebytes AS "fileSizeBytes",widthpx AS "widthPx",heightpx AS "heightPx",
              filesha256 AS "fileSha256",uploadedat AS "uploadedAt"
         FROM egas_usersignatureasset WHERE id=$1`, [assetId]
    )
    const asset = result.rows[0]
    if (!asset || !/^[0-9a-f]{64}$/.test(expectedSha256) || asset.fileSha256 !== expectedSha256) {
      throw new AppError(409, 'Historical signature evidence is inconsistent', 'SIGNATURE_EVIDENCE_INVALID')
    }
    const content = await readFile(this.controlledPath(asset.storageKey))
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== expectedSha256) {
      throw new AppError(409, 'Historical signature evidence checksum failed', 'SIGNATURE_EVIDENCE_INVALID')
    }
    return content
  }

 async sign(
  requestValue: unknown,
  assetValue: unknown,
  jobTitleValue: unknown,
  passwordValue: unknown,
  actor: AuthContext,
  evidence: RequestEvidence
): Promise<Record<string, unknown>> {
  const currentPasswordVerifier =
    this.currentPasswordVerifier

  if (!currentPasswordVerifier) {
    throw new AppError(
      500,
      'Signature reauthentication is unavailable',
      'SIGNATURE_REAUTHENTICATION_UNAVAILABLE'
    )
  }

  const requestId = uuid(requestValue, 'requestId')
  const assetId = uuid(assetValue, 'signatureAssetId')
  const jobTitleOverride = optionalText(
    jobTitleValue,
    'jobTitle',
    500
  )
  const password = signaturePassword(passwordValue)

  const outcome = await withTransaction(
    this.pool,
    async db => {
      const repo = new WorkflowRepository(db)

      const request = await repo.request(requestId, true)

      if (!request) {
        throw new AppError(
          404,
          'Workflow request not found',
          'WORKFLOW_REQUEST_NOT_FOUND'
        )
      }

      const stage = request.currentStage

      if (
        !mandatoryStages.has(stage)
        || responsibleRole(stage) !== actor.activeRole
      ) {
        throw new AppError(
          409,
          'A signoff is not accepted at the current stage',
          'WORKFLOW_SIGNOFF_STAGE_INVALID'
        )
      }

      const task = await repo.currentTask(request)

      if (
        !task
        || task.assignedUserId !== actor.userId
        || !['OPEN', 'CLAIMED'].includes(task.taskStatus)
      ) {
        throw new AppError(
          404,
          'Workflow request not found',
          'WORKFLOW_REQUEST_NOT_FOUND'
        )
      }

      const asset = await db.query<SignatureAssetRow>(
        `SELECT id,
                user_id AS "userId",
                storagekey AS "storageKey",
                mimetype AS "mimeType",
                filesizebytes AS "fileSizeBytes",
                widthpx AS "widthPx",
                heightpx AS "heightPx",
                filesha256 AS "fileSha256",
                uploadedat AS "uploadedAt"
           FROM egas_usersignatureasset
          WHERE id = $1
            AND user_id = $2
            AND isactive = TRUE`,
        [assetId, actor.userId]
      )

      if (!asset.rows[0]) {
        throw new AppError(
          404,
          'Signature asset not found',
          'SIGNATURE_ASSET_NOT_FOUND'
        )
      }

      const identity = await db.query<{
        displayName: string
        jobTitle: string | null
      }>(
        `SELECT displayname AS "displayName",
                jobtitle AS "jobTitle"
           FROM egas_useraccount
          WHERE id = $1
            AND isactive = TRUE`,
        [actor.userId]
      )

      if (!identity.rows[0]) {
        throw new AppError(
          403,
          'Active account required',
          'ACCOUNT_INACTIVE'
        )
      }

      const storedJobTitle =
        identity.rows[0].jobTitle?.trim() ?? ''

      const signerJobTitle =
        jobTitleOverride ?? storedJobTitle

      if (!signerJobTitle) {
        throw new AppError(
          400,
          'A signer job title is required',
          'WORKFLOW_SIGNER_JOB_TITLE_REQUIRED'
        )
      }

      const existing = await db.query(
        `SELECT 1
           FROM egas_workflowsignoff
          WHERE request_id = $1
            AND iteration_id = $2
            AND stagecode = $3
          LIMIT 1`,
        [
          requestId,
          task.iterationId,
          stage
        ]
      )

      if (existing.rows[0]) {
        throw new AppError(
          409,
          'This stage already has an immutable signoff',
          'WORKFLOW_SIGNOFF_EXISTS'
        )
      }

      const passwordIsValid =
  await currentPasswordVerifier.verify(
    db,
    actor.userId,
    password
  )

      if (!passwordIsValid) {
        await recordSecurityEvent(db, {
          actorUserId: actor.userId,
          eventType: 'SIGNATURE_PASSWORD_REJECTED',
          ipAddress: evidence.ipAddress,
          correlationId: evidence.correlationId,
          routingUnitId: request.routingUnitId,
          details: {
            requestId,
            stage,
            reason: 'INVALID_PASSWORD'
          }
        })

        return {
          kind: 'PASSWORD_INVALID' as const
        }
      }

      const signoffId = randomUUID()

      try {
        await db.query(
          `INSERT INTO egas_workflowsignoff
            (
              id,
              request_id,
              iteration_id,
              stagetask_id,
              stagecode,
              signeruser_id,
              signerrolesnapshot,
              signernamesnapshot,
              signerjobtitlesnapshot,
              jobtitlewasoverridden,
              signatureasset_id,
              signaturesha256snapshot,
              signedat,
              createdat
            )
           VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
             CURRENT_TIMESTAMP,
             CURRENT_TIMESTAMP
           )`,
          [
            signoffId,
            requestId,
            task.iterationId,
            task.id,
            stage,
            actor.userId,
            actor.activeRole,
            identity.rows[0].displayName,
            signerJobTitle,
            signerJobTitle !== storedJobTitle,
            assetId,
            asset.rows[0].fileSha256
          ]
        )
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(
            409,
            'This stage already has an immutable signoff',
            'WORKFLOW_SIGNOFF_EXISTS'
          )
        }

        throw error
      }

      await repo.insertAction(
        actor,
        requestId,
        task.iterationId,
        task.id,
        null,
        'WORKFLOW_SIGNOFF_CAPTURED',
        { stage }
      )

      await recordWorkflowAudit(
        db,
        actor,
        evidence,
        {
          requestId,
          iterationId: task.iterationId,
          routingUnitId: request.routingUnitId,
          authorityAssignmentId: request.authorityAssignmentId,
          actionCode: 'WORKFLOW_SIGNOFF_CAPTURED',
          fromStage: stage,
          toStage: stage,
          metadata: {
            stage,
            signatureAssetId: assetId
          }
        }
      )

      return {
        kind: 'SIGNED' as const,
        signoffId
      }
    }
  )

  if (outcome.kind === 'PASSWORD_INVALID') {
    throw new AppError(
      401,
      'Signature password is incorrect',
      'SIGNATURE_PASSWORD_INVALID'
    )
  }

  const result = await this.pool.query<SignoffRow>(
    `SELECT s.id,
            s.stagecode AS "stageCode",
            s.signeruser_id AS "signerUserId",
            s.signerrolesnapshot AS "signerRole",
            s.signernamesnapshot AS "signerName",
            s.signerjobtitlesnapshot AS "signerJobTitle",
            s.jobtitlewasoverridden AS "jobTitleWasOverridden",
            s.signatureasset_id AS "signatureAssetId",
            s.signaturesha256snapshot AS "signatureSha256",
            s.signedat AS "signedAt",
            i.iterationno AS "iterationNo"
       FROM egas_workflowsignoff s
       JOIN egas_workflowiteration i
         ON i.id = s.iteration_id
      WHERE s.id = $1`,
    [outcome.signoffId]
  )

  return signoffView(result.rows[0]!)
}

  async signoffs(requestValue: unknown): Promise<Record<string, unknown>[]> {
    const requestId = uuid(requestValue, 'requestId')
    const result = await this.pool.query<SignoffRow>(
      `SELECT s.id,s.stagecode AS "stageCode",s.signeruser_id AS "signerUserId",
              s.signerrolesnapshot AS "signerRole",s.signernamesnapshot AS "signerName",
              s.signerjobtitlesnapshot AS "signerJobTitle",s.jobtitlewasoverridden AS "jobTitleWasOverridden",
              s.signatureasset_id AS "signatureAssetId",s.signaturesha256snapshot AS "signatureSha256",
              s.signedat AS "signedAt",i.iterationno AS "iterationNo"
         FROM egas_workflowsignoff s JOIN egas_workflowiteration i ON i.id=s.iteration_id
        WHERE s.request_id=$1 ORDER BY i.iterationno,s.signedat,s.id`, [requestId]
    )
    return result.rows.map(signoffView)
  }

  private controlledPath(storageKey: string): string {
    if (basename(storageKey) !== storageKey || !signatureKeyPattern.test(storageKey)) {
      throw new AppError(500, 'Stored signature identity is invalid', 'SIGNATURE_STORAGE_INVALID')
    }
    const target = resolve(join(this.storageRoot, storageKey))
    if (!target.startsWith(`${this.storageRoot}${sep}`)) {
      throw new AppError(500, 'Stored signature identity is invalid', 'SIGNATURE_STORAGE_INVALID')
    }
    return target
  }
}
