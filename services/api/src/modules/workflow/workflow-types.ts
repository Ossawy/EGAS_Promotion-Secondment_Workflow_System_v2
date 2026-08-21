export type WorkflowRequestType = 'PROMOTION' | 'SECONDMENT'

export type WorkflowRequestStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'REJECTED_PENDING_HR_DECISION'
  | 'COMPLETED'
  | 'CANCELLED'

export type WorkflowIterationStatus =
  | 'ACTIVE'
  | 'REJECTED'
  | 'COMPLETED'

export type StageExecutionStatus =
  | 'OPEN'
  | 'COMPLETED'
  | 'RETURNED'
  | 'REJECTED'

export type StageWorkState =
  | 'MANAGER_INBOX'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'MANAGER_REVIEW'
  | 'CORRECTION_REQUIRED'
  | 'COMPLETED'

export type PromotionStageCode = 'P1' | 'P2' | 'P3' | 'P4' | 'P4O' | 'P5'
export type SecondmentStageCode = 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
export type StageCode = PromotionStageCode | SecondmentStageCode

export const SIGNING_STAGE_CODES = new Set<StageCode>(['P1', 'P2', 'P4', 'S1', 'S2', 'S3'])

export interface WorkflowRequestContext {
  userId: string
  username: string
}

export interface CreateRequestInput {
  requestType: WorkflowRequestType
  routingUnitId: string
}

export interface AddCandidateInput {
  personnelNumber: string
}

export interface AssignStageInput {
  assignedToUserId: string
  reason?: string
}

export interface InternalCorrectionInput {
  reason: string
}

export interface ReturnPreviousInput {
  reason: string
}

export interface RejectStageInput {
  reason: string
}

export interface AddNoteInput {
  body: string
  candidateId?: string
}

export interface SignAndAdvanceInput {
  password: string
  signatureAssetId: string
  jobTitleOverride?: string | null
}

export type PromotionDecisionType = 'SAME_POSITION' | 'OTHER_POSITION'

export interface UpsertPromotionDecisionInput {
  decisionType: PromotionDecisionType
  targetJobTitle?: string | null
  recommendation: string
  notes?: string | null
}

export interface PromotionDecisionSummary {
  id: string
  stageExecutionId: string
  candidateId: string
  personnelNumber: string
  employeeName: string
  decisionType: PromotionDecisionType
  targetJobTitle: string | null
  effectiveNominatedJob: string | null
  recommendation: string
  notes: string | null
}

export interface PromotionP4ValidationResult {
  nextStageCode: 'P5' | 'P4O'
  decisions: PromotionDecisionSummary[]
  hasOtherPosition: boolean
}

export interface SecondmentPositionOptionInput {
  positionTitle: string
  organizationalDependency: string
  qualificationStatus: string
}

export interface SecondmentS2PreparationInput {
  lastPromotionReport: string
  jobCategoryCode: string
}

export interface SecondmentS2PreparationSummary {
  candidateId: string
  lastPromotionReport: string
  jobCategoryCode: string
  jobCategoryName: string
}

export interface SecondmentPositionOptionSummary {
  id: string
  sourceStageExecutionId: string
  candidateId: string
  personnelNumber: string
  employeeName: string
  positionTitle: string
  organizationalDependency: string
  qualificationStatusCode: string
  qualificationStatusName: string | null
  displayOrder: number
}

export interface SecondmentSelectionInput {
  selectedOptionId: string
}

export interface SecondmentSelectionSummary {
  id: string
  stageExecutionId: string
  candidateId: string
  personnelNumber: string
  employeeName: string
  selectedOptionId: string
  positionTitle: string
  organizationalDependency: string
  qualificationStatusCode: string
  qualificationStatusName: string | null
  sourceS2StageExecutionId: string
}

export interface SecondmentS2CandidateOptionGroup {
  candidateId: string
  personnelNumber: string
  employeeName: string
  lastPromotionReport: string
  jobCategoryCode: string
  jobCategoryName: string
  options: SecondmentPositionOptionSummary[]
}

export interface SecondmentS2ValidationResult {
  stageCode: 'S2'
  candidateOptions: SecondmentS2CandidateOptionGroup[]
}

export interface SecondmentS3ValidationResult {
  nextStageCode: 'S4'
  selections: SecondmentSelectionSummary[]
}

export interface WorkflowSignoffSummary {
  id: string
  stageExecutionId: string
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

export interface WorkflowRequestSummary {
  id: string
  requestNumber: string
  requestType: WorkflowRequestType
  routingUnitId: string | null
  routingUnitNameAr: string | null
  routingUnitCode: string | null
  status: WorkflowRequestStatus
  currentIterationId: string | null
  currentIterationNo: number | null
  currentStageCode: StageCode | null
  currentExecutionId: string | null
  currentWorkState: StageWorkState | null
  currentResponsibleUnitId: string | null
  currentResponsibleUnitName: string | null
  version: number
  createdByUserId: string | null
  createdByUserDisplayName: string | null
  createdAt: string
  completedAt: string | null
  cancelledAt: string | null
}

export interface StageExecutionSummary {
  id: string
  iterationId: string
  iterationNo: number
  requestId: string
  requestNumber: string
  requestType: WorkflowRequestType
  routingUnitId: string | null
  routingUnitNameAr: string | null
  stageCode: StageCode
  executionNo: number
  responsibleUnitId: string
  responsibleUnitName: string
  responsibleUnitKind: string
  status: StageExecutionStatus
  workState: StageWorkState
  openedAt: string
  completedAt: string | null
  activeAssigneeUserId: string | null
  activeAssigneeDisplayName: string | null
  assignedAt: string | null
}

export interface RequestCandidateSummary {
  id: string
  requestId: string
  employeeSnapshotId: string
  personnelNumber: string
  employeeName: string
  currentJobTitle: string | null
  frozenData: Record<string, unknown>
  acceptedData: Record<string, unknown>
}

export interface WorkflowNoteSummary {
  id: string
  requestId: string
  candidateId: string | null
  iterationId: string | null
  stageExecutionId: string | null
  stageCode: StageCode | null
  authorUserId: string
  authorDisplayName: string
  unitId: string | null
  unitName: string | null
  body: string
  createdAt: string
}

export interface NotificationSummary {
  id: string
  recipientUserId: string
  requestId: string | null
  stageExecutionId: string | null
  notificationType: string
  isRead: boolean
  createdAt: string
  requestNumber?: string | null
  stageCode?: StageCode | null
}

export interface TimelineEvent {
  kind: 'ITERATION' | 'STAGE_EXECUTION' | 'WORK_ASSIGNMENT' | 'STAGE_ACTION' | 'NOTE' | 'SUBMISSION_SNAPSHOT' | 'REQUEST_STATUS'
  id: string
  timestamp: string
  title: string
  actorDisplayName?: string | null
  actorUserId?: string | null
  details?: Record<string, unknown>
}
