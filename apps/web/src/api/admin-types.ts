import type { Role } from './types'

export interface AdminUser {
  id: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  isLocked: boolean
  createdAt: string
  updatedAt: string
  version: number
  roles: Array<{ role: Role, canManageAdmins: boolean, isActive: boolean }>
}

export interface RoutingUnit { id: string, nameAr: string, code: string | null, isActive: boolean, unitKind: string | null }

export interface AuthorityAssignment {
  id: string
  routingUnitId: string
  userAccountId: string
  authorityKind: string
  authorityJobTitle: string
  isPrimary: boolean
  validFrom: string
  validTo: string | null
  isActive: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  version: number
}

export interface Delegation {
  id: string
  authorityAssignmentId: string
  delegatedUserId: string
  validFrom: string
  validTo: string | null
  isActive: boolean
  reason: string | null
  createdAt: string
  version: number
}

export interface RoutingAlias {
  id: string
  sourceLabel: string
  routingUnit: { id: string, nameAr: string }
  isActive: boolean
  configuredById: string | null
  configuredAt: string
  notes: string | null
}

export interface ImportBatch {
  id: string
  snapshotYear: number
  sourceFilename: string
  sourceSha256: string | null
  importedBy: { id: string, username: string, displayName: string } | null
  importedAt: string
  headerSchemaValidated: boolean
  detectedHeaders: string[]
  status: string
  totalRows: number
  validRows: number
  warningRows: number
  blockedRows: number
}

export interface AuditEvent {
  id: string
  eventType: string
  actorUserId: string | null
  actorName: string | null
  routingUnitId: string | null
  routingUnitName: string | null
  ipAddress: string | null
  correlationId: string | null
  details: Record<string, unknown>
  createdAt: string
}

export interface AdminOverview {
  accounts: { total: number, active: number, disabled: number, locked: number }
  authorityCoverage: { covered: number, total: number }
  routingCoverage: { activeAliases: number }
  activeSnapshot: { available: false } | { available: true, snapshotYear: number, employeeCount: number, importedAt: string }
  latestBatch: null | { id: string, status: string, snapshotYear: number, blockedRows: number, warningRows: number, validRows: number, importedAt: string }
  pilotReady: boolean
  recentActivity: AuditEvent[]
}
