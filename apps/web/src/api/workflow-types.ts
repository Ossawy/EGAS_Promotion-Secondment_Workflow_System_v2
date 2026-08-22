export type WorkflowRequestType = 'PROMOTION' | 'SECONDMENT'
export type WorkflowRequestStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'REJECTED_PENDING_HR_DECISION'
  | 'COMPLETED'
  | 'CANCELLED'
export type StageExecutionStatus = 'OPEN' | 'COMPLETED' | 'RETURNED' | 'REJECTED'
export type StageWorkState =
  | 'MANAGER_INBOX'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'MANAGER_REVIEW'
  | 'CORRECTION_REQUIRED'
  | 'COMPLETED'

export type StageCode = 'P1' | 'P2' | 'P3' | 'P4' | 'P4O' | 'P5' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5'

export const SIGNING_STAGE_CODES: ReadonlySet<StageCode> = new Set(['P1', 'P2', 'P4', 'S1', 'S2', 'S3'])

export const STAGE_LABELS: Record<StageCode, string> = {
  P1: 'P1 — إعداد الموارد البشرية',
  P2: 'P2 — مراجعة الشؤون التنظيمية',
  P3: 'P3 — مراجعة الموارد البشرية',
  P4: 'P4 — قرار سلطة الاعتماد',
  P4O: 'P4O — تأكيد الجهة التنظيمية',
  P5: 'P5 — الإغلاق النهائي (الموارد البشرية)',
  S1: 'S1 — إعداد الموارد البشرية',
  S2: 'S2 — إعداد الوظائف المقترحة (التنظيم)',
  S3: 'S3 — اعتماد وظيفة الندب',
  S4: 'S4 — تأكيد الجهة التنظيمية',
  S5: 'S5 — المراجعة النهائية (الموارد البشرية)'
}

export const WORK_STATE_LABELS: Record<StageWorkState, string> = {
  MANAGER_INBOX: 'في صندوق المدير',
  ASSIGNED: 'مسند إلى موظف',
  IN_PROGRESS: 'قيد العمل',
  MANAGER_REVIEW: 'مراجعة المدير',
  CORRECTION_REQUIRED: 'مطلوب تصحيح من الموظف',
  COMPLETED: 'مكتملة'
}

export const REQUEST_STATUS_LABELS: Record<WorkflowRequestStatus, string> = {
  DRAFT: 'مسودة تحضير',
  ACTIVE: 'جاري التنفيذ',
  REJECTED_PENDING_HR_DECISION: 'مرفوض — بانتظار قرار الموارد البشرية',
  COMPLETED: 'مكتمل',
  CANCELLED: 'ملغي'
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

export interface CandidateLookupPreview {
  snapshotId: string
  personnelNumber: string
  snapshotYear: number
  routingUnitMatchesRequest: boolean
  alreadyAddedToRequest: boolean
  employeeName: string
  currentJobTitle: string | null
  frozenData: Record<string, unknown>
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
  suggestedAssigneeUserId?: string | null
  suggestedAssigneeDisplayName?: string | null
  correctionReason?: string | null
  correctionRequestedAt?: string | null
  correctionRequestedByUserId?: string | null
  correctionRequestedByDisplayName?: string | null
  correctionPreviousAssigneeUserId?: string | null
  correctionAssigneeUserId?: string | null
  managerHandledCorrectionPersonally?: boolean
}

export interface ManagerInboxResponse {
  stages: StageExecutionSummary[]
  rejectedRequests: WorkflowRequestSummary[]
}

export interface ManagerSubordinateOption {
  userId: string
  username: string
  displayName: string
  jobTitle: string | null
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

export interface TimelineEvent {
  kind: 'ITERATION' | 'STAGE_EXECUTION' | 'WORK_ASSIGNMENT' | 'STAGE_ACTION' | 'NOTE' | 'SUBMISSION_SNAPSHOT' | 'REQUEST_STATUS'
  id: string
  timestamp: string
  title: string
  actorDisplayName?: string | null
  actorUserId?: string | null
  details?: Record<string, unknown>
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

export type PromotionDecisionType = 'SAME_POSITION' | 'OTHER_POSITION'

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

export interface SecondmentPreparationSummary {
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
  organizationalDependency: string | null
  qualificationStatusCode: string
  qualificationStatusName: string | null
  displayOrder: number
}

export interface SecondmentSelectionSummary {
  id: string
  stageExecutionId: string
  candidateId: string
  personnelNumber: string
  employeeName: string
  selectedOptionId: string
  positionTitle: string
  organizationalDependency: string | null
  qualificationStatusCode: string
  qualificationStatusName: string | null
  sourceS2StageExecutionId: string
}

export interface WorkflowSignoffView {
  id: string
  stageExecutionId: string
  iterationNo: number
  stageCode: StageCode
  executionNo: number
  signerUserId: string
  signerDisplayName: string
  signerJobTitle: string
  jobTitleWasOverridden: boolean
  signatureAssetId: string | null
  signedAt: string
}

export interface RoutingUnitOption {
  id: string
  nameAr: string
  nameEn: string | null
  code: string
  isActive: boolean
}

export interface JobCategoryOption {
  id: string
  code: string
  name: string
  isActive: boolean
}

export interface QualificationStatusOption {
  id: string
  code: string
  name: string
  isActive: boolean
}

export interface SignatureAssetView {
  id: string
  mimeType: string
  byteSize: number
  sha256: string
  isActive: boolean
  createdAt: string
}
