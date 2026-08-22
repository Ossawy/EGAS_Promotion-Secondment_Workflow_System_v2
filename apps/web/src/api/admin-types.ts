import type { AccountType, UnitKind } from './types'

export interface AdminAccount {
  id: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  accountType: AccountType
  mustChangePassword: boolean
  isActive: boolean
  lockedUntil: string | null
  version: number
  createdAt?: string
}

export interface CreateAdminAccountInput {
  username: string
  staffIdentifier?: string | null
  displayName: string
  jobTitle?: string | null
  accountType: AccountType
  temporaryPassword: string
  isActive?: boolean
  unitId?: string | null
}

export interface UpdateAdminAccountInput {
  staffIdentifier?: string | null
  displayName: string
  jobTitle?: string | null
}

export interface AdminDashboardSummary {
  accounts: { total: number, active: number, inactive: number, locked: number }
  operationalUnits: { total: number, HR: number, ORG: number, AUTH: number }
  activeSnapshot: { id: string, snapshotYear: number, activatedAt: string | null, employeeCount: number } | null
  recentActivity: Array<{
    id: string
    eventType: string
    subjectType: string | null
    subjectId: string | null
    actorDisplayName: string | null
    details: Record<string, unknown>
    createdAt: string
  }>
  notifications: {
    unread: number
    recent: Array<{ id: string, notificationType: string, isRead: boolean, createdAt: string }>
  }
}

export interface AdminAuditEvent {
  id: string
  actorUserId: string | null
  eventType: string
  subjectType: string | null
  subjectId: string | null
  actorDisplayName: string | null
  actorUsername: string | null
  actorJobTitle: string | null
  actorUnitName: string | null
  subjectLabel: string | null
  requestNumber: string | null
  details: Record<string, unknown>
  createdAt: string
}

export interface AdminAuditQuery {
  skip?: number
  top?: number
  eventType?: string
  actor?: string
  from?: string
  to?: string
}

export interface AdminAuditPage {
  items: AdminAuditEvent[]
  total: number
  skip: number
  top: number
}

export interface OperationalUnitView {
  id: string
  kind: UnitKind
  name: string
  routingUnitId: string | null
  routingUnitCode?: string | null
  routingUnitName?: string | null
  isActive: boolean
}

export interface UnitMemberView {
  membershipId: string
  id: string
  username: string
  displayName: string
  jobTitle: string | null
  effectiveFrom: string
  managerAssignmentId: string | null
}

export interface ManagerHistoryEntry {
  id: string
  managerUserId: string
  displayName: string
  effectiveFrom: string
  effectiveTo: string | null
  replacementReason: string | null
}

export interface SubordinateMemberView {
  id: string
  username: string
  displayName: string
  jobTitle: string | null
  membershipId: string
}
