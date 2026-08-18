import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config/env.ts'
import type { RequestEvidence } from '../src/middleware/request-context.ts'
import type { AuthContext } from '../src/modules/auth/types.ts'
import {
  freezeFinalSnapshot,
  PDF_TEMPLATE_V1,
  PDF_TEMPLATE_V2
} from '../src/modules/workflow/form-snapshot.ts'
import { PdfService } from '../src/modules/workflow/pdf-service.ts'
import { WorkflowService } from '../src/modules/workflow/workflow-service.ts'
import { isolatedPool, testConfig } from './helpers/database.ts'

const evidence: RequestEvidence = { ipAddress: '127.0.0.1', userAgent: 'vitest', correlationId: 'pdf-test' }
let pool: Pool
let storageRoot: string
let config: AppConfig
let pdf: PdfService
let workflow: WorkflowService

async function account(username: string): Promise<AuthContext> {
  const userId = randomUUID(); const roleId = randomUUID()
  await pool.query(
    `INSERT INTO egas_useraccount
      (id,username,displayname,jobtitle,passwordhash,mustchangepassword,isactive,createdat,updatedat)
     VALUES ($1,$2,$3,'باحث شئون عاملين','synthetic',FALSE,TRUE,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [userId, username, `الاسم ${username}`]
  )
  await pool.query(
    `INSERT INTO egas_useraccountrole (id,user_id,role,canmanageadmins,isactive,grantedat)
     VALUES ($1,$2,'EMPLOYEE_AFFAIRS',FALSE,TRUE,CURRENT_TIMESTAMP)`, [roleId, userId]
  )
  return { userId, username, sessionId: randomUUID(), activeRole: 'EMPLOYEE_AFFAIRS', roleAssignmentId: roleId,
    canManageAdmins: false, mustChangePassword: false }
}

function pdfPageSize(
  pdf: Buffer
): {
  width: number
  height: number
} {
  const source =
    pdf.toString('latin1')

  const match =
    source.match(
      /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/
    )

  if (!match) {
    throw new Error(
      'PDF MediaBox was not found'
    )
  }

  return {
    width:
      Number(match[1]),

    height:
      Number(match[2])
  }
}

beforeEach(async () => {
  pool = await isolatedPool()
  storageRoot = await mkdtemp(join(tmpdir(), 'egas-pdf-'))
  config = { ...testConfig, pdf: { ...testConfig.pdf, storageDirectory: join(storageRoot, 'pdf') },
    signatures: { ...testConfig.signatures, storageDirectory: join(storageRoot, 'signatures') } }
  pdf = new PdfService(pool, config)
  workflow = new WorkflowService(pool)
})

afterEach(async () => {
  await pool.end()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('PDF evidence system', () => {
  it('renders Arabic draft/audit PDFs and materializes an immutable received-stage PDF only for its recipient', async () => {
    const owner = await account('pdf-owner'); const other = await account('pdf-other')
    const request = await workflow.create({ requestType: 'PROMOTION', cycleYear: 2026, formMonth: 8, formYear: 2026 }, owner, evidence)
    const documents = await pdf.documents(request.id, owner) as { received: Array<{ snapshotId: string }> }
    expect(documents.received).toHaveLength(1)

    const draft = await pdf.draft(request.id, owner)
    expect(draft.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    const received = await pdf.received(request.id, documents.received[0]!.snapshotId, owner)
    expect(received.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    await expect(pdf.received(request.id, documents.received[0]!.snapshotId, other))
      .rejects.toMatchObject({ code: 'PDF_RECEIVED_NOT_FOUND' })

    await pool.query(`UPDATE egas_workflowrequest SET formyear=2027 WHERE id=$1`, [request.id])
    const reopened = await pdf.received(request.id, documents.received[0]!.snapshotId, owner)
    expect(createHash('sha256').update(reopened.buffer).digest('hex'))
      .toBe(createHash('sha256').update(received.buffer).digest('hex'))
    expect((await pool.query(`SELECT storagekey,filesha256 FROM egas_frozenpdfdocument WHERE documentstate='RECEIVED'`)).rows[0])
      .toMatchObject({ storagekey: expect.stringMatching(/^[0-9a-f-]{36}\.pdf$/), filesha256: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const audit = await pdf.requestAudit(request.id, owner)
    expect(audit.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await pool.query(`SELECT documenttype,documentstate FROM egas_pdfgenerationlog ORDER BY generatedat`)).rows)
      .toEqual(expect.arrayContaining([
        { documenttype: 'FORM', documentstate: 'DRAFT' },
        { documenttype: 'FORM', documentstate: 'RECEIVED' },
        { documenttype: 'AUDIT_LOG', documentstate: 'DRAFT' }
      ]))
  })

  it('freezes final source data before on-demand materialization and restricts final PDF to the originating EA role', async () => {
    const owner = await account('final-owner'); const other = await account('final-other')
    const request = await workflow.create({ requestType: 'SECONDMENT', cycleYear: 2026, formMonth: 8, formYear: 2026 }, owner, evidence)
    const iteration = (await pool.query<{ id: string }>(
      `SELECT id FROM egas_workflowiteration WHERE request_id=$1 AND iterationno=1`, [request.id]
    )).rows[0]!
    await pool.query(`UPDATE egas_workflowrequest SET status='COMPLETED',completedat=CURRENT_TIMESTAMP WHERE id=$1`, [request.id])
    await freezeFinalSnapshot(pool, request.id as string, iteration.id)
    await pool.query(`UPDATE egas_workflowrequest SET formyear=2027 WHERE id=$1`, [request.id])

    const final = await pdf.final(request.id, owner)
    expect(final.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    const frozen = (await pool.query<{ snapshotJson: { request: { formYear: number } } }>(
      `SELECT snapshotjson AS "snapshotJson" FROM egas_frozenpdfdocument WHERE documentstate='FINAL'`
    )).rows[0]!
    expect(Number(frozen.snapshotJson.request.formYear)).toBe(2026)
    await expect(pdf.final(request.id, other)).rejects.toMatchObject({ code: 'PDF_FINAL_NOT_FOUND' })
  })
  it(
  'uses V2 for new drafts after template activation',
  async () => {
    const owner =
      await account(
        'v2-draft-owner'
      )

    const request =
      await workflow.create(
        {
          requestType:
            'PROMOTION',

          cycleYear: 2026,
          formMonth: 8,
          formYear: 2026
        },
        owner,
        evidence
      )

    const draft =
      await pdf.draft(
        request.id,
        owner
      )

    expect(
      draft.buffer
        .subarray(0, 5)
        .toString()
    ).toBe('%PDF-')

    const page =
      pdfPageSize(
        draft.buffer
      )

    /*
     * Official V2 is A4 landscape.
     */
    expect(
      page.width
    ).toBeGreaterThan(
      page.height
    )

    const log =
      (
        await pool.query<{
          templateVersion: string
        }>(
          `SELECT
             templateversion AS "templateVersion"
           FROM egas_pdfgenerationlog
           WHERE request_id=$1
             AND documenttype='FORM'
             AND documentstate='DRAFT'
           ORDER BY generatedat DESC
           LIMIT 1`,
          [request.id]
        )
      ).rows[0]

    expect(
      log?.templateVersion
    ).toBe(
      PDF_TEMPLATE_V2
    )
  }
)
it(
  'preserves V1 for a historical received snapshot after V2 activation',
  async () => {
    const owner =
      await account(
        'historical-v1-owner'
      )

    const request =
      await workflow.create(
        {
          requestType:
            'PROMOTION',

          cycleYear: 2026,
          formMonth: 8,
          formYear: 2026
        },
        owner,
        evidence
      )

    const documents =
      await pdf.documents(
        request.id,
        owner
      ) as {
        received: Array<{
          snapshotId: string
        }>
      }

    expect(
      documents.received
    ).toHaveLength(1)

    const snapshotId =
      documents.received[0]!
        .snapshotId

    /*
     * Simulate a snapshot captured while
     * V1 was still the active template.
     *
     * It has not yet been materialized.
     */
    await pool.query(
      `UPDATE egas_stagereceivedsnapshot
          SET templateversion=$2
        WHERE id=$1`,
      [
        snapshotId,
        PDF_TEMPLATE_V1
      ]
    )

    const received =
      await pdf.received(
        request.id,
        snapshotId,
        owner
      )

    expect(
      received.buffer
        .subarray(0, 5)
        .toString()
    ).toBe('%PDF-')

    const page =
      pdfPageSize(
        received.buffer
      )

    /*
     * Historical V1 renderer is portrait.
     *
     * This proves that activation of V2
     * did not silently re-render historical
     * evidence using the new layout.
     */
    expect(
      page.height
    ).toBeGreaterThan(
      page.width
    )

    const frozen =
      (
        await pool.query<{
          templateVersion: string
        }>(
          `SELECT
             templateversion AS "templateVersion"
           FROM egas_frozenpdfdocument
           WHERE stagereceivedsnapshot_id=$1
             AND documentstate='RECEIVED'`,
          [snapshotId]
        )
      ).rows[0]

    expect(
      frozen?.templateVersion
    ).toBe(
      PDF_TEMPLATE_V1
    )
  }
)
it(
  'fails closed for an unsupported stored PDF template version',
  async () => {
    const owner =
      await account(
        'unsupported-template-owner'
      )

    const request =
      await workflow.create(
        {
          requestType:
            'SECONDMENT',

          cycleYear: 2026,
          formMonth: 8,
          formYear: 2026
        },
        owner,
        evidence
      )

    const documents =
      await pdf.documents(
        request.id,
        owner
      ) as {
        received: Array<{
          snapshotId: string
        }>
      }

    expect(
      documents.received
    ).toHaveLength(1)

    const snapshotId =
      documents.received[0]!
        .snapshotId

    /*
     * Simulate evidence referring to a
     * template this server does not know.
     */
    await pool.query(
      `UPDATE egas_stagereceivedsnapshot
          SET templateversion=$2
        WHERE id=$1`,
      [
        snapshotId,
        'EGAS-OFFICIAL-AR-999.0'
      ]
    )

    await expect(
      pdf.received(
        request.id,
        snapshotId,
        owner
      )
    ).rejects.toMatchObject({
      code:
        'PDF_TEMPLATE_UNSUPPORTED'
    })
  }
)
})
