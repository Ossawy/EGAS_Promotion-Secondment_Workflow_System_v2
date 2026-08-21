import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPhase6Fixture, type Phase6Fixture } from './helpers/phase6-fixture.ts'

let fx: Phase6Fixture
beforeEach(async () => { fx = await createPhase6Fixture() })
afterEach(async () => { await fx.cleanup() })

async function promotionAtP4(decision: 'SAME_POSITION' | 'OTHER_POSITION' = 'SAME_POSITION') {
  const request = await fx.createRequest('PROMOTION')
  const hr = await fx.upload(fx.users.hrManager); await fx.sign(request.stageExecutionId, fx.users.hrManager, String(hr.id))
  const p2 = await fx.currentExecution(request.requestId); const org = await fx.upload(fx.users.orgManager); await fx.sign(p2.id, fx.users.orgManager, String(org.id))
  const p3 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p3.id, fx.users.hrManager)
  const p4 = await fx.currentExecution(request.requestId)
  await fx.promotion.upsertDecision(p4.id, request.candidateId, decision === 'SAME_POSITION'
    ? { decisionType: decision, recommendation: 'يوصى بالترقية' }
    : { decisionType: decision, targetJobTitle: 'وظيفة مستهدفة', recommendation: 'يوصى بالنقل' }, fx.users.authManager)
  return { request, p4 }
}

async function secondmentAtS2() {
  const request = await fx.createRequest('SECONDMENT')
  const hr = await fx.upload(fx.users.hrManager); await fx.sign(request.stageExecutionId, fx.users.hrManager, String(hr.id))
  return { request, s2: await fx.currentExecution(request.requestId) }
}

describe('Phase 6 signing readiness', () => {
  it.each(['P1', 'P2', 'P4', 'S1', 'S2', 'S3'])('generic approval rejects signing stage %s with SIGNATURE_REQUIRED', async stage => {
    const request = await fx.createRequest(stage.startsWith('P') ? 'PROMOTION' : 'SECONDMENT')
    const unit = stage.startsWith('S') ? fx.users.hrManager : fx.users.hrManager
    if (stage !== request.stageExecutionId) {
      await fx.pool.query(`UPDATE stage_execution SET stage_code=$2 WHERE id=$1`, [request.stageExecutionId, stage])
      await fx.pool.query(`UPDATE workflow_request SET current_stage_code=$2 WHERE id=$1`, [request.requestId, stage])
    }
    await expect(fx.engine.approveAndAdvance(request.stageExecutionId, unit)).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
  })

  it('P3 advances normally without a signoff and creates a normal submission snapshot', async () => {
    const { request } = await promotionAtP4()
    const p4 = await fx.currentExecution(request.requestId)
    expect(p4.stageCode).toBe('P4')
    const p3Signoffs = await fx.pool.query("SELECT ws.id FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id WHERE se.stage_code='P3'")
    expect(p3Signoffs.rowCount).toBe(0)
  })

  it('P4 directs all SAME_POSITION candidates to P5 and freezes its decisions in signed evidence', async () => {
    const { request, p4 } = await promotionAtP4('SAME_POSITION')
    const asset = await fx.upload(fx.users.authManager); const next = await fx.sign(p4.id, fx.users.authManager, String(asset.id))
    const snapshot = await fx.pool.query<{ payload: { promotionDecisions: Array<{ decisionType: string, targetJobTitle: string | null }> } }>('SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id=$1', [p4.id])
    expect((next as { stageCode: string }).stageCode).toBe('P5')
    expect(snapshot.rows[0]!.payload.promotionDecisions).toEqual([expect.objectContaining({ decisionType: 'SAME_POSITION', targetJobTitle: null })])
  })

  it('P4 directs OTHER_POSITION to P4O and freezes the approved target job', async () => {
    const { p4 } = await promotionAtP4('OTHER_POSITION')
    const asset = await fx.upload(fx.users.authManager); const next = await fx.sign(p4.id, fx.users.authManager, String(asset.id))
    const snapshot = await fx.pool.query<{ payload: { promotionDecisions: Array<{ targetJobTitle: string }> } }>('SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id=$1', [p4.id])
    expect((next as { stageCode: string }).stageCode).toBe('P4O')
    expect(snapshot.rows[0]!.payload.promotionDecisions[0]!.targetJobTitle).toBe('وظيفة مستهدفة')
  })

  it('P4O advances without a second signoff', async () => {
    const { request, p4 } = await promotionAtP4('OTHER_POSITION')
    const asset = await fx.upload(fx.users.authManager); await fx.sign(p4.id, fx.users.authManager, String(asset.id))
    const p4o = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p4o.id, fx.users.orgManager)
    await expect(fx.pool.query('SELECT ws.id FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id WHERE se.stage_code=$1', ['P4O'])).resolves.toMatchObject({ rowCount: 0 })
  })

  it('returned P4 is superseded by a fresh P4 execution whose signoff has separate frozen evidence', async () => {
    const { request, p4 } = await promotionAtP4('SAME_POSITION')
    const first = await fx.upload(fx.users.authManager); await fx.sign(p4.id, fx.users.authManager, String(first.id))
    const p5 = await fx.currentExecution(request.requestId); await fx.engine.returnPreviousStage(p5.id, { reason: 'إعادة مراجعة' }, fx.users.hrManager)
    const replacement = await fx.currentExecution(request.requestId)
    await fx.promotion.upsertDecision(replacement.id, request.candidateId, { decisionType: 'OTHER_POSITION', targetJobTitle: 'وظيفة معدلة', recommendation: 'تعديل' }, fx.users.authManager)
    const second = await fx.upload(fx.users.authManager, 'jpeg'); await fx.sign(replacement.id, fx.users.authManager, String(second.id))
    const snapshots = await fx.pool.query<{ stage_execution_id: string, payload: { promotionDecisions: Array<{ targetJobTitle: string | null }> } }>(`SELECT ss.stage_execution_id,ss.payload FROM stage_submission_snapshot ss JOIN stage_execution se ON se.id=ss.stage_execution_id WHERE se.stage_code='P4' ORDER BY se.execution_no`)
    expect(snapshots.rows).toHaveLength(2)
    expect(snapshots.rows.map(row => row.payload.promotionDecisions[0]!.targetJobTitle)).toEqual([null, 'وظيفة معدلة'])
  })

  it('S2 cannot sign without valid options, then freezes the authoritative option and its source execution', async () => {
    const { request, s2 } = await secondmentAtS2(); const asset = await fx.upload(fx.users.orgManager)
    await expect(fx.sign(s2.id, fx.users.orgManager, String(asset.id))).rejects.toMatchObject({ code: 'SECONDMENT_LAST_PROMOTION_REPORT_REQUIRED' })
    await fx.prepareSecondment(s2.id, request.candidateId)
    await expect(fx.sign(s2.id, fx.users.orgManager, String(asset.id))).rejects.toMatchObject({ code: 'SECONDMENT_OPTIONS_REQUIRED' })
    const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await fx.sign(s2.id, fx.users.orgManager, String(asset.id))
    const snapshot = await fx.pool.query<{ payload: { secondmentPositionOptions: Array<{ lastPromotionReport: string, jobCategoryCode: string, jobCategoryName: string, options: Array<{ id: string, sourceStageExecutionId: string }> }> } }>('SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id=$1', [s2.id])
    expect(snapshot.rows[0]!.payload.secondmentPositionOptions[0]).toMatchObject({ lastPromotionReport: 'تقرير آخر ترقية مجمد', jobCategoryCode: 'MANAGER', jobCategoryName: 'وظيفة مدير إدارة :-' })
    expect(snapshot.rows[0]!.payload.secondmentPositionOptions[0]!.options[0]).toMatchObject({ id: option.id, sourceStageExecutionId: s2.id })
  })

  it('S2 rejects missing or inactive job categories during preparation', async () => {
    const { request, s2 } = await secondmentAtS2()
    await expect(fx.secondment.upsertS2CandidatePreparation(s2.id, request.candidateId, { lastPromotionReport: 'تقرير', jobCategoryCode: 'MISSING' }, fx.users.orgManager)).rejects.toMatchObject({ code: 'INVALID_JOB_CATEGORY' })
    await fx.pool.query("UPDATE job_category_reference SET is_active=FALSE WHERE code='MANAGER'")
    await expect(fx.secondment.upsertS2CandidatePreparation(s2.id, request.candidateId, { lastPromotionReport: 'تقرير', jobCategoryCode: 'MANAGER' }, fx.users.orgManager)).rejects.toMatchObject({ code: 'INVALID_JOB_CATEGORY' })
  })

  it('S2 cannot sign when the saved preparation has no job category', async () => {
    const { request, s2 } = await secondmentAtS2(); const asset = await fx.upload(fx.users.orgManager)
    const candidateResult = await fx.pool.query<{ acceptedData: Record<string, unknown> | null }>(
      'SELECT accepted_data AS "acceptedData" FROM request_candidate WHERE id=$1',
      [request.candidateId]
    )
    const existingAcceptedData = candidateResult.rows[0]?.acceptedData ?? {}
    await fx.pool.query(
      'UPDATE request_candidate SET accepted_data=$2::jsonb WHERE id=$1',
      [
        request.candidateId,
        JSON.stringify({
          ...existingAcceptedData,
          secondmentS2Preparation: { lastPromotionReport: 'تقرير مجمد' }
        })
      ]
    )
    await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await expect(fx.sign(s2.id, fx.users.orgManager, String(asset.id))).rejects.toMatchObject({ code: 'SECONDMENT_JOB_CATEGORY_REQUIRED' })
  })

  it('S3 requires one authoritative selection per candidate and freezes code and display name', async () => {
    const { request, s2 } = await secondmentAtS2(); const orgAsset = await fx.upload(fx.users.orgManager)
    await fx.prepareSecondment(s2.id, request.candidateId)
    const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await fx.sign(s2.id, fx.users.orgManager, String(orgAsset.id))
    const s3 = await fx.currentExecution(request.requestId); const authAsset = await fx.upload(fx.users.authManager)
    await expect(fx.sign(s3.id, fx.users.authManager, String(authAsset.id))).rejects.toMatchObject({ code: 'SECONDMENT_SELECTION_MISSING' })
    await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: option.id }, fx.users.authManager)
    await fx.sign(s3.id, fx.users.authManager, String(authAsset.id))
    const snapshot = await fx.pool.query<{ payload: { secondmentSelections: Array<{ qualificationStatusCode: string, qualificationStatusName: string }> } }>('SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id=$1', [s3.id])
    expect(snapshot.rows[0]!.payload.secondmentSelections[0]).toMatchObject({ qualificationStatusCode: 'QUALIFIED', qualificationStatusName: 'مستوفٍ' })
  })

  it('S4 advances without a signoff after S3 and cannot rewrite the frozen selection evidence', async () => {
    const { request, s2 } = await secondmentAtS2(); const oa = await fx.upload(fx.users.orgManager)
    await fx.prepareSecondment(s2.id, request.candidateId)
    const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await fx.sign(s2.id, fx.users.orgManager, String(oa.id)); const s3 = await fx.currentExecution(request.requestId); const aa = await fx.upload(fx.users.authManager)
    await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: option.id }, fx.users.authManager); await fx.sign(s3.id, fx.users.authManager, String(aa.id))
    const s4 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(s4.id, fx.users.orgManager)
    await expect(fx.pool.query("SELECT ws.id FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id WHERE se.stage_code='S4'")).resolves.toMatchObject({ rowCount: 0 })
  })

  it('does not re-resolve a qualification display name after an S3 snapshot is signed', async () => {
    const { request, s2 } = await secondmentAtS2(); const oa = await fx.upload(fx.users.orgManager)
    await fx.prepareSecondment(s2.id, request.candidateId)
    const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await fx.sign(s2.id, fx.users.orgManager, String(oa.id)); const s3 = await fx.currentExecution(request.requestId); const aa = await fx.upload(fx.users.authManager)
    await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: option.id }, fx.users.authManager); await fx.sign(s3.id, fx.users.authManager, String(aa.id))
    await fx.pool.query("UPDATE qualification_status_reference SET name='تغيير لاحق' WHERE code='QUALIFIED'")
    await expect(fx.pool.query<{ payload: { secondmentSelections: Array<{ qualificationStatusName: string }> } }>('SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id=$1', [s3.id])).resolves.toMatchObject({ rows: [expect.objectContaining({ payload: expect.objectContaining({ secondmentSelections: [expect.objectContaining({ qualificationStatusName: 'مستوفٍ' })] }) })] })
  })
})
