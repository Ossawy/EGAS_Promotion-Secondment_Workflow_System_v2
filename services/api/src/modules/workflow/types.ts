import type { Role } from '../../shared/roles.ts'

export const WORKFLOW_TYPES = ['PROMOTION','SECONDMENT'] as const
export type WorkflowType = typeof WORKFLOW_TYPES[number]
export type WorkflowStage = 'P1'|'P2'|'P3'|'P4'|'P5'|'S1'|'S2'|'S3'|'S4'|'S5'

export interface WorkflowActor {
  userId: string
  username: string
  activeRole: Role
}

export interface RequestRow {
  id: string
  requestNumber: string
  requestType: WorkflowType
  cycleYear: number
  formMonth: number
  formYear: number
  routingUnitId: string | null
  routingUnitName: string | null
  authorityAssignmentId: string | null
  authorityPersonnel: string | null
  authorityName: string | null
  authorityJobTitle: string | null
  authorityKind: string | null
  createdById: string
  creatorUsername: string
  creatorDisplayName: string
  status: string
  currentStage: WorkflowStage
  currentIterationNo: number
  createdAt: Date | string
  updatedAt: Date | string
  version: number
  candidateCount: number
}

export interface CandidateRow {
  id: string
  snapshotId: string
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
  formSectionId: string | null
  jobCategoryCode: string | null
  jobCategoryName: string | null
  lastPromotionReport: string | null
  displayOrder: number
  createdAt: Date | string
}

export function initialStage(type: WorkflowType): WorkflowStage {
  return type === 'PROMOTION' ? 'P1' : 'S1'
}

export function responsibleRole(stage: WorkflowStage): Exclude<Role, 'ADMIN'> {
  if (stage === 'P2' || stage === 'S2' || stage === 'S4') return 'ORGANIZATION'
  if (stage === 'P4' || stage === 'S3') return 'APPROVING_AUTHORITY'
  return 'EMPLOYEE_AFFAIRS'
}

export function isOrganizationStage(stage: string): stage is 'P2'|'S2'|'S4' {
  return stage === 'P2' || stage === 'S2' || stage === 'S4'
}
