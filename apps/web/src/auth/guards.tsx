import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

/**
 * Presentation-level guards only. The backend remains the authorization
 * boundary; these components just route users to the right workspace.
 */

export function RequireAdmin(): React.JSX.Element {
  const auth = useAuth()
  const location = useLocation()
  if (auth.user?.accountType !== 'ADMIN') return <Navigate to="/" replace state={{ from: location.pathname }} />
  return <Outlet />
}

export function RequireOperational(): React.JSX.Element | null {
  const auth = useAuth()
  if (auth.user?.accountType !== 'OPERATIONAL' || !auth.user.operationalContext) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}

/** Operational user who currently manages their unit (manager inbox / assignment UI). */
export function RequireOperationalManager(): React.JSX.Element | null {
  const auth = useAuth()
  const context = auth.user?.operationalContext
  if (auth.user?.accountType !== 'OPERATIONAL' || !context || !context.isManager) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}

/** Any active operational member of the HR unit may prepare a new request. */
export function RequireHrOperational(): React.JSX.Element | null {
  const auth = useAuth()
  const context = auth.user?.operationalContext
  if (
    auth.user?.accountType !== 'OPERATIONAL'
    || !context
    || context.unitKind !== 'HR'
  ) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}

/** @deprecated use RequireHrOperational for request creation. */
export const RequireHrManager = RequireHrOperational
