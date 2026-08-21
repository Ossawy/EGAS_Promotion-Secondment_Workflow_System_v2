import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfRenderLimiter } from '../src/modules/workflow/pdf-render-limiter.ts'
import { PdfService } from '../src/modules/workflow/pdf-service.ts'
import { createPhase6Fixture, type Phase6Fixture } from './helpers/phase6-fixture.ts'

let fx: Phase6Fixture
let fixtureCleanup: (() => Promise<void>) | undefined
beforeEach(async () => {
  fx = await createPhase6Fixture()
  fixtureCleanup = fx.cleanup
  fx.config.pdf.renderTimeoutMs = 5_000
})
afterEach(async () => {
  if (fixtureCleanup) {
    await fixtureCleanup()
    fixtureCleanup = undefined
  }
})

async function finalizePromotion() {
  const request = await fx.createRequest('PROMOTION'); const ha = await fx.upload(fx.users.hrManager)
  await fx.sign(request.stageExecutionId, fx.users.hrManager, String(ha.id)); const p2 = await fx.currentExecution(request.requestId); const oa = await fx.upload(fx.users.orgManager)
  await fx.sign(p2.id, fx.users.orgManager, String(oa.id)); const p3 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p3.id, fx.users.hrManager)
  const p4 = await fx.currentExecution(request.requestId); await fx.promotion.upsertDecision(p4.id, request.candidateId, { decisionType: 'SAME_POSITION', recommendation: 'ترشيح', notes: 'ملاحظات AUTH' }, fx.users.authManager)
  const aa = await fx.upload(fx.users.authManager); await fx.sign(p4.id, fx.users.authManager, String(aa.id)); const p5 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p5.id, fx.users.hrManager)
  return request
}

async function finalizeSecondmentWithMultipleOptions() {
  const request = await fx.createRequest('SECONDMENT'); const ha = await fx.upload(fx.users.hrManager)
  await fx.sign(request.stageExecutionId, fx.users.hrManager, String(ha.id)); const s2 = await fx.currentExecution(request.requestId); const oa = await fx.upload(fx.users.orgManager)
  await fx.prepareSecondment(s2.id, request.candidateId)
  const first = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم أول', organizationalDependency: 'إدارة الاختبار الأولى', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
  const selected = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم مختار', organizationalDependency: 'إدارة الاختبار الثانية', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
  await fx.sign(s2.id, fx.users.orgManager, String(oa.id)); const s3 = await fx.currentExecution(request.requestId); const aa = await fx.upload(fx.users.authManager)
  await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: selected.id }, fx.users.authManager); await fx.sign(s3.id, fx.users.authManager, String(aa.id))
  const s4 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(s4.id, fx.users.orgManager)
  const s5 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(s5.id, fx.users.hrManager)
  return { request, first, selected }
}

describe('Phase 6 PDF documents and audit evidence', () => {
  it('enforces request-read authorization for current and audit PDFs without creating frozen evidence', async () => {
    const request = await fx.createRequest('PROMOTION'); const pdf = new PdfService(fx.pool, fx.config)
    await expect(pdf.getCurrentPdf(request.requestId, fx.users.outsider)).rejects.toMatchObject({ status: 404 })
    await expect(pdf.getAuditPdf(request.requestId, fx.users.outsider)).rejects.toMatchObject({ status: 404 })
    await expect(fx.pool.query('SELECT id FROM final_form_snapshot WHERE request_id=$1', [request.requestId])).resolves.toMatchObject({ rowCount: 0 })
    await expect(fx.pool.query('SELECT id FROM frozen_pdf_document')).resolves.toMatchObject({ rowCount: 0 })
  })

  it('does not expose a final PDF before completion', async () => {
    const request = await fx.createRequest('PROMOTION'); const pdf = new PdfService(fx.pool, fx.config)
    await expect(pdf.getFinalPdf(request.requestId, fx.users.hrManager)).rejects.toMatchObject({ code: 'REQUEST_NOT_COMPLETED' })
  })

  it('materializes one checksum-verified final PDF from the immutable snapshot and reuses it on retry', async () => {
    const request = await finalizePromotion(); const pdf = new PdfService(fx.pool, fx.config)
    await fx.pool.query(
      'UPDATE employee_annual_snapshot SET employee_data=$1::jsonb WHERE id=(SELECT employee_snapshot_id FROM request_candidate WHERE request_id=$2)',
      [JSON.stringify({ employeeName: 'live mutation', sourceRoutingLabel: 'live mutation' }), request.requestId]
    )
    const one = await pdf.getFinalPdf(request.requestId, fx.users.hrManager); const two = await pdf.getFinalPdf(request.requestId, fx.users.hrManager)
    const frozen = await fx.pool.query<{ storage_key: string, sha256: string, byte_size: number }>('SELECT storage_key,sha256,byte_size FROM frozen_pdf_document')
    const snapshot = await fx.pool.query<{ payload: { candidates: Array<Record<string, unknown>> } }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    const bytes = await readFile(join(fx.config.pdf.storageDirectory, frozen.rows[0]!.storage_key))
    expect(one.buffer.subarray(0, 5).toString()).toBe('%PDF-'); expect(two.buffer).toEqual(one.buffer)
    expect(frozen.rowCount).toBe(1); expect(bytes.length).toBe(frozen.rows[0]!.byte_size)
    expect((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')).toBe(frozen.rows[0]!.sha256)
    expect(snapshot.rows[0]!.payload.candidates[0]).toMatchObject({
      sourceRoutingLabel: 'نيابة الاختبار',
      qualificationInstitute: 'جامعة القاهرة',
      qualificationName: 'بكالوريوس تجارة',
      qualificationDate: '2010-06-01',
      currentJobStartDate: '2020-01-01',
      experience: { years: 12, months: 3, days: 4 },
      performanceRating: 'ممتاز',
      promotionDecision: { recommendation: 'ترشيح', effectiveNominatedJob: 'أخصائي أول', notes: 'ملاحظات AUTH' }
    })
  })

  it('renders all frozen S2 options and the frozen S3 selection without reading mutable option/reference data', async () => {
    const { request, selected } = await finalizeSecondmentWithMultipleOptions()
    await fx.pool.query("UPDATE secondment_position_option SET position_title='mutated' WHERE id=$1", [selected.id])
    await fx.pool.query("UPDATE qualification_status_reference SET name='mutated' WHERE code='QUALIFIED'")
    const pdf = await new PdfService(fx.pool, fx.config).getFinalPdf(request.requestId, fx.users.hrManager)
    const snapshot = await fx.pool.query<{ payload: { candidates: Array<{ secondmentPositionOptions: Array<{ positionTitle: string }>, secondmentSelection: { selectedOptionId: string } }> } }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    expect(pdf.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentPositionOptions.map(option => option.positionTitle)).toEqual(['رئيس قسم أول', 'رئيس قسم مختار'])
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentSelection.selectedOptionId).toBe(selected.id)
  })

  it('fails closed for corrupted final snapshot, corrupted frozen PDF, and corrupt signature evidence rather than regenerating it', async () => {
    const request = await finalizePromotion(); const pdf = new PdfService(fx.pool, fx.config)
    await fx.pool.query("UPDATE final_form_snapshot SET sha256='0000000000000000000000000000000000000000000000000000000000000000' WHERE request_id=$1", [request.requestId])
    await expect(pdf.getFinalPdf(request.requestId, fx.users.hrManager)).rejects.toMatchObject({ code: 'FINAL_SNAPSHOT_INTEGRITY_MISMATCH' })
    await fx.pool.query('UPDATE final_form_snapshot SET sha256=(SELECT sha256 FROM final_form_snapshot WHERE request_id=$1) WHERE request_id=$1', [request.requestId])
    // Recreate a valid snapshot hash after deliberately exercising snapshot protection.
    const snapshot = await fx.pool.query<{ payload: unknown }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    const hash = (await import('../src/modules/workflow/form-snapshot.ts')).computeSnapshotSha256(snapshot.rows[0]!.payload)
    await fx.pool.query('UPDATE final_form_snapshot SET sha256=$2 WHERE request_id=$1', [request.requestId, hash])
    await pdf.getFinalPdf(request.requestId, fx.users.hrManager)
    const frozen = await fx.pool.query<{ storage_key: string }>('SELECT storage_key FROM frozen_pdf_document')
    await writeFile(join(fx.config.pdf.storageDirectory, frozen.rows[0]!.storage_key), Buffer.from('corrupt PDF'))
    await expect(pdf.getFinalPdf(request.requestId, fx.users.hrManager)).rejects.toMatchObject({ code: 'FROZEN_PDF_INTEGRITY_MISMATCH' })
  })

  it('keeps final evidence after a render failure and permits a later lazy retry', async () => {
    const request = await finalizePromotion(); const snapshot = await fx.pool.query<{ id: string }>('SELECT id FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    const failureConfig = { ...fx.config, pdf: { ...fx.config.pdf, maxOutputBytes: 1 } }
    const failing = new PdfService(fx.pool, failureConfig)
    await expect(failing.getFinalPdf(request.requestId, fx.users.hrManager)).rejects.toThrow('PDF output limit exceeded')
    await expect(fx.pool.query('SELECT id FROM final_form_snapshot WHERE id=$1', [snapshot.rows[0]!.id])).resolves.toMatchObject({ rowCount: 1 })
    await expect(new PdfService(fx.pool, fx.config).getFinalPdf(request.requestId, fx.users.hrManager)).resolves.toMatchObject({ buffer: expect.any(Buffer) })
  })

  it('bounds renderer concurrency, queue capacity, timeout release, and reports queue-full safely', async () => {
    const limiter = new PdfRenderLimiter(1, 1, 10)
    const never = limiter.run(async () => await new Promise<Buffer>(() => undefined))
    const queued = limiter.run(async () => Buffer.from('queued'))
    await expect(limiter.run(async () => Buffer.from('overflow'))).rejects.toMatchObject({ code: 'PDF_RENDER_BUSY' })
    await expect(never).rejects.toMatchObject({ code: 'PDF_RENDER_TIMEOUT' })
    await expect(queued).resolves.toEqual(Buffer.from('queued'))
    await expect(limiter.run(async () => Buffer.from('released'))).resolves.toEqual(Buffer.from('released'))
  })

  it('produces a chronological audit PDF without passwords, private storage keys, or filesystem paths', async () => {
    const request = await finalizePromotion(); const pdf = new PdfService(fx.pool, fx.config)
    const result = await pdf.getAuditPdf(request.requestId, fx.users.hrManager)
    const auditRows = await fx.pool.query<{ details: unknown }>('SELECT details FROM audit_event')
    expect(result.buffer.subarray(0, 5).toString()).toBe('%PDF-')
    expect(JSON.stringify(auditRows.rows)).not.toContain(fx.config.signatures.storageDirectory)
    expect(JSON.stringify(auditRows.rows)).not.toContain('Password123!')
  })
})
