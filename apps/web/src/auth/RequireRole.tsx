import { Navigate, Outlet } from 'react-router-dom'
import type { Role } from '../api/types'
import { useAuth } from './AuthProvider'

export function RequireRole({ role }: { role: Role }): React.JSX.Element {
  const { user } = useAuth()
  const isEmployeeAffairs = user?.operationalContext?.unitKind === 'HR'
  const isOrganization = user?.operationalContext?.unitKind === 'ORG'
  const isApprovingAuthority = user?.operationalContext?.isManager && user?.operationalContext?.unitKind === 'AUTH'
  const isAdmin = user?.accountType === 'ADMIN'

  const hasRole = (r: Role) => {
    if (r === 'ADMIN') return isAdmin
    if (r === 'EMPLOYEE_AFFAIRS') return isEmployeeAffairs
    if (r === 'ORGANIZATION') return isOrganization
    if (r === 'APPROVING_AUTHORITY') return isApprovingAuthority
    return false
  }

  return hasRole(role) ? <Outlet /> : <Navigate to="/" replace />
}
