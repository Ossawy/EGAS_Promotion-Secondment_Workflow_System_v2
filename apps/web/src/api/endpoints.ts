import { apiJson, apiRequest } from './client'
import type {
  AdminAccount,
  AdminAuditPage,
  AdminAuditQuery,
  AdminDashboardSummary,
  CreateAdminAccountInput,
  ManagerHistoryEntry,
  OperationalUnitView,
  SubordinateMemberView,
  UnitMemberView,
  UpdateAdminAccountInput
} from './admin-types'
import type { UserContext } from './types'
import type {
  CandidateLookupPreview,
  JobCategoryOption,
  ManagerInboxResponse,
  ManagerSubordinateOption,
  NotificationSummary,
  PromotionDecisionSummary,
  PromotionDecisionType,
  QualificationStatusOption,
  RequestCandidateSummary,
  RoutingUnitOption,
  SecondmentPositionOptionSummary,
  SecondmentPreparationSummary,
  SecondmentSelectionSummary,
  SignatureAssetView,
  StageCode,
  StageExecutionSummary,
  TimelineEvent,
  WorkflowNoteSummary,
  WorkflowRequestSummary,
  WorkflowSignoffView
} from './workflow-types'

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const authApi = {
  me: (): Promise<UserContext> => apiRequest<UserContext>('/api/auth/me'),
  login: (username: string, password: string): Promise<UserContext> =>
    apiJson<UserContext>('/api/auth/login', 'POST', { username, password }),
  changePassword: (currentPassword: string, newPassword: string): Promise<UserContext> =>
    apiJson<UserContext>('/api/auth/change-password', 'POST', { currentPassword, newPassword }),
  logout: (): Promise<void> => apiJson<void>('/api/auth/logout', 'POST', {})
}

// ---------------------------------------------------------------------------
// Reference data (read-only)
// ---------------------------------------------------------------------------

export const referenceApi = {
  routingUnits: (): Promise<RoutingUnitOption[]> => apiRequest<RoutingUnitOption[]>('/api/reference/routing-units'),
  jobCategories: (): Promise<JobCategoryOption[]> => apiRequest<JobCategoryOption[]>('/api/reference/job-categories'),
  qualificationStatuses: (): Promise<QualificationStatusOption[]> =>
    apiRequest<QualificationStatusOption[]>('/api/reference/qualification-statuses')
}

// ---------------------------------------------------------------------------
// Workflow core
// ---------------------------------------------------------------------------

export interface CreateWorkflowRequestInput {
  requestType: 'PROMOTION' | 'SECONDMENT'
  routingUnitId: string
}

export const workflowApi = {
  createRequest: (input: CreateWorkflowRequestInput): Promise<WorkflowRequestSummary> =>
    apiJson<WorkflowRequestSummary>('/api/workflow/requests', 'POST', input),
  listRequests: (skip = 0, top = 50, filters:{query?:string,status?:string,requestType?:'PROMOTION'|'SECONDMENT'}={}): Promise<WorkflowRequestSummary[]> => {
    const params=new URLSearchParams({skip:String(skip),top:String(top)})
    if(filters.query?.trim())params.set('q',filters.query.trim())
    if(filters.status)params.set('status',filters.status)
    if(filters.requestType)params.set('requestType',filters.requestType)
    return apiRequest<WorkflowRequestSummary[]>(`/api/workflow/requests?${params.toString()}`)
  },
  getRequest: (requestId: string): Promise<WorkflowRequestSummary & { candidates: RequestCandidateSummary[] }> =>
    apiRequest(`/api/workflow/requests/${requestId}`),
  restartRequest: (requestId: string): Promise<WorkflowRequestSummary> =>
    apiJson(`/api/workflow/requests/${requestId}/restart`, 'POST', {}),
  cancelRequest: (requestId: string): Promise<WorkflowRequestSummary> =>
    apiJson(`/api/workflow/requests/${requestId}/cancel`, 'POST', {}),
  addCandidate: (requestId: string, personnelNumber: string): Promise<RequestCandidateSummary> =>
    apiJson(`/api/workflow/requests/${requestId}/candidates`, 'POST', { personnelNumber }),
  removeCandidate: (requestId: string, candidateId: string): Promise<{ success: boolean, candidateId: string }> =>
    apiJson(`/api/workflow/requests/${requestId}/candidates/${candidateId}`, 'DELETE', {}),
  lookupCandidate: (requestId: string, personnelNumber: string): Promise<CandidateLookupPreview> =>
    apiRequest(`/api/workflow/requests/${encodeURIComponent(requestId)}/candidate-lookup/${encodeURIComponent(personnelNumber)}`),
  getNotes: (requestId: string): Promise<WorkflowNoteSummary[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/notes?top=200`),
  addNote: (requestId: string, body: string, candidateId?: string | null): Promise<WorkflowNoteSummary> =>
    apiJson(`/api/workflow/requests/${requestId}/notes`, 'POST',
      candidateId ? { body, candidateId } : { body }),
  getTimeline: (requestId: string): Promise<TimelineEvent[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/timeline?top=300`),
  managerInbox: (): Promise<ManagerInboxResponse> => apiRequest('/api/workflow/manager/inbox'),
  managerSubordinates: (): Promise<ManagerSubordinateOption[]> => apiRequest('/api/workflow/manager/subordinates'),
  myWork: (): Promise<StageExecutionSummary[]> => apiRequest('/api/workflow/my-work'),
  assignStage: (stageExecutionId: string, assignedToUserId: string, reason?: string | null): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/assign`, 'POST',
      reason ? { assignedToUserId, reason } : { assignedToUserId }),
  takeStage: (stageExecutionId: string): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/take`, 'POST', {}),
  submitToManager: (stageExecutionId: string): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/submit-to-manager`, 'POST', {}),
  internalCorrection: (
    stageExecutionId: string,
    input: { reason: string, assignedToUserId?: string, managerHandlesPersonally?: boolean }
  ): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/internal-correction`, 'POST', input),
  returnPrevious: (stageExecutionId: string, reason: string): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/return-previous`, 'POST', { reason }),
  rejectStage: (stageExecutionId: string, reason: string): Promise<WorkflowRequestSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/reject`, 'POST', { reason }),
  approveAndAdvance: (stageExecutionId: string): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/approve-and-advance`, 'POST', {}),
  signAndAdvance: (
    stageExecutionId: string,
    input: { password: string, signatureAssetId: string, jobTitleOverride?: string }
  ): Promise<StageExecutionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/sign-and-advance`, 'POST',
      input.jobTitleOverride
        ? { password: input.password, signatureAssetId: input.signatureAssetId, jobTitleOverride: input.jobTitleOverride }
        : { password: input.password, signatureAssetId: input.signatureAssetId }),
  getSignoffs: (requestId: string): Promise<WorkflowSignoffView[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/signoffs`),
  notifications: (top = 50, unreadOnly = false): Promise<NotificationSummary[]> =>
    apiRequest(`/api/workflow/notifications?top=${top}${unreadOnly ? '&unread=true' : ''}`),
  markNotificationRead: (notificationId: string): Promise<void> =>
    apiJson(`/api/workflow/notifications/${notificationId}/read`, 'POST', {})
}

// ---------------------------------------------------------------------------
// Promotion domain
// ---------------------------------------------------------------------------

export const promotionApi = {
  decisions: (requestId: string): Promise<PromotionDecisionSummary[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/promotion/decisions`),
  saveDecision: (
    stageExecutionId: string,
    candidateId: string,
    input: {
      decisionType: PromotionDecisionType
      targetJobTitle?: string | null
      recommendation: string
      notes?: string | null
    }
  ): Promise<PromotionDecisionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/promotion/candidates/${candidateId}/decision`, 'PUT', input)
}

// ---------------------------------------------------------------------------
// Secondment domain
// ---------------------------------------------------------------------------

export const secondmentApi = {
  options: (requestId: string): Promise<SecondmentPositionOptionSummary[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/secondment/options`),
  selections: (requestId: string): Promise<SecondmentSelectionSummary[]> =>
    apiRequest(`/api/workflow/requests/${requestId}/secondment/selections`),
  savePreparation: (
    stageExecutionId: string,
    candidateId: string,
    input: { lastPromotionReport: string, jobCategoryCode: string }
  ): Promise<SecondmentPreparationSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/secondment/candidates/${candidateId}/preparation`, 'PUT', input),
  addOption: (
    stageExecutionId: string,
    candidateId: string,
    input: { positionTitle: string, organizationalDependency: string, qualificationStatus: string }
  ): Promise<SecondmentPositionOptionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/secondment/candidates/${candidateId}/options`, 'POST', input),
  updateOption: (
    stageExecutionId: string,
    optionId: string,
    input: { positionTitle: string, organizationalDependency: string, qualificationStatus: string }
  ): Promise<SecondmentPositionOptionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/secondment/options/${optionId}`, 'PUT', input),
  removeOption: (stageExecutionId: string, optionId: string): Promise<void> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/secondment/options/${optionId}`, 'DELETE', {}),
  saveSelection: (stageExecutionId: string, candidateId: string, selectedOptionId: string): Promise<SecondmentSelectionSummary> =>
    apiJson(`/api/workflow/stages/${stageExecutionId}/secondment/candidates/${candidateId}/selection`, 'PUT', { selectedOptionId })
}

// ---------------------------------------------------------------------------
// Signature assets
// ---------------------------------------------------------------------------

export const signatureApi = {
  mySignatures: (): Promise<SignatureAssetView[]> => apiRequest('/api/signatures/my-signatures'),
  upload: (file: File): Promise<SignatureAssetView> =>
    apiRequest('/api/signatures/my-signature', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file
    }),
  deactivate: (assetId: string): Promise<unknown> =>
    apiJson(`/api/signatures/${assetId}/deactivate`, 'POST', {}),
  imageUrl: (assetId: string, requestId?: string | null): string =>
    `/api/signatures/${assetId}/image${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ''}`
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function documentUrl(requestId: string, kind: 'current' | 'final' | 'audit'): string {
  return `/api/documents/requests/${encodeURIComponent(requestId)}/${kind}.pdf`
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminApi = {
  dashboard: (): Promise<AdminDashboardSummary> => apiRequest('/api/admin/dashboard'),
  audit: (query: AdminAuditQuery = {}): Promise<AdminAuditPage> => {
    const params = new URLSearchParams({ skip: String(query.skip ?? 0), top: String(query.top ?? 25) })
    for (const [key, value] of Object.entries(query)) if (key !== 'skip' && key !== 'top' && value) params.set(key, String(value))
    return apiRequest(`/api/admin/audit?${params.toString()}`)
  },
  accounts: (): Promise<AdminAccount[]> => apiRequest('/api/admin/accounts'),
  account: (id: string): Promise<AdminAccount> => apiRequest(`/api/admin/accounts/${id}`),
  createAccount: (input: CreateAdminAccountInput): Promise<AdminAccount> =>
    apiJson('/api/admin/accounts', 'POST', input),
  updateAccount: (id: string, input: UpdateAdminAccountInput): Promise<AdminAccount> =>
    apiJson(`/api/admin/accounts/${id}`, 'PATCH', input),
  enableAccount: (id: string): Promise<AdminAccount> => apiJson(`/api/admin/accounts/${id}/enable`, 'POST', {}),
  disableAccount: (id: string): Promise<AdminAccount> => apiJson(`/api/admin/accounts/${id}/disable`, 'POST', {}),
  unlockAccount: (id: string): Promise<AdminAccount> => apiJson(`/api/admin/accounts/${id}/unlock`, 'POST', {}),
  resetTemporaryPassword: (id: string, temporaryPassword: string): Promise<AdminAccount> =>
    apiJson(`/api/admin/accounts/${id}/reset-temporary-password`, 'POST', { temporaryPassword }),
  units: (): Promise<OperationalUnitView[]> => apiRequest('/api/admin/operational-units'),
  createUnit: (input: { kind: 'HR' | 'ORG' | 'AUTH', name: string, routingUnitId?: string | null }): Promise<OperationalUnitView> =>
    apiJson('/api/admin/operational-units', 'POST', input),
  unit: (unitId: string): Promise<OperationalUnitView> => apiRequest(`/api/admin/operational-units/${unitId}`),
  unitMembers: (unitId: string): Promise<UnitMemberView[]> => apiRequest(`/api/admin/operational-units/${unitId}/members`),
  transferMembership: (unitId: string, userId: string): Promise<{ membershipId: string }> =>
    apiJson(`/api/admin/operational-units/${unitId}/memberships`, 'POST', { userId }),
  replaceManager: (unitId: string, managerUserId: string, replacementReason: string | null): Promise<{ managerAssignmentId: string }> =>
    apiJson(`/api/admin/operational-units/${unitId}/manager-assignments`, 'POST',
      replacementReason ? { managerUserId, replacementReason } : { managerUserId }),
  managerHistory: (unitId: string): Promise<ManagerHistoryEntry[]> =>
    apiRequest(`/api/admin/operational-units/${unitId}/manager-history`),
  subordinates: (unitId: string): Promise<SubordinateMemberView[]> =>
    apiRequest(`/api/admin/operational-units/${unitId}/subordinates`)
}

// Re-exported for consumers that need the raw transport.
export { apiJson, apiRequest } from './client'
export type { StageCode }
