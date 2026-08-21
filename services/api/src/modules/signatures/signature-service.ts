import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { Pool } from 'pg'
import sharp from 'sharp'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import { AppError } from '../../shared/errors.ts'
import { recordAuditEvent } from '../audit/security-events.ts'
import type {
  SignatureAssetView,
  SignatureCanonicalResult,
  UserSignatureAsset
} from './types.ts'

const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i

export async function canonicalizeSignature(
  input: Buffer,
  declaredMimeType: string,
  limits: AppConfig['signatures']
): Promise<SignatureCanonicalResult> {
  const normalizedMime = declaredMimeType.toLowerCase().trim()
  if (!['image/png', 'image/jpeg', 'image/jpg'].includes(normalizedMime)) {
    throw new AppError(415, 'Only PNG and JPEG signature images are accepted', 'SIGNATURE_MEDIA_TYPE_INVALID')
  }

  if (input.length === 0 || input.length > limits.maxUploadBytes) {
    throw new AppError(413, 'Signature image exceeds permitted upload size', 'SIGNATURE_FILE_SIZE_INVALID')
  }

  try {
    const pipeline = sharp(input, {
      failOn: 'error',
      limitInputPixels: limits.maxPixels,
      sequentialRead: true
    })

    const metadata = await pipeline.metadata()
    const expectedFormat = normalizedMime === 'image/png' ? 'png' : 'jpeg'
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new AppError(400, 'Signature image content does not match its declared type', 'SIGNATURE_IMAGE_INVALID')
    }

    if (
      metadata.width > limits.maxWidthPixels
      || metadata.height > limits.maxHeightPixels
      || metadata.width * metadata.height > limits.maxPixels
    ) {
      throw new AppError(400, 'Signature image dimensions exceed permitted limits', 'SIGNATURE_DIMENSIONS_INVALID')
    }

    const canonicalBuffer = await pipeline
      .rotate()
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true
      })
      .toBuffer()

    if (canonicalBuffer.length > limits.maxUploadBytes) {
      throw new AppError(413, 'Canonical signature image exceeds permitted upload size', 'SIGNATURE_FILE_SIZE_INVALID')
    }
    const sha256 = createHash('sha256').update(canonicalBuffer).digest('hex')

    return {
      buffer: canonicalBuffer,
      width: metadata.width,
      height: metadata.height,
      sha256,
      byteSize: canonicalBuffer.length
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'Invalid or corrupt signature image file', 'SIGNATURE_IMAGE_MALFORMED')
  }
}

export class SignatureService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig
  ) {}

  private resolveStoragePath(storageKey: string): string {
    const cleanKey = basename(storageKey)
    if (!STORAGE_KEY_PATTERN.test(cleanKey)) {
      throw new AppError(400, 'Invalid signature storage key', 'SIGNATURE_STORAGE_KEY_INVALID')
    }
    const baseDir = resolve(this.config.signatures.storageDirectory)
    const filePath = resolve(join(baseDir, cleanKey))
    if (!filePath.startsWith(baseDir + sep) && filePath !== baseDir) {
      throw new AppError(400, 'Invalid signature path traversal', 'SIGNATURE_PATH_TRAVERSAL')
    }
    return filePath
  }

  async uploadSignature(
    userId: string,
    rawBytes: Buffer,
    declaredMimeType: string
  ): Promise<SignatureAssetView> {
    const canonical = await canonicalizeSignature(rawBytes, declaredMimeType, this.config.signatures)
    const storageKey = `${randomUUID()}.png`
    const storagePath = this.resolveStoragePath(storageKey)

    await mkdir(this.config.signatures.storageDirectory, { recursive: true, mode: 0o700 })
    await writeFile(storagePath, canonical.buffer, { flag: 'wx', mode: 0o600 })
    try {
      return await withTransaction(this.pool, async db => {
      const assetId = randomUUID()

      await db.query(
        `INSERT INTO user_signature_asset
          (id, user_id, storage_key, mime_type, byte_size, sha256, is_active, created_at)
         VALUES ($1, $2, $3, 'image/png', $4, $5, true, CURRENT_TIMESTAMP)`,
        [assetId, userId, storageKey, canonical.byteSize, canonical.sha256]
      )

      await recordAuditEvent(db, {
        actorUserId: userId,
        eventType: 'SIGNATURE_ASSET_UPLOADED',
        subjectType: 'user_signature_asset',
        subjectId: assetId,
        details: {
          sha256: canonical.sha256,
          byteSize: canonical.byteSize,
          mimeType: 'image/png'
        }
      })

      const result = await db.query<{
        id: string
        mime_type: string
        byte_size: number
        sha256: string
        is_active: boolean
        created_at: Date
      }>(
        `SELECT id, mime_type, byte_size, sha256, is_active, created_at
           FROM user_signature_asset
          WHERE id = $1`,
        [assetId]
      )

      const row = result.rows[0]!
      return {
        id: row.id,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        isActive: row.is_active,
        createdAt: new Date(row.created_at).toISOString()
      }
      })
    } catch (error) {
      // Only the just-created contender is cleaned up; historical assets are never removed.
      await unlink(storagePath).catch(() => undefined)
      throw error
    }
  }

  async listMySignatures(userId: string): Promise<SignatureAssetView[]> {
    const result = await this.pool.query<{
      id: string
      mime_type: string
      byte_size: number
      sha256: string
      is_active: boolean
      created_at: Date
    }>(
      `SELECT id, mime_type, byte_size, sha256, is_active, created_at
         FROM user_signature_asset
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    )

    return result.rows.map(row => ({
      id: row.id,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      isActive: row.is_active,
      createdAt: new Date(row.created_at).toISOString()
    }))
  }

  async deactivateSignature(
    userId: string,
    assetId: string
  ): Promise<SignatureAssetView> {
    return await withTransaction(this.pool, async db => {
      const existingResult = await db.query<{
        id: string
        user_id: string
        mime_type: string
        byte_size: number
        sha256: string
        is_active: boolean
        created_at: Date
      }>(
        `SELECT id, user_id, mime_type, byte_size, sha256, is_active, created_at
           FROM user_signature_asset
          WHERE id = $1 AND user_id = $2`,
        [assetId, userId]
      )

      const row = existingResult.rows[0]
      if (!row) {
        throw new AppError(404, 'Signature asset not found', 'SIGNATURE_ASSET_NOT_FOUND')
      }

      if (row.is_active) {
        await db.query(
          `UPDATE user_signature_asset
              SET is_active = false
            WHERE id = $1 AND user_id = $2`,
          [assetId, userId]
        )

        await recordAuditEvent(db, {
          actorUserId: userId,
          eventType: 'SIGNATURE_ASSET_DEACTIVATED',
          subjectType: 'user_signature_asset',
          subjectId: assetId,
          details: { sha256: row.sha256 }
        })
      }

      return {
        id: row.id,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        sha256: row.sha256,
        isActive: false,
        createdAt: new Date(row.created_at).toISOString()
      }
    })
  }

  async getSignatureAssetBytes(
    assetId: string,
    actorUserId: string,
    requestId?: string
  ): Promise<{ buffer: Buffer, mimeType: string }> {
    const result = await this.pool.query<{
      id: string
      user_id: string
      storage_key: string
      mime_type: string
      sha256: string
      is_active: boolean
    }>(
      `SELECT id, user_id, storage_key, mime_type, sha256, is_active
         FROM user_signature_asset
        WHERE id = $1`,
      [assetId]
    )

    const asset = result.rows[0]
    if (!asset) {
      throw new AppError(404, 'Signature asset not found', 'SIGNATURE_ASSET_NOT_FOUND')
    }

    // Authorization check: either the asset owner, or a reader of the exact request
    // whose immutable WorkflowSignoff references this asset.
    let authorized = asset.user_id === actorUserId
    let historicalSha256: string | null = null
    if (!authorized && requestId) {
      const signoffCheck = await this.pool.query<{ signatureSha256: string | null }>(
        `SELECT ws.signature_sha256 AS "signatureSha256"
           FROM workflow_signoff ws
           JOIN stage_execution se ON se.id = ws.stage_execution_id
           JOIN workflow_iteration wi ON wi.id = se.iteration_id
          WHERE wi.request_id = $1 AND ws.signature_asset_id = $2
          LIMIT 1`,
        [requestId, assetId]
      )
      if (signoffCheck.rows[0]) {
        authorized = true
        historicalSha256 = signoffCheck.rows[0].signatureSha256
      }
    }

    if (!authorized) {
      throw new AppError(404, 'Signature asset not found', 'SIGNATURE_ASSET_NOT_FOUND')
    }

    const filePath = this.resolveStoragePath(asset.storage_key)
    let buffer: Buffer
    try {
      buffer = await readFile(filePath)
    } catch {
      throw new AppError(404, 'Signature file missing from storage', 'SIGNATURE_FILE_NOT_FOUND')
    }

    const actualSha256 = createHash('sha256').update(buffer).digest('hex')
    const expectedSha256 = historicalSha256 ?? asset.sha256
    if (actualSha256 !== expectedSha256) {
      throw new AppError(500, 'Signature asset integrity checksum mismatch', 'SIGNATURE_ASSET_INTEGRITY_MISMATCH')
    }

    return { buffer, mimeType: asset.mime_type }
  }
}
