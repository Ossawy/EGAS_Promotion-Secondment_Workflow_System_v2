import { createHash } from 'node:crypto'
import type { Queryable } from '../../db/types.ts'
import { AppError } from '../../shared/errors.ts'

export const PROMOTION_TEMPLATE_V3 = 'EGAS-OFFICIAL-PROMOTION-AR-3.0'
export const SECONDMENT_TEMPLATE_BASELINE = 'EGAS-OFFICIAL-SECONDMENT-AR-BASELINE-1.0'

export type FinalFormSignoff = {
  stageCode: string
  stageExecutionId: string
  executionNo: number
  signerUserId: string
  signerName: string
  signerUsername: string
  signerJobTitle: string
  jobTitleWasOverridden: boolean
  operationalUnitId: string
  operationalUnitKind: string
  managerAssignmentId: string | null
  signatureAssetId: string
  signatureSha256: string
  signedAt: string
}

export type FinalFormSecondmentPositionOption = {
  optionId: string
  sourceS2StageExecutionId: string
  positionTitle: string
  organizationalDependency: string
  qualificationStatus: string
  qualificationStatusName: string | null
  displayOrder: number
}

export type FinalFormCandidate = {
  candidateId: string
  personnelNumber: string
  employeeName: string
  currentJobTitle: string
  currentJobStartDate: string | null
  sourceRoutingLabel: string | null
  subgroup: string | null
  department: string | null
  seniorityDate: string | null
  joiningDate: string | null
  experienceStartDate: string | null
  qualificationDate: string | null
  qualificationName: string | null
  qualificationInstitute: string | null
  performanceRating: string | null
  lastPromotionReport: string | null
  experience: { years: number | null, months: number | null, days: number | null, referenceDate: string | null }
  // Promotion decision outcome
  promotionDecision?: {
    decisionType: 'SAME_POSITION' | 'OTHER_POSITION'
    targetJobTitle: string | null
    effectiveNominatedJob: string | null
    recommendation: string | null
    notes: string | null
  }
  candidateNotes?: string[]
  // Secondment decision outcome
  secondmentPreparation?: {
    sourceS2StageExecutionId: string
    lastPromotionReport: string
    jobCategoryCode: string
    jobCategoryName: string
  }
  secondmentSelection?: {
    selectedOptionId: string
    positionTitle: string
    organizationalDependency: string
    qualificationStatus: string
    qualificationStatusName: string | null
  }
  secondmentPositionOptions?: FinalFormSecondmentPositionOption[]
}

export type FinalFormSnapshotPayload = {
  schemaVersion: 1
  kind: 'FINAL'
  templateVersion: string
  requestId: string
  requestNumber: string
  requestType: 'PROMOTION' | 'SECONDMENT'
  routingUnit: {
    id: string
    code: string
    nameAr: string
  } | null
  iterationId: string
  iterationNo: number
  cycleYear: number | null
  capturedAt: string
  candidates: FinalFormCandidate[]
  signoffs: FinalFormSignoff[]
  p4oConfirmation?: {
    stageExecutionId: string
    confirmedAt: string
    confirmedByUserId: string
  }
  s4Confirmation?: {
    stageExecutionId: string
    confirmedAt: string
    confirmedByUserId: string
  }
}

export function canonicalJson(value: unknown): string {
  function sortKeys(val: unknown): unknown {
    if (Array.isArray(val)) return val.map(sortKeys)
    if (val !== null && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sortKeys(v)])
      )
    }
    return val
  }
  return JSON.stringify(sortKeys(value))
}

export function computeSnapshotSha256(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export async function buildFinalFormSnapshot(
  db: Queryable,
  requestId: string,
  iterationId: string,
  requestType: 'PROMOTION' | 'SECONDMENT'
): Promise<{ payload: FinalFormSnapshotPayload, sha256: string, templateVersion: string }> {
  // 1. Request details
  const requestResult = await db.query<{
    id: string
    requestNumber: string
    requestType: 'PROMOTION' | 'SECONDMENT'
    routingUnitId: string | null
    routingUnitCode: string | null
    routingUnitNameAr: string | null
    iterationId: string
    iterationNo: number
  }>(
    `SELECT r.id,
            r.request_number AS "requestNumber",
            r.request_type AS "requestType",
            r.routing_unit_id AS "routingUnitId",
            ru.code AS "routingUnitCode",
            ru.name_ar AS "routingUnitNameAr",
            i.id AS "iterationId",
            i.iteration_no AS "iterationNo"
       FROM workflow_request r
       JOIN workflow_iteration i ON i.request_id = r.id AND i.id = $2
       LEFT JOIN routing_unit ru ON ru.id = r.routing_unit_id
      WHERE r.id = $1`,
    [requestId, iterationId]
  )

  const reqRow = requestResult.rows[0]
  if (!reqRow) {
    throw new AppError(404, 'Workflow request or iteration not found', 'WORKFLOW_REQUEST_NOT_FOUND')
  }

  // 2. Authoritative Signoffs from current iteration
  const requiredSigningStages = requestType === 'PROMOTION'
    ? ['P1', 'P2', 'P4']
    : ['S1', 'S2', 'S3']

  const signoffsResult = await db.query<{
    stageCode: string
    stageExecutionId: string
    executionNo: number
    signerUserId: string
    signerName: string
    signerUsername: string
    signerJobTitle: string
    jobTitleWasOverridden: boolean
    operationalUnitId: string
    operationalUnitKind: string
    managerAssignmentId: string | null
    signatureAssetId: string
    signatureSha256: string
    signedAt: Date
  }>(
    `SELECT DISTINCT ON (se.stage_code)
            se.stage_code AS "stageCode",
            se.id AS "stageExecutionId",
            se.execution_no AS "executionNo",
            ws.signer_user_id AS "signerUserId",
            ws.signer_snapshot->>'signerName' AS "signerName",
            ws.signer_snapshot->>'signerUsername' AS "signerUsername",
            ws.signer_snapshot->>'signerJobTitle' AS "signerJobTitle",
            (ws.signer_snapshot->>'jobTitleWasOverridden')::boolean AS "jobTitleWasOverridden",
            ws.signer_snapshot->>'operationalUnitId' AS "operationalUnitId",
            ws.signer_snapshot->>'operationalUnitKind' AS "operationalUnitKind",
            ws.manager_assignment_id AS "managerAssignmentId",
            ws.signature_asset_id AS "signatureAssetId",
            ws.signature_sha256 AS "signatureSha256",
            ws.signed_at AS "signedAt"
       FROM stage_execution se
       JOIN workflow_signoff ws ON ws.stage_execution_id = se.id
      WHERE se.iteration_id = $1
        AND se.status = 'COMPLETED'
        AND se.stage_code = ANY($2)
      ORDER BY se.stage_code, se.execution_no DESC`,
    [iterationId, requiredSigningStages]
  )

  const signoffMap = new Map<string, typeof signoffsResult.rows[0]>()
  for (const s of signoffsResult.rows) {
    signoffMap.set(s.stageCode, s)
  }

  for (const stage of requiredSigningStages) {
    if (!signoffMap.has(stage)) {
      throw new AppError(
        409,
        `Authoritative signoff for stage ${stage} is missing in current iteration`,
        'AUTHORITATIVE_SIGNOFF_MISSING'
      )
    }
  }

  const signoffs: FinalFormSignoff[] = requiredSigningStages.map(stage => {
    const s = signoffMap.get(stage)!
    return {
      stageCode: s.stageCode,
      stageExecutionId: s.stageExecutionId,
      executionNo: Number(s.executionNo),
      signerUserId: s.signerUserId,
      signerName: s.signerName ?? '',
      signerUsername: s.signerUsername ?? '',
      signerJobTitle: s.signerJobTitle ?? '',
      jobTitleWasOverridden: Boolean(s.jobTitleWasOverridden),
      operationalUnitId: s.operationalUnitId ?? '',
      operationalUnitKind: s.operationalUnitKind ?? '',
      managerAssignmentId: s.managerAssignmentId,
      signatureAssetId: s.signatureAssetId,
      signatureSha256: s.signatureSha256,
      signedAt: new Date(s.signedAt).toISOString()
    }
  })

  // 3. Candidates and decisions/selections
  const candidatesResult = await db.query<{
    candidateId: string
    personnelNumber: string
    employeeData: Record<string, unknown>
    snapshotYear: number | null
  }>(
    `SELECT rc.id AS "candidateId",
            eas.personnel_number AS "personnelNumber",
            rc.frozen_data AS "employeeData",
            eas.snapshot_year AS "snapshotYear"
       FROM request_candidate rc
       JOIN employee_annual_snapshot eas ON eas.id = rc.employee_snapshot_id
      WHERE rc.request_id = $1
      ORDER BY eas.personnel_number, rc.id`,
    [requestId]
  )

  if (candidatesResult.rows.length === 0) {
    throw new AppError(400, 'Request must contain at least one candidate', 'CANDIDATES_REQUIRED')
  }

  let cycleYear: number | null = candidatesResult.rows[0]?.snapshotYear ?? null

  const candidates: FinalFormCandidate[] = []

  if (requestType === 'PROMOTION') {
    // Resolve authoritative P4 decisions from latest completed P4 execution in current iteration
    const p4Signoff = signoffMap.get('P4')!
    const signedSnapshot = await db.query<{ payload: { promotionDecisions?: Array<{ candidateId: string, decisionType: 'SAME_POSITION' | 'OTHER_POSITION', targetJobTitle: string | null, recommendation: string | null, notes: string | null }> } }>(
      `SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id = $1`, [p4Signoff.stageExecutionId]
    )
    const decisions = signedSnapshot.rows[0]?.payload?.promotionDecisions
    if (!decisions) throw new AppError(409, 'Signed P4 decision evidence is missing', 'P4_SIGNED_EVIDENCE_MISSING')
    const decisionMap = new Map<string, typeof decisions[0]>()
    for (const d of decisions) decisionMap.set(d.candidateId, d)

    for (const c of candidatesResult.rows) {
      const empData = c.employeeData ?? {}
      const dec = decisionMap.get(c.candidateId)

      if (!dec) {
        throw new AppError(409, `Authoritative P4 decision missing for candidate ${c.personnelNumber}`, 'P4_DECISION_MISSING')
      }

      const sourceRoutingLabel = typeof empData.sourceRoutingLabel === 'string' && empData.sourceRoutingLabel.trim()
        ? empData.sourceRoutingLabel.trim()
        : null

      // The official general-administration field is the workbook's immutable
      // source routing label, never an inferred or mutable department value.
      if (!sourceRoutingLabel) {
        throw new AppError(
          400,
          `Candidate ${c.personnelNumber} is missing required frozen source routing label for Promotion V3`,
          'PROMOTION_DEPARTMENT_REQUIRED'
        )
      }

      const isSame = dec.decisionType === 'SAME_POSITION'
      const currentJob = typeof empData.currentJobTitle === 'string' ? empData.currentJobTitle.trim() : ''

      candidates.push({
        candidateId: c.candidateId,
        personnelNumber: c.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        currentJobTitle: currentJob,
        sourceRoutingLabel,
        subgroup: typeof empData.subgroup === 'string' ? empData.subgroup : null,
        department: null,
        seniorityDate: typeof empData.lastPromotionDate === 'string' ? empData.lastPromotionDate : null,
        currentJobStartDate: typeof empData.currentJobStartDate === 'string' ? empData.currentJobStartDate : null,
        joiningDate: typeof empData.joiningDate === 'string' ? empData.joiningDate : null,
        experienceStartDate: typeof empData.experienceStartDate === 'string' ? empData.experienceStartDate : null,
        qualificationDate: typeof empData.originalQualificationDate === 'string' ? empData.originalQualificationDate : null,
        qualificationName: typeof empData.originalQualificationCertificate === 'string' ? empData.originalQualificationCertificate : null,
        qualificationInstitute: typeof empData.originalQualificationSource === 'string' ? empData.originalQualificationSource : null,
        performanceRating: typeof empData.performanceRating === 'string' ? empData.performanceRating : null,
        lastPromotionReport: typeof empData.lastPromotionReport === 'string' ? empData.lastPromotionReport : null,
        experience: { years: typeof empData.experienceYears === 'number' ? empData.experienceYears : null, months: typeof empData.experienceMonths === 'number' ? empData.experienceMonths : null, days: typeof empData.experienceDays === 'number' ? empData.experienceDays : null, referenceDate: typeof empData.experienceReferenceDate === 'string' ? empData.experienceReferenceDate : null },
        promotionDecision: {
          decisionType: dec.decisionType,
          targetJobTitle: isSame ? null : dec.targetJobTitle,
          effectiveNominatedJob: isSame ? currentJob : dec.targetJobTitle,
          recommendation: dec.recommendation,
          notes: dec.notes
        }
      })
    }
  } else {
    // Secondment: resolve the authoritative S2 options and S3 selections from their
    // immutable signed submission snapshots in the current iteration.
    const s2Signoff = signoffMap.get('S2')!
    const s3Signoff = signoffMap.get('S3')!
    const s2Snapshot = await db.query<{ payload: { secondmentPositionOptions?: Array<{ candidateId: string, lastPromotionReport: string, jobCategoryCode: string, jobCategoryName: string, options: Array<{ id: string, sourceStageExecutionId: string, candidateId: string, positionTitle: string, organizationalDependency: string, qualificationStatusCode: string, qualificationStatusName: string | null, displayOrder: number }> }> } }>(
      `SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id = $1`, [s2Signoff.stageExecutionId]
    )
    const optionGroups = s2Snapshot.rows[0]?.payload?.secondmentPositionOptions
    if (!optionGroups) throw new AppError(409, 'Signed S2 option evidence is missing', 'S2_SIGNED_EVIDENCE_MISSING')

    const optionsByCandidate = new Map<string, FinalFormSecondmentPositionOption[]>()
    const preparationByCandidate = new Map<string, NonNullable<FinalFormCandidate['secondmentPreparation']>>()
    for (const group of optionGroups) {
      const options = group.options
        .filter(option => option.candidateId === group.candidateId && option.sourceStageExecutionId === s2Signoff.stageExecutionId)
        .map(option => ({
          optionId: option.id,
          sourceS2StageExecutionId: option.sourceStageExecutionId,
          positionTitle: option.positionTitle,
          organizationalDependency: option.organizationalDependency,
          qualificationStatus: option.qualificationStatusCode,
          qualificationStatusName: option.qualificationStatusName,
          displayOrder: Number(option.displayOrder)
        }))
        .sort((left, right) => left.displayOrder - right.displayOrder || left.optionId.localeCompare(right.optionId))
      if (options.length !== group.options.length) {
        throw new AppError(409, 'Signed S2 option evidence has an invalid candidate or source execution', 'S2_OPTION_EVIDENCE_INVALID')
      }
      const lastPromotionReport = typeof group.lastPromotionReport === 'string' ? group.lastPromotionReport.trim() : ''
      const jobCategoryCode = typeof group.jobCategoryCode === 'string' ? group.jobCategoryCode.trim() : ''
      const jobCategoryName = typeof group.jobCategoryName === 'string' ? group.jobCategoryName.trim() : ''
      if (!lastPromotionReport || !jobCategoryCode || !jobCategoryName) {
        throw new AppError(409, 'Signed S2 preparation evidence is missing', 'S2_PREPARATION_EVIDENCE_MISSING')
      }
      optionsByCandidate.set(group.candidateId, options)
      preparationByCandidate.set(group.candidateId, {
        sourceS2StageExecutionId: s2Signoff.stageExecutionId,
        lastPromotionReport,
        jobCategoryCode,
        jobCategoryName
      })
    }

    const signedSnapshot = await db.query<{ payload: { secondmentSelections?: Array<{ candidateId: string, selectedOptionId: string, sourceS2StageExecutionId: string, positionTitle: string, organizationalDependency: string, qualificationStatusCode?: string, qualificationStatus?: string, qualificationStatusName: string | null }> } }>(
      `SELECT payload FROM stage_submission_snapshot WHERE stage_execution_id = $1`, [s3Signoff.stageExecutionId]
    )
    const selections = signedSnapshot.rows[0]?.payload?.secondmentSelections
    if (!selections) throw new AppError(409, 'Signed S3 selection evidence is missing', 'S3_SIGNED_EVIDENCE_MISSING')
    const selectionMap = new Map<string, typeof selections[0]>()
    for (const sel of selections) selectionMap.set(sel.candidateId, sel)

    const notesResult = await db.query<{ candidateId: string, body: string }>(
      `SELECT candidate_id AS "candidateId", body
         FROM workflow_note
        WHERE request_id = $1
          AND iteration_id = $2
          AND candidate_id IS NOT NULL
        ORDER BY created_at ASC, id ASC`,
      [requestId, iterationId]
    )
    const notesByCandidate = new Map<string, string[]>()
    for (const note of notesResult.rows) {
      const notes = notesByCandidate.get(note.candidateId) ?? []
      notes.push(note.body)
      notesByCandidate.set(note.candidateId, notes)
    }

    for (const c of candidatesResult.rows) {
      const empData = c.employeeData ?? {}
      const sel = selectionMap.get(c.candidateId)

      if (!sel) {
        throw new AppError(409, `Authoritative S3 selection missing for candidate ${c.personnelNumber}`, 'S3_SELECTION_MISSING')
      }
      const positionOptions = optionsByCandidate.get(c.candidateId)
      if (!positionOptions?.length) {
        throw new AppError(409, `Authoritative S2 options missing for candidate ${c.personnelNumber}`, 'S2_OPTIONS_MISSING')
      }
      const selectedOption = positionOptions.find(option => option.optionId === sel.selectedOptionId)
      if (!selectedOption || sel.sourceS2StageExecutionId !== s2Signoff.stageExecutionId) {
        throw new AppError(409, 'Selected option is not valid for the authoritative S2 to S3 chain', 'INVALID_OPTION_SELECTION')
      }
      const preparation = preparationByCandidate.get(c.candidateId)
      if (!preparation) {
        throw new AppError(409, `Authoritative S2 preparation missing for candidate ${c.personnelNumber}`, 'S2_PREPARATION_EVIDENCE_MISSING')
      }

      candidates.push({
        candidateId: c.candidateId,
        personnelNumber: c.personnelNumber,
        employeeName: String(empData.employeeName ?? ''),
        currentJobTitle: String(empData.currentJobTitle ?? ''),
        sourceRoutingLabel: typeof empData.sourceRoutingLabel === 'string' && empData.sourceRoutingLabel.trim() ? empData.sourceRoutingLabel.trim() : null,
        subgroup: typeof empData.subgroup === 'string' ? empData.subgroup : null,
        department: typeof empData.department === 'string' ? empData.department : null,
        seniorityDate: typeof empData.lastPromotionDate === 'string' ? empData.lastPromotionDate : null,
        currentJobStartDate: typeof empData.currentJobStartDate === 'string' ? empData.currentJobStartDate : null,
        joiningDate: typeof empData.joiningDate === 'string' ? empData.joiningDate : null,
        experienceStartDate: typeof empData.experienceStartDate === 'string' ? empData.experienceStartDate : null,
        qualificationDate: typeof empData.originalQualificationDate === 'string' ? empData.originalQualificationDate : null,
        qualificationName: typeof empData.originalQualificationCertificate === 'string' ? empData.originalQualificationCertificate : null,
        qualificationInstitute: typeof empData.originalQualificationSource === 'string' ? empData.originalQualificationSource : null,
        performanceRating: typeof empData.performanceRating === 'string' ? empData.performanceRating : null,
        lastPromotionReport: typeof empData.lastPromotionReport === 'string' ? empData.lastPromotionReport : null,
        experience: { years: typeof empData.experienceYears === 'number' ? empData.experienceYears : null, months: typeof empData.experienceMonths === 'number' ? empData.experienceMonths : null, days: typeof empData.experienceDays === 'number' ? empData.experienceDays : null, referenceDate: typeof empData.experienceReferenceDate === 'string' ? empData.experienceReferenceDate : null },
        candidateNotes: notesByCandidate.get(c.candidateId) ?? [],
        secondmentPreparation: preparation,
        secondmentSelection: {
          selectedOptionId: sel.selectedOptionId,
          positionTitle: selectedOption.positionTitle,
          organizationalDependency: selectedOption.organizationalDependency,
          qualificationStatus: selectedOption.qualificationStatus,
          qualificationStatusName: selectedOption.qualificationStatusName
        },
        secondmentPositionOptions: positionOptions
      })
    }
  }

  // 4. Check P4O or S4 confirmations if present
  let p4oConfirmation: FinalFormSnapshotPayload['p4oConfirmation']
  let s4Confirmation: FinalFormSnapshotPayload['s4Confirmation']

  if (requestType === 'PROMOTION') {
    const p4oExec = await db.query<{ id: string, completed_at: Date, actor_user_id: string }>(
      `SELECT se.id, se.completed_at, sa.actor_user_id
         FROM stage_execution se
         LEFT JOIN stage_action sa ON sa.stage_execution_id = se.id AND sa.action_type = 'STAGE_ADVANCED'
        WHERE se.iteration_id = $1 AND se.stage_code = 'P4O' AND se.status = 'COMPLETED'
        ORDER BY se.execution_no DESC
        LIMIT 1`,
      [iterationId]
    )
    if (p4oExec.rows[0]) {
      p4oConfirmation = {
        stageExecutionId: p4oExec.rows[0].id,
        confirmedAt: new Date(p4oExec.rows[0].completed_at).toISOString(),
        confirmedByUserId: p4oExec.rows[0].actor_user_id ?? ''
      }
    }
  } else {
    const s4Exec = await db.query<{ id: string, completed_at: Date, actor_user_id: string }>(
      `SELECT se.id, se.completed_at, sa.actor_user_id
         FROM stage_execution se
         LEFT JOIN stage_action sa ON sa.stage_execution_id = se.id AND sa.action_type = 'STAGE_ADVANCED'
        WHERE se.iteration_id = $1 AND se.stage_code = 'S4' AND se.status = 'COMPLETED'
        ORDER BY se.execution_no DESC
        LIMIT 1`,
      [iterationId]
    )
    if (s4Exec.rows[0]) {
      s4Confirmation = {
        stageExecutionId: s4Exec.rows[0].id,
        confirmedAt: new Date(s4Exec.rows[0].completed_at).toISOString(),
        confirmedByUserId: s4Exec.rows[0].actor_user_id ?? ''
      }
    }
  }

  const templateVersion = requestType === 'PROMOTION'
    ? PROMOTION_TEMPLATE_V3
    : SECONDMENT_TEMPLATE_BASELINE

  const payload: FinalFormSnapshotPayload = {
    schemaVersion: 1,
    kind: 'FINAL',
    templateVersion,
    requestId: reqRow.id,
    requestNumber: reqRow.requestNumber,
    requestType: reqRow.requestType,
    routingUnit: reqRow.routingUnitId && reqRow.routingUnitCode && reqRow.routingUnitNameAr ? {
      id: reqRow.routingUnitId,
      code: reqRow.routingUnitCode,
      nameAr: reqRow.routingUnitNameAr
    } : null,
    iterationId: reqRow.iterationId,
    iterationNo: Number(reqRow.iterationNo),
    cycleYear,
    capturedAt: new Date().toISOString(),
    candidates,
    signoffs,
    ...(p4oConfirmation ? { p4oConfirmation } : {}),
    ...(s4Confirmation ? { s4Confirmation } : {})
  }

  const sha256 = computeSnapshotSha256(payload)

  return { payload, sha256, templateVersion }
}
