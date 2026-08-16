import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export function AuthGate(): React.JSX.Element {
  const auth = useAuth()
  const location = useLocation()

  if (auth.loading) return <main className="centered"><p role="status">جارٍ تحميل الجلسة...</p></main>
  if (!auth.user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (auth.user.mustChangePassword) return <Navigate to="/change-password" replace />
  if (!auth.user.activeRole) return <Navigate to="/select-role" replace />
  return <Outlet />
}
