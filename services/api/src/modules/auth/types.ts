export type AuthContext = {
  userId: string
  username: string
  sessionId: string
  accountType?: 'ADMIN' | 'OPERATIONAL'
  mustChangePassword: boolean
  /** @deprecated v4 tests only; v5 sessions never populate this field. */
  activeRole?: import('../../shared/roles.ts').Role | null | undefined
  /** @deprecated v4 tests only; v5 sessions never populate this field. */
  canManageAdmins?: boolean | undefined
  roleAssignmentId?: string | null | undefined
}

export type SafeUserContext = {
  userId: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  mustChangePassword: boolean
  accountType: 'ADMIN' | 'OPERATIONAL'
  operationalContext: null | { membershipId: string, unitId: string, unitKind: 'HR' | 'ORG' | 'AUTH', routingUnitId: string | null, routingUnitName: string | null, isManager: boolean, managerAssignmentId: string | null }
  /** @deprecated v4 tests only; v5 responses never return this field. */
  activeRole?: import('../../shared/roles.ts').Role | null
  /** @deprecated v4 tests only; v5 responses never return this field. */
  availableRoles?: Array<{ role: import('../../shared/roles.ts').Role, canManageAdmins: boolean }>
}

export type IssuedSession = {
  sessionId: string
  sessionToken: string
  csrfToken: string
  absoluteExpiresAt: string
  context: SafeUserContext
}
