import type { Role } from '../../shared/roles.ts'

export type AuthContext = {
  userId: string
  username: string
  sessionId: string
  activeRole: Role | null
  roleAssignmentId: string | null
  canManageAdmins: boolean
  mustChangePassword: boolean
}

export type SafeRole = { role: Role, canManageAdmins: boolean }

export type SafeUserContext = {
  userId: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  isActive: boolean
  activeRole: Role | null
  availableRoles: SafeRole[]
}

export type IssuedSession = {
  sessionId: string
  sessionToken: string
  csrfToken: string
  absoluteExpiresAt: string
  context: SafeUserContext
}
