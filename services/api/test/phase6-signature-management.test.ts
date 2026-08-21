import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeSignature } from '../src/modules/signatures/signature-service.ts'
import { createPhase6Fixture, type Phase6Fixture, sha256 } from './helpers/phase6-fixture.ts'

let fx: Phase6Fixture
beforeEach(async () => { fx = await createPhase6Fixture() })
afterEach(async () => { await fx.cleanup() })

describe('Phase 6 signature asset management', () => {
  it('stores a valid PNG as a private, canonical, UUID-keyed PNG asset', async () => {
    const view = await fx.upload(fx.users.hrManager)
    const row = await fx.pool.query<{ storage_key: string, mime_type: string, byte_size: number, sha256: string }>('SELECT storage_key,mime_type,byte_size,sha256 FROM user_signature_asset WHERE id=$1', [view.id])
    const bytes = await readFile(join(fx.config.signatures.storageDirectory, row.rows[0]!.storage_key))
    expect(row.rows[0]).toMatchObject({ mime_type: 'image/png', byte_size: bytes.length, sha256: sha256(bytes) })
    expect(row.rows[0]!.storage_key).toMatch(/^[0-9a-f-]{36}\.png$/i)
    expect(view).not.toHaveProperty('storageKey')
    expect(view).not.toHaveProperty('path')
  })

  it('canonicalizes a valid JPEG to PNG and persists its canonical metadata', async () => {
    const view = await fx.upload(fx.users.hrManager, 'jpeg')
    const bytes = await fx.assets.getSignatureAssetBytes(String(view.id), fx.users.hrManager.userId)
    expect(bytes.mimeType).toBe('image/png')
    expect(bytes.buffer.subarray(1, 4).toString()).toBe('PNG')
    expect(view.byteSize).toBe(bytes.buffer.length)
    expect(view.sha256).toBe(sha256(bytes.buffer))
  })

  it('fails closed for unsupported MIME, malformed bytes, source size, width, height, pixels, and oversized canonical output', async () => {
    await expect(canonicalizeSignature(Buffer.from('x'), 'text/plain', fx.config.signatures)).rejects.toMatchObject({ code: 'SIGNATURE_MEDIA_TYPE_INVALID' })
    await expect(canonicalizeSignature(Buffer.from('not an image'), 'image/png', fx.config.signatures)).rejects.toMatchObject({ code: 'SIGNATURE_IMAGE_MALFORMED' })
    await expect(canonicalizeSignature(Buffer.alloc(fx.config.signatures.maxUploadBytes + 1), 'image/png', fx.config.signatures)).rejects.toMatchObject({ code: 'SIGNATURE_FILE_SIZE_INVALID' })
    await expect(canonicalizeSignature(await fx.image('png', 101, 10), 'image/png', fx.config.signatures)).rejects.toMatchObject({ code: 'SIGNATURE_DIMENSIONS_INVALID' })
    await expect(canonicalizeSignature(await fx.image('png', 10, 101), 'image/png', fx.config.signatures)).rejects.toMatchObject({ code: 'SIGNATURE_DIMENSIONS_INVALID' })
    await expect(canonicalizeSignature(await fx.image('png', 100, 100), 'image/png', { ...fx.config.signatures, maxPixels: 9999 })).rejects.toMatchObject({ code: expect.stringMatching(/SIGNATURE/) })
    await expect(canonicalizeSignature(await fx.image(), 'image/png', { ...fx.config.signatures, maxUploadBytes: 10 })).rejects.toMatchObject({ code: expect.stringMatching(/SIGNATURE/) })
  })

  it('lists only the owner’s versions and supports idempotent deactivation without deleting the private file', async () => {
    const first = await fx.upload(fx.users.hrManager)
    const second = await fx.upload(fx.users.hrManager, 'jpeg')
    const foreign = await fx.upload(fx.users.orgManager)
    const own = (await fx.assets.listMySignatures(fx.users.hrManager.userId)).map(x => x.id)
    expect(own).toEqual(expect.arrayContaining([String(first.id), String(second.id)]))
    expect(own).not.toContain(String(foreign.id))
    const row = await fx.pool.query<{ storage_key: string }>('SELECT storage_key FROM user_signature_asset WHERE id=$1', [first.id])
    await expect(fx.assets.deactivateSignature(fx.users.hrManager.userId, String(first.id))).resolves.toMatchObject({ isActive: false })
    await expect(readFile(join(fx.config.signatures.storageDirectory, row.rows[0]!.storage_key))).resolves.toBeInstanceOf(Buffer)
    await expect(fx.assets.deactivateSignature(fx.users.hrManager.userId, String(first.id))).resolves.toMatchObject({ isActive: false })
  })

  it('allows the owner but denies arbitrary foreign reads with an IDOR-safe result', async () => {
    const asset = await fx.upload(fx.users.hrManager)
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.hrManager.userId)).resolves.toMatchObject({ mimeType: 'image/png' })
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId)).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_NOT_FOUND', status: 404 })
  })

  it('does not make inactive assets available for a new sign, while preserving their historical bytes', async () => {
    const asset = await fx.upload(fx.users.hrManager)
    const request = await fx.createRequest('PROMOTION')
    await fx.assets.deactivateSignature(fx.users.hrManager.userId, String(asset.id))
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_INVALID' })
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.hrManager.userId)).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('continues to serve an inactive asset as checksum-verified historical signoff evidence', async () => {
    const asset = await fx.upload(fx.users.hrManager)
    const request = await fx.createRequest('PROMOTION')
    await fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))
    await fx.assets.deactivateSignature(fx.users.hrManager.userId, String(asset.id))
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId, request.requestId)).resolves.toMatchObject({
      buffer: expect.any(Buffer), mimeType: 'image/png'
    })
  })

  it('permits cross-user historical access only through a signoff on the exact readable request', async () => {
    const asset = await fx.upload(fx.users.hrManager)
    const request = await fx.createRequest('PROMOTION')
    await fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId, request.requestId)).resolves.toMatchObject({ mimeType: 'image/png' })
    const unrelated = await fx.createRequest('PROMOTION')
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId, unrelated.requestId)).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_NOT_FOUND' })
  })

  it('verifies historical image bytes against the frozen workflow signoff hash and fails closed on corruption', async () => {
    const asset = await fx.upload(fx.users.hrManager)
    const request = await fx.createRequest('PROMOTION')
    await fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))
    const signoff = await fx.pool.query<{ signature_sha256: string }>('SELECT signature_sha256 FROM workflow_signoff WHERE stage_execution_id=$1', [request.stageExecutionId])
    const row = await fx.pool.query<{ storage_key: string }>('SELECT storage_key FROM user_signature_asset WHERE id=$1', [asset.id])
    expect(sha256((await fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId, request.requestId)).buffer)).toBe(signoff.rows[0]!.signature_sha256)
    await writeFile(join(fx.config.signatures.storageDirectory, row.rows[0]!.storage_key), Buffer.from('corrupt'))
    await expect(fx.assets.getSignatureAssetBytes(String(asset.id), fx.users.orgManager.userId, request.requestId)).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_INTEGRITY_MISMATCH' })
  })

  it('keeps storage metadata private when listing more than one active version', async () => {
    await fx.upload(fx.users.hrManager); await fx.upload(fx.users.hrManager, 'jpeg')
    const list = await fx.assets.listMySignatures(fx.users.hrManager.userId)
    expect(list).toHaveLength(2)
    for (const version of list) {
      expect(version).not.toHaveProperty('storageKey')
      expect(JSON.stringify(version)).not.toContain(fx.config.signatures.storageDirectory)
    }
  })

  it('does not create a database row or storage file when validation rejects the upload', async () => {
    await expect(fx.assets.uploadSignature(fx.users.hrManager.userId, Buffer.from('not an image'), 'image/png')).rejects.toMatchObject({ code: 'SIGNATURE_IMAGE_MALFORMED' })
    await expect(fx.pool.query('SELECT id FROM user_signature_asset')).resolves.toMatchObject({ rowCount: 0 })
  })
})
