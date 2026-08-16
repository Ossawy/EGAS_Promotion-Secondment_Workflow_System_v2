export interface WorkflowRequestSummary {
  id: string
  requestNumber: string
  requestType: 'PROMOTION' | 'SECONDMENT'
  cycleYear: number
  status: string
  currentStage: string
  routingUnit: { id: string, nameAr: string } | null
  candidateCount: number
  updatedAt: string
  editable: boolean
  actionable: boolean
}

export interface EmployeeSnapshotView {
  snapshotYear: number
  personnelNumber: string
  employeeName: string
  subgroup: string | null
  sourceRoutingUnit: string | null
  routingUnit: { id: string, nameAr: string }
  currentJobTitle: string | null
  performanceRating: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
  warnings: { performanceRequiresAttention: boolean, performanceMissing: boolean }
}

export interface RequestCandidate {
  id: string
  snapshotYear: number
  personnelNumber: string
  employeeName: string
  subgroup: string | null
  sourceRoutingUnit: string | null
  routingUnitName: string
  currentJobTitle: string | null
  performanceRating: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
  formSection: { id: string, jobCategoryCode: string, nameAr: string } | null
  lastPromotionReport: string | null
  displayOrder: number
  createdAt: string
  warnings: { performanceRequiresAttention: boolean, performanceMissing: boolean }
}

export interface AuthorityOption {
  id: string
  displayName: string
  staffIdentifier: string | null
  authorityKind: string
  authorityJobTitle: string
  preferred: boolean
}

export interface WorkflowRequestDetail extends WorkflowRequestSummary {
  formMonth: number
  formYear: number
  currentIterationNo: number
  approvingAuthority: {
    assignmentId: string
    personnelNumber: string | null
    displayName: string
    jobTitle: string
    kind: string
  } | null
  createdBy: { id: string, username: string, displayName: string }
  createdAt: string
  version: number
  candidates: RequestCandidate[]
}

export interface WorkflowNote {
  id: string
  iterationNo: number
  stageCode: string | null
  candidateId: string | null
  scope: 'REQUEST' | 'CANDIDATE'
  authorUserId: string
  authorName: string
  authorRole: string
  message: string
  createdAt: string
}

export interface TimelineEntry {
  id: string
  kind: 'ACTION' | 'NOTE'
  code: string
  candidateId: string | null
  actorUserId: string
  actorName: string
  actorRole: string
  stageCode: string | null
  message: string | null
  createdAt: string
}

export interface SecondmentPosition {
  id: string
  candidateId: string
  iterationId: string
  positionTitle: string
  organizationalDependency: string
  qualificationStatus: 'QUALIFIED' | 'NOT_QUALIFIED'
  enteredById: string
  enteredByName: string
  displayOrder: number
  isSelected: boolean
  selectedById: string | null
  selectedAt: string | null
  createdAt: string
  version: number
}

export interface PromotionDecision {
  id: string
  candidateId: string
  iterationId: string
  decisionType: 'SAME_POSITION' | 'OTHER_POSITION'
  targetJobTitle: string | null
  notes: string | null
  decidedById: string
  decidedByName: string
  decidedAt: string
}

export interface QueueItem {
  taskId: string
  requestId: string
  requestNumber: string
  requestType: 'PROMOTION' | 'SECONDMENT'
  cycleYear: number
  stageCode: string
  taskStatus: string
  routingUnitName: string | null
  candidateCount: number
  openedAt: string
  claimable?: boolean
  claimedByMe?: boolean
  claimantName?: string | null
  actionable?: boolean
}

export interface NotificationItem {
  id: string
  requestId: string | null
  type: string
  titleAr: string
  bodyAr: string | null
  createdAt: string
  readAt: string | null
  isRead: boolean
}

export interface SignatureAsset {
  id: string
  mimeType: 'image/png'
  fileSizeBytes: number
  widthPx: number
  heightPx: number
  fileSha256: string
  uploadedAt: string
}

export interface WorkflowSignoff {
  id: string
  stageCode: string
  iterationNo: number
  signerUserId: string
  signerRole: string
  signerName: string
  signerJobTitle: string
  jobTitleWasOverridden: boolean
  signatureAssetId: string
  signatureSha256: string
  signedAt: string
}

export interface RequestDocuments {
  received: Array<{
    snapshotId: string
    taskId: string
    stageCode: string
    iterationNo: number
    receivedAt: string
    snapshotSha256: string
  }>
  finalAvailable: boolean
}

export interface WorkflowHistoryItem {
  id: string
  requestNumber: string
  requestType: 'PROMOTION' | 'SECONDMENT'
  cycleYear: number
  status: string
  currentStage: string
  currentIterationNo: number
  routingUnit: { id: string, nameAr: string } | null
  candidateCount: number
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface ActiveSnapshot {
  snapshotYear: number
  importedAt: string
  employeeCount: number
}
