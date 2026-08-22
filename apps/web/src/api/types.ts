export type AccountType = 'ADMIN' | 'OPERATIONAL'
export type UnitKind = 'HR' | 'ORG' | 'AUTH'

export interface OperationalContext {
  membershipId: string
  unitId: string
  unitKind: UnitKind
  routingUnitId: string | null
  routingUnitName: string | null
  isManager: boolean
  managerAssignmentId: string | null
}

export interface UserContext {
  userId: string
  username: string
  staffIdentifier: string | null
  displayName: string
  jobTitle: string | null
  accountType: AccountType
  mustChangePassword: boolean
  operationalContext: OperationalContext | null
}

export interface ApiErrorPayload {
  error?: { code?: string, message?: string }
}

export const UNIT_KIND_LABELS: Record<UnitKind, string> = {
  HR: 'الموارد البشرية',
  ORG: 'التنظيم',
  AUTH: 'السلطة المختصة'
}
