export type Role = 'ADMIN' | 'EMPLOYEE_AFFAIRS' | 'ORGANIZATION' | 'APPROVING_AUTHORITY'

export interface RoleAssignment {
  role: Role
  canManageAdmins: boolean
}

export interface UserContext {
  userId: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  accountType?: 'ADMIN' | 'OPERATIONAL'
  operationalContext?: null | { membershipId:string; unitId:string; unitKind:'HR'|'ORG'|'AUTH'; routingUnitId:string|null; routingUnitName:string|null; isManager:boolean; managerAssignmentId:string|null }
  /** @deprecated retained only so deferred workflow components type-check. */
  activeRole?: Role | null // Keep for type-checking legacy components, but not used in logic
  /** @deprecated retained only so deferred workflow components type-check. */
  availableRoles: RoleAssignment[]
}

export interface ApiErrorPayload {
  error?: {
    code?: string
    message?: string
  }
}
