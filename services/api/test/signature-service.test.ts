import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config/env.ts'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import { canonicalizeSignature, SignatureService } from '../src/modules/workflow/signature-service.ts'
import { WorkflowService } from '../src/modules/workflow/workflow-service.ts'
import { isolatedPool, testConfig } from './helpers/database.ts'
import {
  DatabaseCurrentPasswordVerifier
} from '../src/modules/auth/current-password-verifier.ts'

import {
  LocalAuthenticationProvider
} from '../src/modules/auth/local-authentication-provider.ts'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'signature-test' }
let pool: Pool
let storageDirectory: string
let config: AppConfig
let service: SignatureService
let authenticationProvider: LocalAuthenticationProvider
let workflow: WorkflowService

async function account(
  username: string,
  jobTitle: string | null = 'باحث شئون عاملين',
  password = 'synthetic-current-password'
): Promise<AuthContext> {
  const userId = randomUUID()
  const roleId = randomUUID()

  const passwordHash =
    await authenticationProvider.hashPassword(password)

  await pool.query(
    `INSERT INTO egas_useraccount
      (
        id,
        username,
        displayname,
        jobtitle,
        passwordhash,
        mustchangepassword,
        isactive,
        createdat,
        updatedat
      )
     VALUES (
       $1,$2,$3,$4,$5,FALSE,TRUE,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
     )`,
    [
      userId,
      username,
      `الاسم ${username}`,
      jobTitle,
      passwordHash
    ]
  )

  await pool.query(
    `INSERT INTO egas_useraccountrole
      (
        id,
        user_id,
        role,
        canmanageadmins,
        isactive,
        grantedat
      )
     VALUES (
       $1,$2,'EMPLOYEE_AFFAIRS',FALSE,TRUE,
       CURRENT_TIMESTAMP
     )`,
    [
      roleId,
      userId
    ]
  )

  return {
    userId,
    username,
    sessionId: randomUUID(),
    activeRole: 'EMPLOYEE_AFFAIRS',
    roleAssignmentId: roleId,
    canManageAdmins: false,
    mustChangePassword: false
  }
}

async function png(width = 320, height = 120, color = '#0f6b43'): Promise<Buffer> {
  return await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
}

beforeEach(async () => {
  pool = await isolatedPool()
  storageDirectory = await mkdtemp(join(tmpdir(), 'egas-signature-'))
  config = { ...testConfig, signatures: { ...testConfig.signatures, storageDirectory } }
  authenticationProvider =
  new LocalAuthenticationProvider(pool, config)

const currentPasswordVerifier =
  new DatabaseCurrentPasswordVerifier(
    authenticationProvider
  )

service = new SignatureService(
  pool,
  config,
  currentPasswordVerifier
)

workflow = new WorkflowService(pool)
})

afterEach(async () => {
  await pool.end()
  await rm(storageDirectory, { recursive: true, force: true })
})

describe('secure signature assets and immutable workflow signoff', () => {
  it('decodes, strips metadata, and canonically re-encodes approved images', async () => {
    const source = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#ffffff' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const canonical = await canonicalizeSignature(source, 'image/jpeg', config.signatures)
    const metadata = await sharp(canonical.buffer).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.orientation).toBeUndefined()
    expect(metadata.exif).toBeUndefined()
    expect(canonical.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects content-type spoofing, unsupported formats, and excessive dimensions', async () => {
    await expect(canonicalizeSignature(await png(), 'image/jpeg', config.signatures))
      .rejects.toMatchObject({ code: 'SIGNATURE_IMAGE_INVALID' })
    const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).gif().toBuffer()
    await expect(canonicalizeSignature(gif, 'image/gif', config.signatures))
      .rejects.toMatchObject({ code: 'SIGNATURE_MEDIA_TYPE_INVALID' })
    await expect(canonicalizeSignature(await png(2_049, 20), 'image/png', config.signatures))
      .rejects.toMatchObject({ code: 'SIGNATURE_DIMENSIONS_INVALID' })
  })

  it('uses a random private storage identity and denies another account direct asset access', async () => {
    const owner = await account('signature-owner')
    const other = await account('signature-other')
    const asset = await service.upload(await png(), 'image/png', owner, evidence) as { id: string, fileSha256: string }
    const row = (await pool.query<{ storageKey: string, mimeType: string }>(
      `SELECT storagekey AS "storageKey",mimetype AS "mimeType" FROM egas_usersignatureasset WHERE id=$1`, [asset.id]
    )).rows[0]!
    expect(row.storageKey).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(row.mimeType).toBe('image/png')
    expect(await readFile(join(storageDirectory, row.storageKey))).toBeInstanceOf(Buffer)
    await expect(service.content(asset.id, other, async () => false)).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_NOT_FOUND' })
    expect((await service.content(asset.id, owner, async () => false)).length).toBeGreaterThan(0)
  })

  it('derives signer identity, supports one-stage title override, and prevents overwrite or foreign assets', async () => {
    const signer = await account('signer')
    const intruder = await account('intruder')
    const request = await workflow.create({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }, signer, evidence)
    const ownAsset = await service.upload(await png(320, 120, '#155e43'), 'image/png', signer, evidence) as { id: string }
    const foreignAsset = await service.upload(await png(321, 120, '#166534'), 'image/png', intruder, evidence) as { id: string }

    await expect(service.sign(request.id,foreignAsset.id,'مدير مزور','synthetic-current-password',signer,evidence))
      .rejects.toMatchObject({ code: 'SIGNATURE_ASSET_NOT_FOUND' })
    const signoff = await service.sign(request.id,ownAsset.id,'مدير شئون العاملين','synthetic-current-password',signer,evidence)
    expect(signoff).toMatchObject({
      stageCode: 'P1', signerName: 'الاسم signer', signerJobTitle: 'مدير شئون العاملين', jobTitleWasOverridden: true,
      signatureAssetId: ownAsset.id
    })
  await expect(
  service.sign(
    request.id,
    ownAsset.id,
    null,
    'synthetic-current-password',
    signer,
    evidence
  )
).rejects.toMatchObject({
  code: 'WORKFLOW_SIGNOFF_EXISTS'
})
    const stored = (await service.signoffs(request.id))[0]
    expect(stored).toMatchObject({ signerName: 'الاسم signer', signerJobTitle: 'مدير شئون العاملين' })
  })

  it('requires a signer job title when the account has no default and no override', async () => {
  const signer = await account('no-title', null)

  const request = await workflow.create(
    {
      requestType: 'SECONDMENT',
      cycleYear: 2026,
      formMonth: 8,
      formYear: 2026
    },
    signer,
    evidence
  )

  const asset = await service.upload(
    await png(322, 120),
    'image/png',
    signer,
    evidence
  ) as { id: string }

  await expect(
    service.sign(
      request.id,
      asset.id,
      null,
      'synthetic-current-password',
      signer,
      evidence
    )
  ).rejects.toMatchObject({
    code: 'WORKFLOW_SIGNER_JOB_TITLE_REQUIRED'
  })
})
})