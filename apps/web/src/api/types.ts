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
  activeRole: Role | null
  availableRoles: RoleAssignment[]
}

export interface ApiErrorPayload {
  error?: {
    code?: string
    message?: string
  }
}
