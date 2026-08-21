import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signaturePassword } from '../src/modules/auth/current-password-verifier.ts'
import { createPhase6Fixture, phase6Password, type Phase6Fixture } from './helpers/phase6-fixture.ts'

let fx: Phase6Fixture
beforeEach(async () => { fx = await createPhase6Fixture() })
afterEach(async () => { await fx.cleanup() })

describe('Phase 6 signing reauthentication and authority', () => {
  it('preserves raw password content while enforcing the approved boundary', () => {
    expect(signaturePassword(' pass word ')).toBe(' pass word ')
    expect(() => signaturePassword('short')).toThrow()
  })

  it.each([
    ['PROMOTION', 'P1', 'hrManager'],
    ['SECONDMENT', 'S1', 'hrManager']
  ] as const)('signs %s %s with the current HR manager and freezes one signoff', async (requestType, stage, userKey) => {
    const request = await fx.createRequest(requestType)
    const user = fx.users[userKey]
    const asset = await fx.upload(user)
    const next = await fx.sign(request.stageExecutionId, user, String(asset.id))
    const signoffs = await fx.pool.query<{ manager_assignment_id: string, signer_snapshot: Record<string, unknown> }>('SELECT manager_assignment_id,signer_snapshot FROM workflow_signoff WHERE stage_execution_id=$1', [request.stageExecutionId])
    expect((next as { stageCode: string }).stageCode).toBe(requestType === 'PROMOTION' ? 'P2' : 'S2')
    expect(signoffs.rows).toHaveLength(1)
    expect(signoffs.rows[0]!.signer_snapshot).toMatchObject({ operationalUnitKind: 'HR', signerUserId: user.userId })
  })

  it('rejects a subordinate and ADMIN account even when each supplies an owned signature', async () => {
    const request = await fx.createRequest('PROMOTION')
    const subordinateAsset = await fx.upload(fx.users.hrSubordinate)
    await expect(fx.sign(request.stageExecutionId, fx.users.hrSubordinate, String(subordinateAsset.id))).rejects.toMatchObject({ code: 'UNIT_MANAGER_REQUIRED' })
    const adminAsset = await fx.upload(fx.users.admin)
    await expect(fx.sign(request.stageExecutionId, fx.users.admin, String(adminAsset.id))).rejects.toMatchObject({ code: 'OPERATIONAL_REQUIRED' })
  })

  it('rejects a manager from the wrong responsible unit and a replaced manager', async () => {
    const request = await fx.createRequest('PROMOTION')
    const orgAsset = await fx.upload(fx.users.orgManager)
    await expect(fx.sign(request.stageExecutionId, fx.users.orgManager, String(orgAsset.id))).rejects.toMatchObject({ code: 'UNIT_MANAGER_REQUIRED' })
    const replacement = await fx.createUser('hr.replacement')
    await fx.addMembership(replacement.userId, fx.units.hr)
    await fx.replaceManager(fx.units.hr, replacement.userId)
    const oldAsset = await fx.upload(fx.users.hrManager)
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(oldAsset.id))).rejects.toMatchObject({ code: 'UNIT_MANAGER_REQUIRED' })
  })

  it('rejects an inactive signer and a stale stage execution before any signoff is created', async () => {
    const request = await fx.createRequest('PROMOTION')
    const asset = await fx.upload(fx.users.hrManager)
    await fx.pool.query('UPDATE user_account SET is_active=FALSE WHERE id=$1', [fx.users.hrManager.userId])
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))).rejects.toMatchObject({ code: 'OPERATIONAL_REQUIRED' })
    await fx.pool.query('UPDATE user_account SET is_active=TRUE WHERE id=$1', [fx.users.hrManager.userId])
    await fx.pool.query("UPDATE stage_execution SET status='RETURNED' WHERE id=$1", [request.stageExecutionId])
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))).rejects.toMatchObject({ code: expect.stringMatching(/STAGE|CURRENT/) })
    await expect(fx.pool.query('SELECT id FROM workflow_signoff')).resolves.toMatchObject({ rowCount: 0 })
  })

  it('checks the owned active asset before password verification and rejects missing, foreign, and inactive assets', async () => {
    const request = await fx.createRequest('PROMOTION')
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, randomUUID(), 'wrong-password')).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_INVALID' })
    const foreign = await fx.upload(fx.users.orgManager)
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(foreign.id), 'wrong-password')).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_INVALID' })
    const own = await fx.upload(fx.users.hrManager)
    await fx.assets.deactivateSignature(fx.users.hrManager.userId, String(own.id))
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(own.id), 'wrong-password')).rejects.toMatchObject({ code: 'SIGNATURE_ASSET_INVALID' })
  })

  it('records a password rejection without workflow mutation or password leakage', async () => {
    const request = await fx.createRequest('PROMOTION')
    const asset = await fx.upload(fx.users.hrManager)
    const secret = 'IncorrectPassword99!'
    const before = await fx.pool.query<{ version: number, status: string, current_stage_code: string }>('SELECT version,status,current_stage_code FROM workflow_request WHERE id=$1', [request.requestId])
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id), secret)).rejects.toMatchObject({ code: 'SIGNATURE_PASSWORD_INVALID' })
    const [signoffs, snapshots, execution, requestRow, events, actions, audits] = await Promise.all([
      fx.pool.query('SELECT id FROM workflow_signoff WHERE stage_execution_id=$1', [request.stageExecutionId]),
      fx.pool.query('SELECT id FROM stage_submission_snapshot WHERE stage_execution_id=$1', [request.stageExecutionId]),
      fx.pool.query<{ status: string }>('SELECT status FROM stage_execution WHERE id=$1', [request.stageExecutionId]),
      fx.pool.query<{ version: number, status: string, current_stage_code: string }>('SELECT version,status,current_stage_code FROM workflow_request WHERE id=$1', [request.requestId]),
      fx.pool.query<{ details: unknown }>("SELECT details FROM security_event WHERE event_type='SIGNATURE_PASSWORD_REJECTED'"),
      fx.pool.query<{ payload: unknown }>('SELECT payload FROM stage_action WHERE stage_execution_id=$1', [request.stageExecutionId]),
      fx.pool.query<{ details: unknown }>('SELECT details FROM audit_event')
    ])
    expect(signoffs.rowCount).toBe(0); expect(snapshots.rowCount).toBe(0); expect(execution.rows[0]!.status).toBe('OPEN'); expect(requestRow.rows[0]).toEqual(before.rows[0])
    expect(JSON.stringify([events.rows, actions.rows, audits.rows])).not.toContain(secret)
  })

  it('freezes manager assignment, unit, title fallback and override without changing the account title', async () => {
    const request = await fx.createRequest('PROMOTION')
    const asset = await fx.upload(fx.users.hrManager)
    await fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id), phase6Password, 'القائم بالأعمال')
    const row = await fx.pool.query<{ signer_snapshot: Record<string, unknown>, manager_assignment_id: string }>('SELECT signer_snapshot,manager_assignment_id FROM workflow_signoff WHERE stage_execution_id=$1', [request.stageExecutionId])
    expect(row.rows[0]!.signer_snapshot).toMatchObject({ signerJobTitle: 'القائم بالأعمال', jobTitleWasOverridden: true, operationalUnitId: fx.units.hr, managerAssignmentId: row.rows[0]!.manager_assignment_id })
    await expect(fx.pool.query<{ job_title: string }>('SELECT job_title FROM user_account WHERE id=$1', [fx.users.hrManager.userId])).resolves.toMatchObject({ rows: [{ job_title: 'مدير الموارد البشرية' }] })
  })

  it('fails closed when neither a stored title nor an override is effective', async () => {
    const request = await fx.createRequest('PROMOTION')
    await fx.pool.query('UPDATE user_account SET job_title=NULL WHERE id=$1', [fx.users.hrManager.userId])
    const asset = await fx.upload(fx.users.hrManager)
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))).rejects.toMatchObject({ code: 'SIGNER_JOB_TITLE_REQUIRED' })
  })

  it('rejects duplicate signing on the same completed execution without a second immutable signoff', async () => {
    const request = await fx.createRequest('PROMOTION'); const asset = await fx.upload(fx.users.hrManager)
    await fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))
    await expect(fx.sign(request.stageExecutionId, fx.users.hrManager, String(asset.id))).rejects.toMatchObject({ code: expect.stringMatching(/CURRENT|STAGE|SIGNOFF/) })
    await expect(fx.pool.query('SELECT id FROM workflow_signoff WHERE stage_execution_id=$1', [request.stageExecutionId])).resolves.toMatchObject({ rowCount: 1 })
  })

  it('creates authoritative P1, P2, and P4 signoffs only for their responsible managers', async () => {
    const request = await fx.createRequest('PROMOTION')
    const h = await fx.upload(fx.users.hrManager); await fx.sign(request.stageExecutionId, fx.users.hrManager, String(h.id))
    const p2 = await fx.currentExecution(request.requestId); const o = await fx.upload(fx.users.orgManager); await fx.sign(p2.id, fx.users.orgManager, String(o.id))
    const p3 = await fx.currentExecution(request.requestId); await fx.engine.approveAndAdvance(p3.id, fx.users.hrManager)
    const p4 = await fx.currentExecution(request.requestId); await fx.promotion.upsertDecision(p4.id, request.candidateId, { decisionType: 'SAME_POSITION', recommendation: 'اختبار' }, fx.users.authManager)
    const a = await fx.upload(fx.users.authManager); await fx.sign(p4.id, fx.users.authManager, String(a.id))
    const signoffs = await fx.pool.query<{ stage_code: string, signer_user_id: string }>(`SELECT se.stage_code,ws.signer_user_id FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id ORDER BY se.stage_code`)
    expect(signoffs.rows).toEqual([
      { stage_code: 'P1', signer_user_id: fx.users.hrManager.userId },
      { stage_code: 'P2', signer_user_id: fx.users.orgManager.userId },
      { stage_code: 'P4', signer_user_id: fx.users.authManager.userId }
    ])
  })

  it('creates authoritative S1, S2, and S3 signoffs only after each readiness condition is met', async () => {
    const request = await fx.createRequest('SECONDMENT')
    const h = await fx.upload(fx.users.hrManager); await fx.sign(request.stageExecutionId, fx.users.hrManager, String(h.id))
    const s2 = await fx.currentExecution(request.requestId); const o = await fx.upload(fx.users.orgManager)
    await fx.prepareSecondment(s2.id, request.candidateId)
    const option = await fx.secondment.addPositionOption(s2.id, request.candidateId, { positionTitle: 'رئيس قسم', organizationalDependency: 'إدارة الاختبار', qualificationStatus: 'QUALIFIED' }, fx.users.orgManager)
    await fx.sign(s2.id, fx.users.orgManager, String(o.id)); const s3 = await fx.currentExecution(request.requestId); const a = await fx.upload(fx.users.authManager)
    await fx.secondment.upsertSelection(s3.id, request.candidateId, { selectedOptionId: option.id }, fx.users.authManager); await fx.sign(s3.id, fx.users.authManager, String(a.id))
    await expect(fx.pool.query<{ stage_code: string }>(`SELECT se.stage_code FROM workflow_signoff ws JOIN stage_execution se ON se.id=ws.stage_execution_id ORDER BY se.stage_code`)).resolves.toMatchObject({ rows: [{ stage_code: 'S1' }, { stage_code: 'S2' }, { stage_code: 'S3' }] })
  })
})
