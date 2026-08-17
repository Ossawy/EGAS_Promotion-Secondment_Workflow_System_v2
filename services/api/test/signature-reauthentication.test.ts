import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import sharp from 'sharp'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it
} from 'vitest'

import type { AppConfig } from '../src/config/env.ts'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import {
  DatabaseCurrentPasswordVerifier
} from '../src/modules/auth/current-password-verifier.ts'
import {
  LocalAuthenticationProvider
} from '../src/modules/auth/local-authentication-provider.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import {
  SignatureService
} from '../src/modules/workflow/signature-service.ts'
import {
  responsibleRole,
  type WorkflowStage,
  type WorkflowType
} from '../src/modules/workflow/types.ts'
import {
  WorkflowRepository
} from '../src/modules/workflow/workflow-repository.ts'
import {
  isolatedPool,
  testConfig
} from './helpers/database.ts'

const evidence: RequestEvidence = {
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId: 'signature-reauthentication-test'
}

type SignatureAsset = {
  id: string
}

type SecurityEventRow = {
  eventType: string
  details: unknown
}

let pool: Pool
let config: AppConfig
let storageDirectory: string
let authenticationProvider: LocalAuthenticationProvider
let signatures: SignatureService

async function account(
  username: string,
  role: AuthContext['activeRole'],
  password: string,
  jobTitle = 'باحث شئون عاملين'
): Promise<AuthContext> {
  const userId = randomUUID()
  const roleAssignmentId = randomUUID()

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
       $1,$2,$3,$4,$5,
       FALSE,
       TRUE,
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
       $1,$2,$3,FALSE,TRUE,CURRENT_TIMESTAMP
     )`,
    [
      roleAssignmentId,
      userId,
      role
    ]
  )

  return {
    userId,
    username,
    sessionId: randomUUID(),
    activeRole: role,
    roleAssignmentId,
    canManageAdmins: false,
    mustChangePassword: false
  }
}

async function stagedRequest(
  stage: WorkflowStage,
  actor: AuthContext
): Promise<{ id: string }> {
  const requestId = randomUUID()
  const iterationId = randomUUID()
  const taskId = randomUUID()

  const requestType: WorkflowType =
    stage.startsWith('P')
      ? 'PROMOTION'
      : 'SECONDMENT'

  const repository =
    new WorkflowRepository(pool)

  await repository.insertRequest(
    requestId,
    requestType,
    2026,
    8,
    2026,
    actor.userId,
    stage
  )

  await repository.insertIteration(
    iterationId,
    requestId,
    actor.userId
  )

  await repository.insertTask(
    taskId,
    requestId,
    iterationId,
    stage,
    actor.userId
  )

  await pool.query(
    `UPDATE egas_workflowrequest
        SET status = 'IN_PROGRESS'
      WHERE id = $1`,
    [requestId]
  )

  return {
    id: requestId
  }
}

async function signatureAsset(
  actor: AuthContext
): Promise<SignatureAsset> {
  const image = await sharp({
    create: {
      width: 320,
      height: 120,
      channels: 4,
      background: '#155e43'
    }
  })
    .png()
    .toBuffer()

  return await signatures.upload(
    image,
    'image/png',
    actor,
    evidence
  ) as SignatureAsset
}

async function signoffCount(
  requestId: string
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM egas_workflowsignoff
      WHERE request_id = $1`,
    [requestId]
  )

  return Number(result.rows[0]!.count)
}

beforeEach(async () => {
  pool = await isolatedPool()

  storageDirectory =
    await mkdtemp(
      join(
        tmpdir(),
        'egas-signature-reauth-'
      )
    )

  config = {
    ...testConfig,
    signatures: {
      ...testConfig.signatures,
      storageDirectory
    }
  }

  authenticationProvider =
    new LocalAuthenticationProvider(
      pool,
      config
    )

  const currentPasswordVerifier =
    new DatabaseCurrentPasswordVerifier(
      authenticationProvider
    )

  signatures =
    new SignatureService(
      pool,
      config,
      currentPasswordVerifier
    )
})

afterEach(async () => {
  await pool.end()

  await rm(
    storageDirectory,
    {
      recursive: true,
      force: true
    }
  )
})

describe(
  'signature password reauthentication',
  () => {
    it.each([
      'P1',
      'P2',
      'S1',
      'S2'
    ] as const)(
      'requires the current account password at %s',
      async stage => {
        const correctPassword =
          `${stage}-current-password-2026!`

        const actor = await account(
          `signer-${stage.toLowerCase()}`,
          responsibleRole(stage),
          correctPassword
        )

        const request =
          await stagedRequest(
            stage,
            actor
          )

        const asset =
          await signatureAsset(actor)

        await expect(
          signatures.sign(
            request.id,
            asset.id,
            null,
            'wrong-current-password',
            actor,
            evidence
          )
        ).rejects.toMatchObject({
          status: 401,
          code: 'SIGNATURE_PASSWORD_INVALID'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)

        const signoff =
          await signatures.sign(
            request.id,
            asset.id,
            null,
            correctPassword,
            actor,
            evidence
          )

        expect(signoff).toMatchObject({
          stageCode: stage,
          signerUserId: actor.userId,
          signatureAssetId: asset.id
        })

        expect(
          await signoffCount(request.id)
        ).toBe(1)
      }
    )

    it(
      'rejects a missing password explicitly',
      async () => {
        const password =
          'missing-password-test-2026!'

        const actor = await account(
          'missing-password-signer',
          'EMPLOYEE_AFFAIRS',
          password
        )

        const request =
          await stagedRequest(
            'P1',
            actor
          )

        const asset =
          await signatureAsset(actor)

        await expect(
          signatures.sign(
            request.id,
            asset.id,
            null,
            undefined,
            actor,
            evidence
          )
        ).rejects.toMatchObject({
          status: 400,
          code: 'SIGNATURE_PASSWORD_REQUIRED'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)
      }
    )

    it(
      'persists a safe security event after a wrong password and creates no signoff',
      async () => {
        const correctPassword =
          'security-event-current-password!'

        const wrongPassword =
          'security-event-wrong-password!'

        const actor = await account(
          'security-event-signer',
          'EMPLOYEE_AFFAIRS',
          correctPassword
        )

        const request =
          await stagedRequest(
            'S1',
            actor
          )

        const asset =
          await signatureAsset(actor)

        await expect(
          signatures.sign(
            request.id,
            asset.id,
            null,
            wrongPassword,
            actor,
            evidence
          )
        ).rejects.toMatchObject({
          status: 401,
          code: 'SIGNATURE_PASSWORD_INVALID'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)

        const events =
          await pool.query<SecurityEventRow>(
            `SELECT
               eventtype AS "eventType",
               detailsjson AS details
             FROM egas_securityevent
             WHERE actoruser_id = $1
               AND eventtype = 'SIGNATURE_PASSWORD_REJECTED'
             ORDER BY createdat DESC`,
            [actor.userId]
          )

        expect(events.rows).toHaveLength(1)

        expect(
          events.rows[0]
        ).toMatchObject({
          eventType:
            'SIGNATURE_PASSWORD_REJECTED'
        })

        const serializedDetails =
          JSON.stringify(
            events.rows[0]!.details
          )

        expect(
          serializedDetails
        ).toContain(request.id)

        expect(
          serializedDetails
        ).toContain('INVALID_PASSWORD')

        expect(
          serializedDetails
        ).not.toContain(wrongPassword)

        expect(
          serializedDetails
        ).not.toContain(correctPassword)

        expect(
          serializedDetails.toLowerCase()
        ).not.toContain('passwordhash')
      }
    )

    it(
      'does not accept another account password',
      async () => {
        const signerPassword =
          'actual-signer-password-2026!'

        const otherPassword =
          'other-account-password-2026!'

        const signer = await account(
          'actual-signer',
          'EMPLOYEE_AFFAIRS',
          signerPassword
        )

        await account(
          'other-account',
          'EMPLOYEE_AFFAIRS',
          otherPassword
        )

        const request =
          await stagedRequest(
            'P1',
            signer
          )

        const asset =
          await signatureAsset(signer)

        await expect(
          signatures.sign(
            request.id,
            asset.id,
            null,
            otherPassword,
            signer,
            evidence
          )
        ).rejects.toMatchObject({
          status: 401,
          code: 'SIGNATURE_PASSWORD_INVALID'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)

        const signoff =
          await signatures.sign(
            request.id,
            asset.id,
            null,
            signerPassword,
            signer,
            evidence
          )

        expect(signoff).toMatchObject({
          signerUserId: signer.userId,
          stageCode: 'P1'
        })
      }
    )

    it(
      'does not trim the password before verification',
      async () => {
        const password =
          '  exact-password-with-spaces-2026!  '

        const actor = await account(
          'whitespace-signer',
          'EMPLOYEE_AFFAIRS',
          password
        )

        const request =
          await stagedRequest(
            'S1',
            actor
          )

        const asset =
          await signatureAsset(actor)

        await expect(
          signatures.sign(
            request.id,
            asset.id,
            null,
            password.trim(),
            actor,
            evidence
          )
        ).rejects.toMatchObject({
          status: 401,
          code: 'SIGNATURE_PASSWORD_INVALID'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)

        const signoff =
          await signatures.sign(
            request.id,
            asset.id,
            null,
            password,
            actor,
            evidence
          )

        expect(signoff).toMatchObject({
          stageCode: 'S1',
          signerUserId: actor.userId
        })
      }
    )

    it(
      'fails closed when the signing service has no password verifier',
      async () => {
        const password =
          'fail-closed-current-password!'

        const actor = await account(
          'fail-closed-signer',
          'EMPLOYEE_AFFAIRS',
          password
        )

        const request =
          await stagedRequest(
            'P1',
            actor
          )

        const asset =
          await signatureAsset(actor)

        const serviceWithoutVerifier =
          new SignatureService(
            pool,
            config
          )

        await expect(
          serviceWithoutVerifier.sign(
            request.id,
            asset.id,
            null,
            password,
            actor,
            evidence
          )
        ).rejects.toMatchObject({
          status: 500,
          code:
            'SIGNATURE_REAUTHENTICATION_UNAVAILABLE'
        })

        expect(
          await signoffCount(request.id)
        ).toBe(0)
      }
    )
  }
)