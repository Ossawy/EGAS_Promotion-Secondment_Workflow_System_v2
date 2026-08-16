import { Navigate, Outlet } from 'react-router-dom'
import type { Role } from '../api/types'
import { useAuth } from './AuthProvider'

export function RequireRole({ role }: { role: Role }): React.JSX.Element {
  const { user } = useAuth()
  return user?.activeRole === role ? <Outlet /> : <Navigate to="/" replace />
}
