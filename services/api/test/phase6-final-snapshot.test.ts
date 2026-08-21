import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeSnapshotSha256, PROMOTION_TEMPLATE_V3, SECONDMENT_TEMPLATE_BASELINE } from '../src/modules/workflow/form-snapshot.ts'
import { createPhase6Fixture, type Phase6Fixture } from './helpers/phase6-fixture.ts'

let fx: Phase6Fixture
beforeEach(async () => { fx = await createPhase6Fixture() })
afterEach(async () => { await fx.cleanup() })

async function completedPromotion() {
  const request = await fx.createRequest('PROMOTION'); const h = await fx.upload(fx.users.hrManager)
  await fx.sign(request.stageExecutionId, fx.users.hrManager, String(h.id)); const p2 = await fx.currentExecution(request.requestId); const o = await fx.upload(fx.users.orgManager)
  await fx.sign(p2.id, fx.users.orgManager, String(o.id)); const p3 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p3.id, fx.users.hrManager)
  const p4 = await fx.currentExecution(request.requestId); await fx.promotion.upsertDecision(p4.id, request.candidateId, { decisionType: 'SAME_POSITION', recommendation: 'ترشيح', notes: 'ملاحظات AUTH' }, fx.users.authManager)
  const a = await fx.upload(fx.users.authManager); await fx.sign(p4.id, fx.users.authManager, String(a.id)); const p5 = await fx.currentExecution(request.requestId)
  return { request, p4, p5 }
}

async function completedSecondment() {
  const request = await fx.createRequest('SECONDMENT'); const h = await fx.upload(fx.users.hrManager)
  await fx.sign(request.stageExecutionId, fx.users.hrManager, String(h.id)); const s2 = await fx.currentExecution(request.requestId); const o = await fx.upload(fx.users.orgManager)
  await fx.prepareSecondment(s2.id, request.candidateId)
  const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
  const alternative = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'مدير إدارة بديل', organizationalDependency: 'الإدارة العامة للاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
  await fx.sign(s2.id, fx.users.orgManager, String(o.id)); const s3 = await fx.currentExecution(request.requestId); const a = await fx.upload(fx.users.authManager)
  await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: alternative.id }, fx.users.authManager); await fx.sign(s3.id, fx.users.authManager, String(a.id))
  const s4 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(s4.id, fx.users.orgManager)
  await fx.engine.addNote(request.requestId, { candidateId: request.candidateId, body: 'ملاحظة مرشح أولى' }, fx.users.hrManager)
  await fx.engine.addNote(request.requestId, { candidateId: request.candidateId, body: 'ملاحظة مرشح ثانية' }, fx.users.hrManager)
  await fx.engine.addNote(request.requestId, { body: 'ملاحظة على مستوى الطلب' }, fx.users.hrManager)
  return { request, s3, option, alternative, s5: await fx.currentExecution(request.requestId) }
}

describe('Phase 6 immutable final snapshots', () => {
  it('uses canonical hashing independent of object key order', () => {
    expect(computeSnapshotSha256({ b: 2, a: { y: 2, x: 1 } })).toBe(computeSnapshotSha256({ a: { x: 1, y: 2 }, b: 2 }))
  })

  it('P5 fails when authoritative P1, P2, or P4 signoffs are absent', async () => {
    const request = await fx.createRequest('PROMOTION')
    await fx.pool.query(`UPDATE stage_execution SET status='COMPLETED',work_state='COMPLETED' WHERE id=$1`, [request.stageExecutionId])
    const iteration = await fx.pool.query<{ id: string }>('SELECT id FROM workflow_iteration WHERE request_id=$1', [request.requestId]); const p5 = randomUUID()
    await fx.pool.query(`INSERT INTO stage_execution (id,iteration_id,stage_code,execution_no,responsible_unit_id,status,work_state) VALUES ($1,$2,'P5',1,$3,'OPEN','MANAGER_INBOX')`, [p5, iteration.rows[0]!.id, fx.units.hr])
    await fx.pool.query("UPDATE workflow_request SET current_stage_code='P5' WHERE id=$1", [request.requestId])
    await expect(fx.engine.approveAndAdvance(p5, fx.users.hrManager)).rejects.toMatchObject({ code: 'AUTHORITATIVE_SIGNOFF_MISSING' })
    await expect(fx.pool.query('SELECT id FROM final_form_snapshot WHERE request_id=$1', [request.requestId])).resolves.toMatchObject({ rowCount: 0 })
  })

  it('P5 atomically completes the execution, iteration, and request and inserts one immutable Promotion V3 snapshot', async () => {
    const { request, p4, p5 } = await completedPromotion()
    await fx.engine.approveAndAdvance(p5.id, fx.users.hrManager)
    const [snapshot, execution, iteration, workflow, p5Signoff] = await Promise.all([
      fx.pool.query<{ template_version: string, payload: Record<string, unknown>, sha256: string }>('SELECT template_version,payload,sha256 FROM final_form_snapshot WHERE request_id=$1', [request.requestId]),
      fx.pool.query<{ status: string }>('SELECT status FROM stage_execution WHERE id=$1', [p5.id]),
      fx.pool.query<{ status: string }>('SELECT status FROM workflow_iteration WHERE request_id=$1', [request.requestId]),
      fx.pool.query<{ status: string, completed_at: Date }>('SELECT status,completed_at FROM workflow_request WHERE id=$1', [request.requestId]),
      fx.pool.query('SELECT id FROM workflow_signoff WHERE stage_execution_id=$1', [p5.id])
    ])
    expect(snapshot.rows[0]!.template_version).toBe(PROMOTION_TEMPLATE_V3); expect(snapshot.rows[0]!.sha256).toBe(computeSnapshotSha256(snapshot.rows[0]!.payload))
    expect(execution.rows[0]!.status).toBe('COMPLETED'); expect(iteration.rows[0]!.status).toBe('COMPLETED'); expect(workflow.rows[0]).toMatchObject({ status: 'COMPLETED', completed_at: expect.anything() }); expect(p5Signoff.rowCount).toBe(0)
    expect(snapshot.rows[0]!.payload).toMatchObject({ candidates: [expect.objectContaining({ promotionDecision: expect.objectContaining({ decisionType: 'SAME_POSITION' }) })], signoffs: [expect.objectContaining({ stageCode: 'P1' }), expect.objectContaining({ stageCode: 'P2' }), expect.objectContaining({ stageCode: 'P4', stageExecutionId: p4.id })] })
  })

  it('freezes candidate source, workbook experience, recommendation, nominated job, AUTH notes, qualification and signer evidence against later mutation', async () => {
    const { request, p5 } = await completedPromotion(); await fx.engine.approveAndAdvance(p5.id, fx.users.hrManager)
    const original = await fx.pool.query<{ payload: { candidates: Array<Record<string, unknown>>, signoffs: Array<Record<string, unknown>> } }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    await fx.pool.query(
      'UPDATE request_candidate SET frozen_data=$1::jsonb WHERE request_id=$2',
      [JSON.stringify({ employeeName: 'mutated', sourceRoutingLabel: 'mutated' }), request.requestId]
    )
    await fx.pool.query(
      'UPDATE employee_annual_snapshot SET employee_data=$1::jsonb WHERE id=(SELECT employee_snapshot_id FROM request_candidate WHERE request_id=$2)',
      [JSON.stringify({ employeeName: 'live mutation', sourceRoutingLabel: 'live mutation' }), request.requestId]
    )
    await fx.pool.query("UPDATE promotion_decision SET recommendation='mutated',notes='mutated' WHERE stage_execution_id IN (SELECT id FROM stage_execution WHERE iteration_id=(SELECT current_iteration_id FROM workflow_request WHERE id=$1))", [request.requestId])
    const reread = await fx.pool.query<{ payload: typeof original.rows[0]['payload'] }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    expect(reread.rows[0]!.payload).toEqual(original.rows[0]!.payload)
    expect(original.rows[0]!.payload.candidates[0]).toMatchObject({
      employeeName: 'مرشح تجريبي',
      currentJobTitle: 'أخصائي أول',
      sourceRoutingLabel: 'نيابة الاختبار',
      qualificationInstitute: 'جامعة القاهرة',
      qualificationName: 'بكالوريوس تجارة',
      qualificationDate: '2010-06-01',
      currentJobStartDate: '2020-01-01',
      experience: { years: 12, months: 3, days: 4, referenceDate: '2026-01-01' },
      performanceRating: 'ممتاز',
      promotionDecision: { recommendation: 'ترشيح', effectiveNominatedJob: 'أخصائي أول', notes: 'ملاحظات AUTH' }
    })
  })

  it('fails closed when the frozen source routing label for Promotion general administration is unavailable', async () => {
    const { request, p5 } = await completedPromotion()
    await fx.pool.query("UPDATE request_candidate SET frozen_data=frozen_data - 'sourceRoutingLabel' WHERE request_id=$1", [request.requestId])
    await expect(fx.engine.approveAndAdvance(p5.id, fx.users.hrManager)).rejects.toMatchObject({ code: 'PROMOTION_DEPARTMENT_REQUIRED' })
  })

  it('uses the newest re-signed P4 in the current iteration and retains the returned P4 signoff historically', async () => {
    const { request, p4, p5 } = await completedPromotion()
    await fx.engine.returnPreviousStage(p5.id, { reason: 'إعادة قرار AUTH' }, fx.users.hrManager)
    const freshP4 = await fx.currentExecution(request.requestId)
    await fx.promotion.upsertDecision(freshP4.id, request.candidateId, { decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة جديدة', recommendation: 'جديد', notes: 'ملاحظة جديدة' }, fx.users.authManager)
    const asset = await fx.upload(fx.users.authManager, 'jpeg'); await fx.sign(freshP4.id, fx.users.authManager, String(asset.id))
    const p4o = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p4o.id, fx.users.orgManager)
    const newP5 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(newP5.id, fx.users.hrManager)
    const [snapshot, historical] = await Promise.all([
      fx.pool.query<{ payload: { signoffs: Array<{ stageCode: string, stageExecutionId: string }>, candidates: Array<{ promotionDecision: { targetJobTitle: string } }> } }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId]),
      fx.pool.query('SELECT id FROM workflow_signoff WHERE stage_execution_id IN ($1,$2)', [p4.id, freshP4.id])
    ])
    expect(historical.rowCount).toBe(2)
    expect(snapshot.rows[0]!.payload.signoffs).toContainEqual(expect.objectContaining({ stageCode: 'P4', stageExecutionId: freshP4.id }))
    expect(snapshot.rows[0]!.payload.candidates[0]!.promotionDecision.targetJobTitle).toBe('وظيفة جديدة')
  })

  it('S5 completes with the internal Secondment template, no S5 signoff, and frozen S2/S3 evidence', async () => {
    const { request, s3, option, alternative, s5 } = await completedSecondment(); await fx.engine.approveAndAdvance(s5.id, fx.users.hrManager)
    const snapshot = await fx.pool.query<{ template_version: string, payload: { candidates: Array<{ candidateNotes: string[], secondmentPreparation: Record<string, unknown>, secondmentSelection: Record<string, unknown>, secondmentPositionOptions: Array<Record<string, unknown>> }>, signoffs: Array<{ stageCode: string }> } }>('SELECT template_version,payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])
    expect(snapshot.rows[0]!.template_version).toBe(SECONDMENT_TEMPLATE_BASELINE); expect(snapshot.rows[0]!.template_version).not.toBe('EGAS-OFFICIAL-SECONDMENT-AR-3.0')
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentSelection).toMatchObject({ selectedOptionId: alternative.id, positionTitle: 'مدير إدارة بديل', organizationalDependency: 'الإدارة العامة للاختبار', qualificationStatus: 'QUALIFIED', qualificationStatusName: 'مستوفٍ' })
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentPositionOptions).toEqual([
      expect.objectContaining({ optionId: option.id, sourceS2StageExecutionId: expect.any(String), positionTitle: 'رئيس قسم', displayOrder: 0 }),
      expect.objectContaining({ optionId: alternative.id, sourceS2StageExecutionId: expect.any(String), positionTitle: 'مدير إدارة بديل', displayOrder: 1 })
    ])
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentPositionOptions.some(position => position.optionId === alternative.id)).toBe(true)
    expect(snapshot.rows[0]!.payload.candidates[0]!.secondmentPreparation).toMatchObject({ lastPromotionReport: 'تقرير آخر ترقية مجمد', jobCategoryCode: 'MANAGER', jobCategoryName: 'وظيفة مدير إدارة :-' })
    expect(snapshot.rows[0]!.payload.candidates[0]!.candidateNotes).toEqual(['ملاحظة مرشح أولى', 'ملاحظة مرشح ثانية'])
    expect(snapshot.rows[0]!.payload.signoffs.map(s => s.stageCode)).toEqual(['S1', 'S2', 'S3'])
    await expect(fx.pool.query('SELECT id FROM workflow_signoff WHERE stage_execution_id=$1', [s5.id])).resolves.toMatchObject({ rowCount: 0 })
    await fx.pool.query("UPDATE secondment_position_option SET position_title='mutated' WHERE id=$1", [alternative.id])
    await fx.pool.query("UPDATE qualification_status_reference SET name='mutated' WHERE code='QUALIFIED'")
    await fx.pool.query("UPDATE request_candidate SET accepted_data='{}'::jsonb WHERE request_id=$1", [request.requestId])
    await fx.pool.query("UPDATE job_category_reference SET name='mutated' WHERE code='MANAGER'")
    await expect(fx.pool.query<{ payload: typeof snapshot.rows[0]['payload'] }>('SELECT payload FROM final_form_snapshot WHERE request_id=$1', [request.requestId])).resolves.toMatchObject({ rows: [expect.objectContaining({ payload: snapshot.rows[0]!.payload })] })
    expect(s3.stageCode).toBe('S3')
  })
})
